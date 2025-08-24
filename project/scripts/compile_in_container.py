#!/usr/bin/env python3
"""
Entry point for the sandbox Docker image. Expects a JSON file at /workspace/input.json with keys:
  { "ir": {...}, "node_defs": {...}, "timeout": <seconds> }
Writes result JSON to /workspace/output.json

This script is intentionally minimal and uses the same emitter & validator modules.
"""
import json
import os
import sys
import shutil
import subprocess
from pathlib import Path

# ensure python3 import paths
sys.path.append(str(Path(__file__).resolve().parents[1] / 'compiler'))
from cpp_emitter import CppEmitter
from validator import topological_sort, validate_types, ValidationError

WORKDIR = '/workspace'
INPUT = os.path.join(WORKDIR, 'input.json')
OUTPUT = os.path.join(WORKDIR, 'output.json')


def write_output(obj):
    try:
        with open(OUTPUT, 'w') as f:
            json.dump(obj, f, indent=2)
    except Exception as e:
        print('Failed to write output.json:', e, file=sys.stderr)


def compile_ir_to_bin(ir, node_defs, tmpdir, timeout=5):
    # emit
    emitter = CppEmitter(ir, node_defs)
    cpp = emitter.emit()
    mapping = getattr(emitter, 'mapping', [])
    cpp_path = os.path.join(tmpdir, 'out.cpp')
    bin_path = os.path.join(tmpdir, 'out_bin')
    with open(cpp_path, 'w') as f:
        f.write(cpp)
    # compile
    cmd = ['g++', '-std=c++17', '-O2', '-o', bin_path, cpp_path]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if proc.returncode != 0:
        return { 'success': False, 'error': 'compile', 'stderr': proc.stderr, 'stdout': proc.stdout, 'mapping': mapping, 'cpp': cpp }
    # run
    try:
        proc = subprocess.run([bin_path], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return { 'success': False, 'error': 'timeout', 'message': 'Execution timed out', 'mapping': mapping, 'cpp': cpp }
    return { 'success': True, 'stdout': proc.stdout, 'stderr': proc.stderr, 'mapping': mapping, 'cpp': cpp }


def main():
    if not os.path.exists(INPUT):
        write_output({ 'success': False, 'error': 'no_input', 'message': f'Missing {INPUT}' })
        sys.exit(1)
    try:
        data = json.load(open(INPUT))
    except Exception as e:
        write_output({ 'success': False, 'error': 'invalid_json', 'message': str(e) })
        sys.exit(1)
    ir = data.get('ir')
    node_defs = data.get('node_defs', {})
    timeout = int(data.get('timeout', 5))
    if not ir:
        write_output({ 'success': False, 'error': 'no_ir' })
        sys.exit(1)

    # prepare temp dir within workspace
    tmpdir = os.path.join(WORKDIR, 'tmp')
    try:
        if os.path.exists(tmpdir):
            shutil.rmtree(tmpdir)
        os.makedirs(tmpdir, exist_ok=True)
    except Exception as e:
        write_output({ 'success': False, 'error': 'tmpdir', 'message': str(e) })
        sys.exit(1)

    # validate
    try:
        nodes = ir.get('nodes', [])
        edges = ir.get('edges', [])
        topological_sort(nodes, edges)
        if node_defs:
            validate_types(nodes, node_defs, edges)
    except ValidationError as e:
        write_output({ 'success': False, 'error': 'validation', 'message': str(e) })
        sys.exit(0)

    # compile & run
    try:
        result = compile_ir_to_bin(ir, node_defs, tmpdir, timeout=timeout)
    except Exception as e:
        result = { 'success': False, 'error': 'exception', 'message': str(e) }

    write_output(result)

if __name__ == '__main__':
    main()
