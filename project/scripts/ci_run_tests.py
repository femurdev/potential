"""
CI integration test runner.

Builds on the repository structure and uses the docker_runner wrapper to run the sandbox image
against a set of example IRs and checks their stdout contains expected substrings.

Also runs a small set of sandbox security smoke tests (C programs) by running the sandbox image
with restricted flags and asserting the runtime blocks forbidden syscalls and honors timeouts.

Usage: python3 project/scripts/ci_run_tests.py

Exits with non-zero on failure.
"""
import json
import os
import subprocess
import sys
import tempfile
import shutil
import uuid
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES_DIR = ROOT / 'examples'
DOCKER_RUNNER = ROOT / 'scripts' / 'docker_runner.py'
SANDBOX_IMAGE = os.environ.get('SANDBOX_IMAGE', 'graph-compiler-sandbox')

TESTS = [
    {
        'file': EXAMPLES_DIR / 'sum_ir.json',
        'expect_substr': '7'
    },
    {
        'file': EXAMPLES_DIR / 'sin_ir.json',
        'expect_substr': '0.479426'
    },
    {
        'file': EXAMPLES_DIR / 'function_simple.json',
        'expect_substr': '11'
    }
]

# Security C tests (compiled & run inside sandbox image)
SECURITY_TESTS_DIR = ROOT / 'tests' / 'sandbox_security'
SECURITY_TESTS = [
    {
        'name': 'forbidden_syscall',
        'source': SECURITY_TESTS_DIR / 'forbidden_syscall.c',
        'expect_blocked_prefix': 'FORBIDDEN_BLOCKED'
    },
    {
        'name': 'long_sleep',
        'source': SECURITY_TESTS_DIR / 'long_sleep.c',
        'expect_timeout': True
    }
]

if not DOCKER_RUNNER.exists():
    print('docker_runner.py not found at', DOCKER_RUNNER)
    # not fatal here; warnings will be emitted when attempting to use it

node_defs_path = ROOT / 'compiler' / 'node_defs.json'
node_defs = json.load(open(node_defs_path)) if node_defs_path.exists() else {}

any_failure = False
artifacts_root = Path('ci_artifacts')
artifacts_root.mkdir(exist_ok=True)

# First: run functional example tests via docker_runner (if available)
for t in TESTS:
    print('Testing', t['file'])
    ir = json.load(open(t['file']))
    tmpdir = tempfile.mkdtemp(prefix='ci_test_')
    try:
        input_path = Path(tmpdir) / 'input.json'
        payload = { 'ir': ir, 'node_defs': node_defs, 'timeout': 5 }
        with open(input_path, 'w') as f:
            json.dump(payload, f)

        cmd = [sys.executable, str(DOCKER_RUNNER), '--input-dir', tmpdir, '--image', SANDBOX_IMAGE, '--timeout', '20']
        print('Running:', ' '.join(cmd))
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if proc.returncode != 0:
            print('docker_runner failed:', proc.stdout, proc.stderr)
            # save outputs
            p = artifacts_root / f"functional_{Path(t['file']).stem}"
            p.mkdir(parents=True, exist_ok=True)
            (p / 'docker_runner.stdout.txt').write_text(proc.stdout)
            (p / 'docker_runner.stderr.txt').write_text(proc.stderr)
            any_failure = True
            continue
        try:
            out = json.loads(proc.stdout)
        except Exception as e:
            print('Failed to parse docker_runner output as JSON')
            print('stdout:', proc.stdout)
            print('stderr:', proc.stderr)
            p = artifacts_root / f"functional_{Path(t['file']).stem}"
            p.mkdir(parents=True, exist_ok=True)
            (p / 'runner_raw_stdout.txt').write_text(proc.stdout)
            (p / 'runner_raw_stderr.txt').write_text(proc.stderr)
            any_failure = True
            continue

        if not out.get('success'):
            print('Container reported failure:', out)
            p = artifacts_root / f"functional_{Path(t['file']).stem}"
            p.mkdir(parents=True, exist_ok=True)
            (p / 'container_output.json').write_text(json.dumps(out, indent=2))
            any_failure = True
            continue

        # The container's output JSON may contain stdout field
        stdout = out.get('stdout') or out.get('_container_stdout') or ''
        if t['expect_substr'] not in stdout:
            print('Unexpected output for', t['file'])
            print('Expected substring:', t['expect_substr'])
            print('Actual stdout:', stdout)
            p = artifacts_root / f"functional_{Path(t['file']).stem}"
            p.mkdir(parents=True, exist_ok=True)
            (p / 'container_output.json').write_text(json.dumps(out, indent=2))
            any_failure = True
            continue

        print('Test passed for', t['file'])
    finally:
        try:
            shutil.rmtree(tmpdir)
        except Exception:
            pass

# Second: run security smoke tests by invoking docker run with similar flags
# We'll create a container name per-test so we can inspect and collect logs

def run_security_test(test, image, timeout_sec=10):
    name = f"ci_sec_{test['name']}_{uuid.uuid4().hex[:8]}"
    workspace = tempfile.mkdtemp(prefix=f"sec_{test['name']}_")
    try:
        # copy source into workspace
        shutil.copy(test['source'], workspace)
        src_name = os.path.basename(str(test['source']))
        # build the compile/run command to execute inside container
        # compile with gcc and run the produced binary
        inner_cmd = f"gcc /workspace/{src_name} -o /workspace/test_bin && /workspace/test_bin"
        # build docker run flags mirroring docker_runner defaults
        run_cmd = [
            'docker', 'run', '--name', name,
            '--network', 'none',
            '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges',
            '--read-only',
            '--pids-limit', os.environ.get('SANDBOX_PIDS_LIMIT', '64'),
            '--memory', os.environ.get('SANDBOX_MEMORY', '256m'),
            '--cpus', os.environ.get('SANDBOX_CPUS', '0.5'),
            '-v', f"{workspace}:/workspace:rw",
            '--tmpfs', '/tmp:rw',
            image,
            'bash', '-c', inner_cmd
        ]
        print('Running security test:', ' '.join(run_cmd))
        proc = subprocess.run(run_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout_sec)
        stdout = proc.stdout
        stderr = proc.stderr
        rc = proc.returncode
        # collect docker inspect for HostConfig
        inspect_proc = subprocess.run(['docker', 'inspect', name, '--format', '{{json .HostConfig}}'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        inspect_json = inspect_proc.stdout if inspect_proc.returncode == 0 else ''
        return {'rc': rc, 'stdout': stdout, 'stderr': stderr, 'inspect': inspect_json, 'name': name, 'workspace': workspace}
    except subprocess.TimeoutExpired:
        # kill and collect logs
        try:
            subprocess.run(['docker', 'kill', name], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except Exception:
            pass
        logs = subprocess.run(['docker', 'logs', name], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        inspect_proc = subprocess.run(['docker', 'inspect', name, '--format', '{{json .HostConfig}}'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        inspect_json = inspect_proc.stdout if inspect_proc.returncode == 0 else ''
        return {'rc': None, 'stdout': logs.stdout, 'stderr': logs.stderr, 'inspect': inspect_json, 'name': name, 'workspace': workspace, 'timed_out': True}
    finally:
        # attempt to copy logs and then remove container
        try:
            logs = subprocess.run(['docker', 'logs', name], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            (Path(workspace) / 'container_stdout.log').write_text(logs.stdout)
            (Path(workspace) / 'container_stderr.log').write_text(logs.stderr)
        except Exception:
            pass
        try:
            subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except Exception:
            pass


for test in SECURITY_TESTS:
    print('\nRunning security test:', test['name'])
    res = run_security_test(test, SANDBOX_IMAGE, timeout_sec=12)
    p = artifacts_root / f"security_{test['name']}"
    p.mkdir(parents=True, exist_ok=True)
    # save workspace files
    try:
        for f in Path(res['workspace']).iterdir():
            if f.is_file():
                shutil.copy(f, p / f.name)
    except Exception:
        pass
    # write runner outputs
    (p / 'result.json').write_text(json.dumps(res, indent=2))

    # analyze result
    timed_out = res.get('timed_out', False)
    inspect_json = res.get('inspect', '')
    # basic assertion: HostConfig should include CapDrop and securityOpt
    hostcfg_ok = False
    try:
        if inspect_json:
            hostcfg = json.loads(inspect_json)
            capdrop = hostcfg.get('CapDrop', [])
            secopt = hostcfg.get('SecurityOpt', [])
            if 'ALL' in capdrop and any('no-new-privileges' in s for s in secopt):
                hostcfg_ok = True
    except Exception:
        hostcfg_ok = False

    if not hostcfg_ok:
        print(f"Security test {test['name']}: host config missing expected hardening flags")
        any_failure = True
        continue

    if test.get('expect_blocked_prefix'):
        stdout = res.get('stdout', '') or ''
        if not stdout.strip().startswith(test['expect_blocked_prefix']):
            print(f"Security test {test['name']} failed: syscall appears allowed; stdout=", stdout)
            any_failure = True
            continue
        else:
            print(f"Security test {test['name']} passed (syscall blocked)")
    elif test.get('expect_timeout'):
        if res.get('timed_out') or res.get('rc') is None:
            print(f"Security test {test['name']} passed (timed out as expected)")
        else:
            print(f"Security test {test['name']} failed: expected timeout but rc={res.get('rc')}, stdout={res.get('stdout')}")
            any_failure = True
            continue
    else:
        print(f"Security test {test['name']} unrecognized expectations; raw result saved to {p}")

    # cleanup workspace
    try:
        shutil.rmtree(res['workspace'])
    except Exception:
        pass

if any_failure:
    print('\nOne or more tests failed')
    print('Artifacts are available in', artifacts_root.resolve())
    sys.exit(1)
print('\nAll tests passed')
sys.exit(0)
