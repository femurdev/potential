"""
Improved Docker runner wrapper for sandboxed compilation.

Behavior:
- Uses `docker create` to create a container from the given image, mounts input-dir into /workspace
- Starts the container, waits up to `--timeout` seconds for it to finish (via `docker wait`)
- If timeout reached, kills and removes the container
- Always collects `docker logs` stdout/stderr and returns a JSON object read from /workspace/output.json (if present)
- Adds optional seccomp support via SANDBOX_SECCOMP env var or --seccomp argument

Usage:
  python3 docker_runner.py --input-dir /tmp/work --image graph-compiler-sandbox --timeout 15

Output: JSON string printed to stdout
"""
import argparse
import subprocess
import json
import os
import sys
import tempfile
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--input-dir', required=True)
parser.add_argument('--image', required=True)
parser.add_argument('--timeout', type=int, default=15)
parser.add_argument('--memory', default=os.environ.get('SANDBOX_MEMORY', '256m'))
parser.add_argument('--cpus', default=os.environ.get('SANDBOX_CPUS', '0.5'))
parser.add_argument('--pids-limit', type=int, default=int(os.environ.get('SANDBOX_PIDS_LIMIT', '64')))
parser.add_argument('--seccomp', default=os.environ.get('SANDBOX_SECCOMP'))
args = parser.parse_args()

input_dir = os.path.abspath(args.input_dir)
image = args.image
timeout = args.timeout

# Build docker create command with safer defaults
create_cmd = [
    'docker', 'create',
    '--network', 'none',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--pids-limit', str(args.pids_limit),
    '--memory', args.memory,
    '--cpus', args.cpus,
    # mount workspace as a writable bind even with read-only rootfs
    '-v', f'{input_dir}:/workspace:rw',
    # provide a small tmpfs for /tmp inside the container
    '--tmpfs', '/tmp:rw',
]
if args.seccomp:
    create_cmd += ['--security-opt', f'seccomp={args.seccomp}']
create_cmd.append(image)

# Create container
try:
    proc = subprocess.run(create_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10)
except subprocess.TimeoutExpired:
    print(json.dumps({ 'success': False, 'error': 'create_timeout', 'message': 'docker create timed out' }))
    sys.exit(0)

if proc.returncode != 0:
    print(json.dumps({ 'success': False, 'error': 'create_failed', 'message': proc.stderr or proc.stdout }))
    sys.exit(0)

container_id = proc.stdout.strip()
if not container_id:
    print(json.dumps({ 'success': False, 'error': 'no_container_id', 'message': 'docker create did not return a container id' }))
    sys.exit(0)

# Start container
start_cmd = ['docker', 'start', container_id]
proc = subprocess.run(start_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
if proc.returncode != 0:
    # try to remove container
    subprocess.run(['docker', 'rm', '-f', container_id], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    print(json.dumps({ 'success': False, 'error': 'start_failed', 'message': proc.stderr or proc.stdout }))
    sys.exit(0)

# Wait for container with docker wait and timeout handling
finished = False
exit_code = None
start_time = time.time()
try:
    wait_proc = subprocess.Popen(['docker', 'wait', container_id], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        out, err = wait_proc.communicate(timeout=timeout)
        if wait_proc.returncode == 0:
            exit_code = int(out.strip()) if out and out.strip().isdigit() else 0
            finished = True
    except subprocess.TimeoutExpired:
        # Timeout: kill the container
        subprocess.run(['docker', 'kill', container_id], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        # ensure wait_proc finishes
        try:
            out, err = wait_proc.communicate(timeout=5)
        except Exception:
            pass
        finished = False
except Exception:
    # As a fallback, poll container status
    while time.time() - start_time < timeout:
        ps = subprocess.run(['docker', 'inspect', '-f', '{{.State.Status}}', container_id], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        status = ps.stdout.strip()
        if status in ('exited', 'dead'):
            # get exit code
            rc = subprocess.run(['docker', 'inspect', '-f', '{{.State.ExitCode}}', container_id], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                exit_code = int(rc.stdout.strip())
            except Exception:
                exit_code = 0
            finished = True
            break
        time.sleep(0.2)
    if not finished:
        subprocess.run(['docker', 'kill', container_id], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        finished = False

# Collect logs regardless
logs_proc = subprocess.run(['docker', 'logs', container_id], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
container_stdout = logs_proc.stdout
container_stderr = logs_proc.stderr

# Attempt to read output.json from input_dir
out_path = os.path.join(input_dir, 'output.json')
result = None
if os.path.exists(out_path):
    try:
        result = json.load(open(out_path))
    except Exception as e:
        result = { 'success': False, 'error': 'bad_output', 'message': 'Failed to parse output.json', 'exception': str(e), '_container_stdout': container_stdout, '_container_stderr': container_stderr }
else:
    result = { 'success': False, 'error': 'no_output', 'message': 'Container did not produce output.json', '_container_stdout': container_stdout, '_container_stderr': container_stderr }

# Cleanup container
subprocess.run(['docker', 'rm', '-f', container_id], stdout=subprocess.PIPE, stderr=subprocess.PIPE)

# Attach metadata
if isinstance(result, dict):
    result.setdefault('_container_stdout', container_stdout)
    result.setdefault('_container_stderr', container_stderr)
    result.setdefault('_finished', finished)
    result.setdefault('_exit_code', exit_code)

print(json.dumps(result))
