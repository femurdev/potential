import pytest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'compiler'))

from cpp_emitter import CppEmitter


def test_add_node_duplicate_literal_columns():
    # IR: Add node with same literal connected to both inputs
    ir = {
        'nodes': [
            {'id': 'l1', 'type': 'Literal', 'properties': {'value': 7}},
            {'id': 'add1', 'type': 'Add', 'inputs': ['l1', 'l1']},
        ],
        'edges': [],
        'imports': []
    }

    emitter = CppEmitter(ir, {})
    cpp = emitter.emit()

    # mapping should contain entries for add1 (ports for its operands)
    port_entries = [m for m in emitter.mapping if m.get('node_id') == 'add1']
    assert len(port_entries) >= 2, f"Expected at least 2 port mappings for add1, got: {emitter.mapping}"

    # Ensure they are on the same line and have distinct column ranges
    lines = set((p['start_line'], p['end_line']) for p in port_entries)
    assert len(lines) == 1, f"Expected port mappings on same line, got lines: {lines}"
    cols = sorted((p.get('start_col'), p.get('end_col')) for p in port_entries)
    assert cols[0] != cols[1], f"Expected distinct column ranges for duplicate operands in Add node, got: {cols}"


if __name__ == '__main__':
    pytest.main([str(Path(__file__))])
