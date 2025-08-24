import pytest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'compiler'))

from cpp_emitter import CppEmitter


def test_call_node_duplicate_arg_columns():
    # IR: a literal passed twice to a Call node calling a function with two params
    ir = {
        'nodes': [
            {'id': 'l1', 'type': 'Literal', 'properties': {'value': 3}},
            {'id': 'call1', 'type': 'Call', 'properties': {'name': 'dupFunc'}, 'inputs': ['l1', 'l1']},
        ],
        'edges': [],
        'functions': [
            {
                'name': 'dupFunc',
                'params': [{'name': 'a', 'type': 'number'}, {'name': 'b', 'type': 'number'}],
                'returnType': 'number',
                'graph': {'nodes': [], 'edges': []}
            }
        ],
        'imports': []
    }

    emitter = CppEmitter(ir, {})
    cpp = emitter.emit()

    # mapping should contain entries for call1 (ports for its arguments)
    port_entries = [m for m in emitter.mapping if m.get('node_id') == 'call1']
    assert len(port_entries) >= 2, f"Expected at least 2 port mappings for call1, got: {emitter.mapping}"

    # Ensure they are on the same line and have distinct column ranges
    lines = set((p['start_line'], p['end_line']) for p in port_entries)
    assert len(lines) == 1, f"Expected port mappings on same line, got lines: {lines}"
    cols = sorted((p.get('start_col'), p.get('end_col')) for p in port_entries)
    assert cols[0] != cols[1], f"Expected distinct column ranges for duplicate args in Call node, got: {cols}"


if __name__ == '__main__':
    pytest.main([str(Path(__file__))])
