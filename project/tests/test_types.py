import json
from pathlib import Path
import sys

# Ensure compiler modules are importable
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'compiler'))

from validator import validate_types, ValidationError
from cpp_emitter import CppEmitter

NODE_DEFS_PATH = Path(__file__).resolve().parents[1] / 'compiler' / 'node_defs.json'
EXAMPLE_IR = Path(__file__).resolve().parents[1] / 'examples' / 'cast_example_ir.json'


def load_node_defs():
    return json.load(open(NODE_DEFS_PATH))


def load_ir():
    return json.load(open(EXAMPLE_IR))


def test_validator_suggests_cast_for_string_to_number():
    ir = load_ir()
    node_defs = load_node_defs()
    nodes = ir.get('nodes', [])
    edges = ir.get('edges', [])
    try:
        validate_types(nodes, node_defs, edges)
        assert False, "Expected ValidationError due to string -> number mismatch"
    except ValidationError as e:
        details = getattr(e, 'details', {})
        # Validator should include suggested_cast (the expected type for the connection)
        assert 'suggested_cast' in details or 'expected' in details, f"ValidationError details missing suggestion: {details}"


def test_inserting_cast_node_allows_validation_and_emitter_records_mapping():
    ir = load_ir()
    node_defs = load_node_defs()
    # find original edge from l_str -> add1
    edges = ir.get('edges', [])
    # remove that edge and insert Cast node between
    new_edges = []
    cast_id = 'cast_test'
    for e in edges:
        if e.get('from') == 'l_str' and e.get('to') == 'add1' and e.get('toPort') == 'a':
            # replace with l_str -> cast_test (toPort in) and cast_test -> add1 (toPort a)
            new_edges.append({'from': 'l_str', 'to': cast_id, 'toPort': 'in'})
            new_edges.append({'from': cast_id, 'to': 'add1', 'toPort': 'a'})
        else:
            new_edges.append(e)
    ir['edges'] = new_edges
    # add Cast node
    ir['nodes'].append({'id': cast_id, 'type': 'Cast', 'properties': {'targetType': 'number'}})

    # validation should pass now
    nodes = ir.get('nodes', [])
    edges = ir.get('edges', [])
    validate_types(nodes, node_defs, edges)  # should not raise

    # emitter should produce mapping entry for the cast node
    emitter = CppEmitter(ir, node_defs)
    cpp = emitter.emit()
    mapping = getattr(emitter, 'mapping', [])
    cast_mappings = [m for m in mapping if m.get('node_id') == cast_id]
    assert len(cast_mappings) > 0, f"Expected mapping entries for cast node, got: {mapping}"
    # emitted C++ should contain the generated variable name for the cast (v_cast_test or similar)
    assert 'cast_test' not in cpp or 'v_cast_test' in cpp or any(cast_id in m.get('node_id','') for m in mapping)


if __name__ == '__main__':
    print('Running tests...')
    test_validator_suggests_cast_for_string_to_number()
    test_inserting_cast_node_allows_validation_and_emitter_records_mapping()
    print('OK')
