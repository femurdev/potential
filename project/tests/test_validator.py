import json
import pytest
from pathlib import Path

sys_path = Path(__file__).resolve().parents[1] / 'compiler'
import sys
sys.path.insert(0, str(sys_path))

from validator import validate_types, ValidationError


def load_node_defs():
    ndp = Path(__file__).resolve().parents[1] / 'compiler' / 'node_defs.json'
    return json.load(open(ndp))


def test_invalid_toPort_raises_validation_error():
    # Build a small IR where an edge references a non-existing toPort on an Add node
    node_defs = load_node_defs()
    nodes = [
        {"id": "l1", "type": "Literal", "properties": {"value": 1}},
        {"id": "add1", "type": "Add", "inputs": []}
    ]
    # edges specify toPort 'x' which does not exist on Add (valid ports are 'a' and 'b')
    edges = [{"from": "l1", "to": "add1", "toPort": "x"}]

    with pytest.raises(ValidationError) as exc:
        validate_types(nodes, node_defs, edges)
    assert "has no input port named" in str(exc.value)


def test_invalid_fromPort_raises_validation_error():
    # Build nodes where fromPort refers to non-existing output on the source node
    node_defs = load_node_defs()
    nodes = [
        {"id": "l1", "type": "Literal", "properties": {"value": 1}},
        {"id": "print1", "type": "Print", "inputs": []}
    ]
    # 'l1' has no output port named 'outX'
    edges = [{"from": "l1", "to": "print1", "fromPort": "outX", "toPort": "value"}]

    with pytest.raises(ValidationError) as exc:
        validate_types(nodes, node_defs, edges)
    assert "has no output port named" in str(exc.value)
