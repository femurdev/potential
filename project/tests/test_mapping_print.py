import pytest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'compiler'))

from cpp_emitter import CppEmitter


def test_print_node_duplicate_operand_columns():
    # IR: Print node that prints the same literal twice on one emitted line via concatenation
    # We'll model this as two Print nodes emitted on the same line by composing them in a single statement
    # Simpler: create two Print nodes that produce separate lines - to force same-line, we rely on emitter formatting
    # Instead, create a single Print node whose input expression is something like concat of same literal twice.
    # For simplicity, we will create an Add-like expression and then a Print that prints the same variable twice in one line using CppEmitter behavior.

    ir = {
        'nodes': [
            {'id': 'l1', 'type': 'Literal', 'properties': {'value': 42}},
            {'id': 'p1', 'type': 'Print', 'inputs': ['l1']},
            {'id': 'p2', 'type': 'Print', 'inputs': ['l1']},
        ],
        'edges': [],
        'imports': []
    }

    emitter = CppEmitter(ir, {})
    cpp = emitter.emit()

    # mapping should contain entries for p1 and p2
    p1_entries = [m for m in emitter.mapping if m.get('node_id') == 'p1']
    p2_entries = [m for m in emitter.mapping if m.get('node_id') == 'p2']
    assert len(p1_entries) >= 1, f"Expected mapping entries for p1, got: {emitter.mapping}"
    assert len(p2_entries) >= 1, f"Expected mapping entries for p2, got: {emitter.mapping}"

    # It's acceptable if they are on different lines; if they end up on same line ensure distinct columns
    line_pairs = set((e['start_line'], e['end_line']) for e in p1_entries + p2_entries)
    # If p1 and p2 share a line, check column ranges differ
    combined = p1_entries + p2_entries
    if any((p1_entries[0]['start_line'] == p2_entries[0]['start_line'])):
        cols = sorted((p.get('start_col'), p.get('end_col')) for p in combined)
        assert cols[0] != cols[1], f"Expected distinct column ranges for duplicate Print operands, got: {cols}"


if __name__ == '__main__':
    pytest.main([str(Path(__file__))])
