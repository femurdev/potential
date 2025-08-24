#!/usr/bin/env python3
"""
Secure compile service that runs the emitter and compiles inside a short-lived Docker sandbox.

POST /compile
  JSON body: { "ir": {...}, "node_defs": {...}, "timeout": <seconds (optional)> }

Response: JSON from container output.json or error message.

Notes:
- This service requires Docker installed on the host and the sandbox image built (see docker/sandbox/Dockerfile).
- The image name expected: graph-compiler-sandbox
- Docker is invoked via project/scripts/docker_runner.py which enforces resource limits and disables network.

Behavior change: For safety, the in-process (unsafe) fallback is disabled by default. To enable it for local development set environment variable DEV_ALLOW_FALLBACK=1.
If a DEV_FALLBACK_TOKEN is configured, requests must include header X-DEV-FALLBACK-TOKEN with that value to use the fallback. Additionally, fallback is only permitted from localhost unless a token is used.
"""
import json
import os
import tempfile
import shutil
import subprocess
from pathlib import Path
from flask import Flask, request, jsonify

# Local modules
import sys
sys.path.append(str(Path(__file__).resolve().parents[1] / 'compiler'))
from cpp_emitter import CppEmitter
from validator import topological_sort, validate_types, ValidationError

app = Flask(__name__)

SANDBOX_IMAGE = os.environ.get('SANDBOX_IMAGE', 'graph-compiler-sandbox')
DOCKER_TIMEOUT = int(os.environ.get('DOCKER_TIMEOUT', '15'))
DOCKER_RUNNER = Path(__file__).resolve().parents[0] / 'docker_runner.py'
DEV_ALLOW_FALLBACK = os.environ.get('DEV_ALLOW_FALLBACK', '0') == '1'
DEV_FALLBACK_TOKEN = os.environ.get('DEV_FALLBACK_TOKEN')
ALLOWED_INCLUDES_PATH = Path(__file__).resolve().parents[1] / 'compiler' / 'allowed_includes.json'

# Startup-time guard for unsafe in-process fallback
# If DEV_ALLOW_FALLBACK is set, require either a DEV_FALLBACK_TOKEN or an explicit DEV_FALLBACK_FORCE=1
# This prevents accidental enabling of in-process compilation on public hosts.
if DEV_ALLOW_FALLBACK:
    _fallback_force = os.environ.get('DEV_FALLBACK_FORCE', '0') == '1'
    if not DEV_FALLBACK_TOKEN and not _fallback_force:
        print("ERROR: DEV_ALLOW_FALLBACK=1 is set but no DEV_FALLBACK_TOKEN configured and DEV_FALLBACK_FORCE!=1.", file=sys.stderr)
        print("For safety, the service will not start with in-process fallback enabled.
", file=sys.stderr)
        print("To enable for local development: set DEV_ALLOW_FALLBACK=1 and set DEV_FALLBACK_TOKEN to a strong value, or set DEV_FALLBACK_FORCE=1 to acknowledge the risk.", file=sys.stderr)
        sys.exit(1)
    else:
        print(f"WARNING: DEV in-process fallback is enabled. Token present: {bool(DEV_FALLBACK_TOKEN)}; force={_fallback_force}. In-process fallback is gated and should NOT be used in production.", file=sys.stderr)
DEFAULT_NODE_DEFS = Path(__file__).resolve().parents[1] / 'compiler' / 'node_defs.json'

# load allowlist once
try:
    if ALLOWED_INCLUDES_PATH.exists():
        _ALLOWED_INCLUDES = set(json.load(open(ALLOWED_INCLUDES_PATH)))
    else:
        _ALLOWED_INCLUDES = set()
except Exception:
    _ALLOWED_INCLUDES = set()


def _collect_includes_from_ir(ir: dict, node_defs: dict) -> set:
    includes = set()
    for inc in ir.get('imports', []) or []:
        includes.add(inc)
    # nodes
    for n in ir.get('nodes', []) or []:
        ntype = n.get('type')
        ddef = (node_defs or {}).get(ntype)
        if not ddef:
            # try to load from default node_defs file
            try:
                default_defs = json.load(open(DEFAULT_NODE_DEFS))
                ddef = default_defs.get(ntype)
            except Exception:
                ddef = None
        if ddef:
            lib = ddef.get('lib')
            if lib:
                inc = lib.get('include')
                if inc:
                    includes.add(inc)
    # functions: inspect their graphs recursively
    for f in ir.get('functions', []) or []:
        g = f.get('graph', {})
        for n in g.get('nodes', []) or []:
            ntype = n.get('type')
            ddef = (node_defs or {}).get(ntype)
            if not ddef:
                try:
                    default_defs = json.load(open(DEFAULT_NODE_DEFS))
                    ddef = default_defs.get(ntype)
                except Exception:
                    ddef = None
            if ddef:
                lib = ddef.get('lib')
                if lib:
                    inc = lib.get('include')
                    if inc:
                        includes.add(inc)
    return includes


def run_with_docker_runner(input_dir: str, timeout: int = 15) -> dict:
    """Run the docker_runner wrapper script which handles docker invocation with strict flags.
    Returns parsed JSON output from docker_runner.
    """
    cmd = [sys.executable, str(DOCKER_RUNNER), '--input-dir', input_dir, '--image', SANDBOX_IMAGE, '--timeout', str(timeout)]
    # allow operator to pass seccomp profile via env
    seccomp = os.environ.get('SANDBOX_SECCOMP')
    if seccomp:
        cmd += ['--seccomp', seccomp]
    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout+5)
    except subprocess.TimeoutExpired:
        return { 'success': False, 'error': 'runner_timeout', 'message': 'docker_runner timed out' }
    if proc.returncode != 0:
        # docker_runner prints JSON on failure as well; try to parse
        try:
            return json.loads(proc.stdout)
        except Exception:
            return { 'success': False, 'error': 'runner_failed', 'message': proc.stderr or proc.stdout }
    try:
        return json.loads(proc.stdout)
    except Exception as e:
        return { 'success': False, 'error': 'bad_runner_output', 'message': str(e), 'stdout': proc.stdout, 'stderr': proc.stderr }


def compile_in_process(ir: dict, node_defs: dict = None, timeout: int = 5) -> dict:
    """Unsafe fallback: compile and run inside this process (not recommended for untrusted input)."""
    node_defs = node_defs or {}
    try:
        nodes = ir.get('nodes', [])
        edges = ir.get('edges', [])
        topological_sort(nodes, edges)
        if node_defs:
            validate_types(nodes, node_defs, edges)
    except ValidationError as e:
        return { 'success': False, 'error': 'validation', 'message': str(e) }

    emitter = CppEmitter(ir, node_defs)
    cpp = emitter.emit()
    mapping = getattr(emitter, 'mapping', [])

    tmpdir = tempfile.mkdtemp(prefix='compile_fallback_')
    try:
        cpp_path = os.path.join(tmpdir, 'out.cpp')
        bin_path = os.path.join(tmpdir, 'out_bin')
        with open(cpp_path, 'w') as f:
            f.write(cpp)
        cmd = ['g++', '-std=c++17', '-O2', '-o', bin_path, cpp_path]
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if proc.returncode != 0:
            return { 'success': False, 'error': 'compile', 'stderr': proc.stderr, 'stdout': proc.stdout, 'mapping': mapping, 'cpp': cpp }
        proc = subprocess.run([bin_path], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout)
        return { 'success': True, 'stdout': proc.stdout, 'stderr': proc.stderr, 'mapping': mapping, 'cpp': cpp }
    except subprocess.TimeoutExpired:
        return { 'success': False, 'error': 'timeout', 'message': 'Execution timed out', 'mapping': mapping, 'cpp': cpp }
    finally:
        try:
            shutil.rmtree(tmpdir)
        except Exception:
            pass


@app.route('/compile', methods=['POST'])
def compile_endpoint():
    payload = request.get_json()
    if not payload:
        return jsonify({ 'success': False, 'error': 'no_json' }), 400
    ir = payload.get('ir')
    node_defs = payload.get('node_defs', {})
    timeout = int(payload.get('timeout', 5))
    if not ir:
        return jsonify({ 'success': False, 'error': 'no_ir' }), 400

    # validate includes against allowlist before starting expensive steps
    try:
        includes = _collect_includes_from_ir(ir, node_defs)
        disallowed = [inc for inc in includes if _ALLOWED_INCLUDES and inc not in _ALLOWED_INCLUDES]
        if disallowed:
            return jsonify({ 'success': False, 'error': 'disallowed_includes', 'message': f'Includes not allowed: {disallowed}', 'allowed': sorted(list(_ALLOWED_INCLUDES)) }), 400
    except Exception as e:
        # non-fatal: proceed but log (we'll return an error)
        return jsonify({ 'success': False, 'error': 'include_check_failed', 'message': str(e) }), 400

    # Perform IR validation (topology & types) before scheduling the sandbox run
    try:
        nodes = ir.get('nodes', [])
        edges = ir.get('edges', [])
        # load default node_defs if not provided
        if not node_defs and DEFAULT_NODE_DEFS.exists():
            try:
                node_defs = json.load(open(DEFAULT_NODE_DEFS))
            except Exception:
                node_defs = {}
        # run validator
        topological_sort(nodes, edges)
        if node_defs:
            validate_types(nodes, node_defs, edges)
    except ValidationError as e:
        return jsonify({ 'success': False, 'error': 'validation', 'message': str(e) }), 400
    except Exception as e:
        return jsonify({ 'success': False, 'error': 'validation_error', 'message': str(e) }), 400

    # create workspace
    tmpdir = tempfile.mkdtemp(prefix='compile_service_')
    try:
        input_path = os.path.join(tmpdir, 'input.json')
        with open(input_path, 'w') as f:
            json.dump({ 'ir': ir, 'node_defs': node_defs, 'timeout': timeout }, f)

        # Prefer using the docker_runner wrapper for sandboxed execution
        if DOCKER_RUNNER.exists():
            try:
                docker_result = run_with_docker_runner(tmpdir, timeout=DOCKER_TIMEOUT)
            except Exception as e:
                docker_result = { 'success': False, 'error': 'runner_exception', 'message': str(e) }
        else:
            docker_result = { 'success': False, 'error': 'runner_missing', 'message': 'docker_runner.py not found' }

        if docker_result.get('success'):
            return jsonify(docker_result), 200

        # If docker failed, only allow unsafe fallback when DEV_ALLOW_FALLBACK is enabled and permitted
        if DEV_ALLOW_FALLBACK:
            # Restrict fallback to localhost requests unless a fallback token is configured
            remote = request.remote_addr
            if DEV_FALLBACK_TOKEN:
                header = request.headers.get('X-DEV-FALLBACK-TOKEN')
                if header != DEV_FALLBACK_TOKEN:
                    return jsonify({ 'success': False, 'error': 'fallback_forbidden', 'message': 'Invalid or missing DEV_FALLBACK_TOKEN header' }), 403
            else:
                if remote not in ('127.0.0.1', '::1', 'localhost'):
                    return jsonify({ 'success': False, 'error': 'fallback_forbidden', 'message': 'In-process fallback only allowed from localhost' }), 403

            fallback = compile_in_process(ir, node_defs, timeout)
            fallback['fallback_executed'] = True
            fallback['docker_error'] = docker_result
            status = 200 if fallback.get('success') else 400
            return jsonify(fallback), status

        # Otherwise, return docker error and advise enabling sandbox
        return jsonify({ 'success': False, 'error': 'sandbox_unavailable', 'message': 'Sandbox unavailable. Ensure Docker image is built and docker is accessible.', 'details': docker_result }), 503

    finally:
        try:
            shutil.rmtree(tmpdir)
        except Exception:
            pass


if __name__ == '__main__':
    print('Compile service (docker-runner-backed). Ensure you have built the sandbox image and do not expose this endpoint publicly without additional protections.')
    app.run(host='127.0.0.1', port=5001, debug=True)
