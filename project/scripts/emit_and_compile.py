import subprocess
import sys
import os
from pathlib import Path
import re
from typing import Dict, Any
import json

# Import local modules
sys.path.append(str(Path(__file__).resolve().parents[1] / 'compiler'))
from cpp_emitter import CppEmitter
from validator import topological_sort, validate_types, ValidationError

# Default execution timeout (seconds) for running emitted binaries
DEFAULT_EXEC_TIMEOUT = int(os.environ.get('EXEC_TIMEOUT', '5'))


def load_json(p):
    with open(p) as f:
        return json.load(f)


def write_mapping(mapping, out_map_path):
    with open(out_map_path, 'w') as f:
        json.dump({'mappings': mapping}, f, indent=2)


def parse_gpp_errors(stderr_text):
    # g++ error format: file:line:col: error: message
    # Also accept formats without column (file:line: error: message)
    pattern = re.compile(r"^(?P<file>[^:\\n]+):(?P<line>\d+)(?::(?P<col>\d+))?: (?P<kind>warning|error): (?P<msg>.*)$")
    results = []
    for line in stderr_text.splitlines():
        m = pattern.match(line)
        if m:
            info = m.groupdict()
            results.append({
                'file': info.get('file'),
                'line': int(info.get('line')),
                'col': int(info['col']) if info.get('col') and info['col'].isdigit() else None,
                'kind': info.get('kind'),
                'msg': info.get('msg').strip()
            })
    return results


def map_errors_to_nodes(errors, mapping, cpp_path):
    mapped = []
    # mapping: list of {node_id, function?, start_line, end_line, start_col?, end_col?, port?}
    for err in errors:
        line = int(err['line'])
        col = err.get('col')
        # prefer exact column matches when available
        colMatches = []
        if col is not None:
            for m in mapping:
                sline = m.get('start_line')
                eline = m.get('end_line')
                scol = m.get('start_col')
                ecol = m.get('end_col')
                if sline and eline and sline <= line <= eline and scol and ecol and scol <= col <= ecol:
                    colMatches.append(m)
        if colMatches:
            # choose smallest range
            colMatches.sort(key=lambda x: ((x.get('end_line',0)-x.get('start_line',0)), (x.get('end_col',0)-x.get('start_col',0))))
            node = colMatches[0]
            mapped.append({'error': err, 'node_id': node['node_id'], 'function': node.get('function'), 'port': node.get('port')})
            continue
        # fallback: prefer line-only matches and choose smallest line range
        lineMatches = [m for m in mapping if m.get('start_line') and m.get('end_line') and m['start_line'] <= line <= m['end_line']]
        if lineMatches:
            lineMatches.sort(key=lambda x: (x['end_line'] - x['start_line']))
            node = lineMatches[0]
            mapped.append({'error': err, 'node_id': node['node_id'], 'function': node.get('function'), 'port': node.get('port')})
        else:
            mapped.append({'error': err, 'node_id': None, 'function': None, 'port': None})
    return mapped


def normalize_ir(ir: Dict[str, Any]) -> Dict[str, Any]:
    # Canonicalize edges and node.inputs/outputs. We'll treat edges[] as canonical if present.
    nodes = ir.get('nodes', [])
    node_ids = {n['id'] for n in nodes}
    edges = ir.get('edges', []) or []

    if edges:
        # populate node.inputs and outputs from edges
        inputs_map = {nid: [] for nid in node_ids}
        outputs_map = {nid: [] for nid in node_ids}
        for e in edges:
            frm = e.get('from')
            to = e.get('to')
            if frm not in node_ids or to not in node_ids:
                # skip invalid edges
                continue
            inputs_map.setdefault(to, [])
            if frm not in inputs_map[to]:
                inputs_map[to].append(frm)
            outputs_map.setdefault(frm, [])
            if to not in outputs_map[frm]:
                outputs_map[frm].append(to)
        # write back to nodes
        for n in nodes:
            nid = n['id']
            n['inputs'] = inputs_map.get(nid, [])
            n['outputs'] = outputs_map.get(nid, [])
    else:
        # No edges[] provided: build edges from node.inputs/node.outputs if present
        edges = []
        for n in nodes:
            for inp in n.get('inputs', []):
                if inp not in node_ids:
                    continue
                edges.append({'from': inp, 'to': n['id']})
        # deduplicate edges
        seen = set()
        uniq = []
        for e in edges:
            key = (e['from'], e['to'])
            if key in seen:
                continue
            seen.add(key)
            uniq.append(e)
        ir['edges'] = uniq
        # Also ensure outputs populated
        outputs_map = {nid: [] for nid in node_ids}
        for e in uniq:
            frm = e['from']
            to = e['to']
            outputs_map.setdefault(frm, [])
            if to not in outputs_map[frm]:
                outputs_map[frm].append(to)
        for n in nodes:
            n['outputs'] = outputs_map.get(n['id'], [])
    return ir


def emit_compile_run(ir_path, node_defs_path=None, out_bin='out_run'):
    ir = load_json(ir_path)
    ir = normalize_ir(ir)
    node_defs = {}
    if node_defs_path and os.path.exists(node_defs_path):
        node_defs = load_json(node_defs_path)

    # write normalized IR for debugging
    out_norm = Path(ir_path).with_suffix('.normalized.json')
    with open(out_norm, 'w') as f:
        json.dump(ir, f, indent=2)

    # Validate
    nodes = ir.get('nodes', [])
    try:
        topological_sort(nodes)
        if node_defs:
            validate_types(nodes, node_defs)
    except ValidationError as e:
        print('Validation failed:', e)
        return 2

    emitter = CppEmitter(ir, node_defs)
    cpp = emitter.emit()

    out_cpp = Path(ir_path).with_suffix('.cpp')
    map_path = out_cpp.with_suffix('.map.json')
    with open(out_cpp, 'w') as f:
        f.write(cpp)

    # write mapping
    try:
        mapping = emitter.mapping
    except Exception:
        mapping = []
    write_mapping(mapping, map_path)

    # Compile
    cmd = ['g++', '-std=c++17', '-O2', '-o', out_bin, str(out_cpp)]
    print('Compiling:', ' '.join(cmd))
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if proc.returncode != 0:
        print('Compile error:\n', proc.stderr)
        errors = parse_gpp_errors(proc.stderr)
        mapped = map_errors_to_nodes(errors, mapping, str(out_cpp))
        # output structured mapping to a JSON file for tooling
        out_err_path = Path(ir_path).with_suffix('.errors.json')
        with open(out_err_path, 'w') as f:
            json.dump({'mapped_errors': mapped, 'raw_stderr': proc.stderr}, f, indent=2)
        if mapped:
            print('\nMapped errors:')
            for m in mapped:
                err = m['error']
                node_id = m['node_id']
                func = m['function']
                port = m.get('port')
                if node_id:
                    col_info = f":{err['col']}" if err.get('col') else ''
                    print(f"- {err['kind'].upper()} at {err['file']}:{err['line']}{col_info} -> node '{node_id}' (function={func}, port={port}): {err['msg']}")
                else:
                    col_info = f":{err['col']}" if err.get('col') else ''
                    print(f"- {err['kind'].upper()} at {err['file']}:{err['line']}{col_info} -> [no node mapping]: {err['msg']}")
        return 3

    # Run
    try:
        proc = subprocess.run(['./' + out_bin], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=DEFAULT_EXEC_TIMEOUT)
        print('Program stdout:\n', proc.stdout)
        if proc.stderr:
            print('Program stderr:\n', proc.stderr)
        print(f"Wrote C++ to: {out_cpp}")
        print(f"Wrote mapping to: {map_path}")
        print(f"Wrote normalized IR to: {out_norm}")
        return 0
    except subprocess.TimeoutExpired:
        # Write a structured error file
        out_err_path = Path(ir_path).with_suffix('.errors.json')
        msg = f"Execution timed out after {DEFAULT_EXEC_TIMEOUT} seconds"
        with open(out_err_path, 'w') as f:
            json.dump({'mapped_errors': [], 'raw_stderr': '', 'error': 'timeout', 'message': msg, 'mapping': mapping, 'cpp': str(out_cpp)}, f, indent=2)
        print('Execution timed out')
        return 4


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: emit_and_compile.py path/to/ir.json [node_defs.json]')
        sys.exit(1)
    ir_path = sys.argv[1]
    node_defs = sys.argv[2] if len(sys.argv) > 2 else None
    rc = emit_compile_run(ir_path, node_defs, out_bin='project/examples/run_bin')
    sys.exit(rc)
