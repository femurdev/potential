import json
import pytest
from pathlib import Path
import sys

sys_path = Path(__file__).resolve().parents[1] / 'compiler'
sys.path.insert(0, str(sys_path))

from cpp_emitter import CppEmitter


def test_duplicate_operand_mapping_columns():
    # Construct IR where the same literal is used for both operands of an Add node
    ir = {
        'nodes': [
            {'id': 'l1', 'type': 'Literal', 'properties': {'value': 42}},
            {'id': 'add1', 'type': 'Add', 'inputs': ['l1', 'l1']},
        ],
        'edges': [],
        'imports': []
    }
    # empty node_defs will let emitter fallback to defaults for types
    emitter = CppEmitter(ir, {})
    cpp = emitter.emit()
    # mapping should contain entries for add1 ports 'a' and 'b'
    port_entries = [m for m in emitter.mapping if m.get('node_id') == 'add1' and m.get('port') in ('a', 'b')]
    assert len(port_entries) >= 2, f"Expected at least 2 port mappings for add1, got: {emitter.mapping}"
    # Ensure they are on the same line and have distinct column ranges
    lines = set((p['start_line'], p['end_line']) for p in port_entries)
    assert len(lines) == 1, f"Expected port mappings on same line, got lines: {lines}"
    cols = sorted((p['start_col'], p['end_col']) for p in port_entries)
    assert cols[0] != cols[1], f"Expected distinct column ranges for duplicate operands, got: {cols}"


if __name__ == '__main__':
    pytest.main([str(Path(__file__))])
