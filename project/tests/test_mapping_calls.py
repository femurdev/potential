import pytest
from pathlib import Path
import sys

sys_path = Path(__file__).resolve().parents[1] / 'compiler'
sys.path.insert(0, str(sys_path))

from cpp_emitter import CppEmitter


def test_call_node_duplicate_arg_mapping_columns():
    # Construct IR with a function 'add' and a Call node that passes the same literal twice
    ir = {
        'nodes': [
            {'id': 'l1', 'type': 'Literal', 'properties': {'value': 3}},
            {'id': 'call1', 'type': 'Call', 'inputs': ['l1', 'l1'], 'properties': {'function': 'add'}},
        ],
        'edges': [],
        'functions': [
            {
                'name': 'add',
                'graph': {
                    'nodes': [
                        {'id': 'p1', 'type': 'Param', 'properties': {'name': 'a'}},
                        {'id': 'p2', 'type': 'Param', 'properties': {'name': 'b'}},
                        {'id': 'add_local', 'type': 'Add', 'inputs': ['p1', 'p2']},
                        {'id': 'ret', 'type': 'Return', 'inputs': ['add_local']},
                    ],
                    'edges': []
                }
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
    assert cols[0] != cols[1], f"Expected distinct column ranges for duplicate operands in Call node, got: {cols}"


if __name__ == '__main__':
    pytest.main([str(Path(__file__))])
