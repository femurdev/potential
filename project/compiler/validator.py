from typing import List, Dict, Any, Tuple, Optional

class ValidationError(Exception):
    def __init__(self, message: str, details: Dict[str, Any] = None):
        super().__init__(message)
        self.details = details or {}


def build_adj(nodes: List[Dict[str, Any]], edges: List[Dict[str, Any]] = None) -> Tuple[Dict[str, List[str]], Dict[str, int]]:
    # adjacency: node -> list of nodes that depend on it (outgoing), and indegree
    edges = edges or []
    node_ids = [n['id'] for n in nodes]
    adj = {nid: [] for nid in node_ids}
    indeg = {nid: 0 for nid in node_ids}
    if edges:
        for e in edges:
            frm = e.get('from')
            to = e.get('to')
            if frm not in adj:
                raise ValidationError(f"Edge references unknown node '{frm}'", {'node': frm})
            if to not in adj:
                raise ValidationError(f"Edge references unknown node '{to}'", {'node': to})
            adj[frm].append(to)
            indeg[to] += 1
    else:
        # fallback to node.inputs
        for n in nodes:
            for inp in n.get('inputs', []):
                if inp not in adj:
                    raise ValidationError(f"Input reference '{inp}' for node '{n['id']}' not found", {'node': n['id'], 'input': inp})
                adj[inp].append(n['id'])
                indeg[n['id']] += 1
    return adj, indeg


def topological_sort(nodes: List[Dict[str, Any]], edges: List[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    adj, indeg = build_adj(nodes, edges)
    # Kahn's algorithm
    q = [nid for nid, d in indeg.items() if d == 0]
    order_ids = []
    while q:
        n = q.pop(0)
        order_ids.append(n)
        for m in adj[n]:
            indeg[m] -= 1
            if indeg[m] == 0:
                q.append(m)
    if len(order_ids) != len(nodes):
        raise ValidationError('Cycle detected in graph', {'cycle': True})
    id_to_node = {n['id']: n for n in nodes}
    return [id_to_node[i] for i in order_ids]


def _infer_literal_type(val: Any) -> str:
    # Distinguish common literal types more precisely
    if isinstance(val, bool):
        return 'bool'
    if isinstance(val, int) and not isinstance(val, bool):
        return 'int'
    if isinstance(val, float):
        return 'double'
    if isinstance(val, str):
        return 'string'
    return 'any'


def _canonical_type(t: Optional[str]) -> str:
    # Normalize type aliases used in node_defs to a canonical family
    if not t:
        return 'any'
    t = t.lower()
    if t in ('number', 'double', 'float'):
        return 'double'
    if t == 'int':
        return 'int'
    if t == 'string':
        return 'string'
    if t == 'bool':
        return 'bool'
    if t == 'any' or t == 'auto':
        return 'any'
    return t


def _is_compatible(expected: str, actual: str) -> bool:
    # canonicalize
    e = _canonical_type(expected)
    a = _canonical_type(actual)
    if e == 'any' or a == 'any':
        return True
    if e == a:
        return True
    # allow widening int -> double
    if e == 'double' and a == 'int':
        return True
    return False


def validate_types(nodes: List[Dict[str, Any]], node_defs: Dict[str, Any], edges: List[Dict[str, Any]] = None):
    # Port-level type checking using edges if provided, else node.inputs
    id_to_node = {n['id']: n for n in nodes}
    edges = edges or []

    # build output type map (literal inference etc.)
    id_to_out_type: Dict[str, str] = {}
    # first, literals
    for n in nodes:
        tdef = node_defs.get(n['type'])
        if not tdef:
            raise ValidationError(f"Unknown node type: {n['type']}", {'node_id': n.get('id'), 'node_type': n.get('type')})
        if n['type'] == 'Literal':
            val = n.get('properties', {}).get('value')
            id_to_out_type[n['id']] = _infer_literal_type(val)

    # for non-literals, assign from node_defs outputs when possible
    for n in nodes:
        if n['id'] in id_to_out_type:
            continue
        tdef = node_defs.get(n['type'], {})
        outs = tdef.get('outputs', [])
        if outs:
            # assume first output type as node output type
            id_to_out_type[n['id']] = outs[0].get('type')

    # Build list of connections: tuples (from, to, toPort, fromPort)
    conns = []
    if edges:
        for e in edges:
            frm = e.get('from')
            to = e.get('to')
            fromPort = e.get('fromPort')
            toPort = e.get('toPort')
            conns.append((frm, to, toPort, fromPort))
    else:
        # derive from node.inputs (positional)
        for n in nodes:
            for idx, inp in enumerate(n.get('inputs', [])):
                # positional: we don't know port name, set None and validator will match by index
                conns.append((inp, n['id'], None, None))

    # validate references exist
    for (frm, to, toPort, fromPort) in conns:
        if frm not in id_to_node or to not in id_to_node:
            raise ValidationError(f"Connection references unknown nodes: {frm} -> {to}", {'from': frm, 'to': to})

    # For each destination, gather its incoming conns in order to resolve positional mapping
    incoming_by_dest: Dict[str, List[Tuple[str, str, str, str]]] = {}
    for c in conns:
        frm, to, toPort, fromPort = c
        incoming_by_dest.setdefault(to, []).append(c)

    for dest, incoming in incoming_by_dest.items():
        dest_node = id_to_node[dest]
        dest_tdef = node_defs.get(dest_node['type'], {})
        dest_inputs = dest_tdef.get('inputs', [])
        valid_input_names = [p.get('name') for p in dest_inputs]
        for idx, (frm, to, toPort, fromPort) in enumerate(incoming):
            # determine expected type
            expected = None
            if toPort:
                # find input port by name
                found = next((p for p in dest_inputs if p.get('name') == toPort), None)
                if not found:
                    raise ValidationError(
                        f"Node '{dest}' has no input port named '{toPort}'",
                        {'node': dest, 'missing_input_port': toPort, 'valid_ports': valid_input_names}
                    )
                expected = found.get('type')
            else:
                # positional: match by index
                if idx < len(dest_inputs):
                    expected = dest_inputs[idx].get('type')
                else:
                    expected = 'any'

            # determine actual type from source node
            src_node = id_to_node[frm]
            src_tdef = node_defs.get(src_node['type'], {})
            src_outputs = src_tdef.get('outputs', [])
            actual = None
            if fromPort:
                found_out = next((p for p in src_outputs if p.get('name') == fromPort), None)
                if not found_out:
                    raise ValidationError(
                        f"Node '{frm}' has no output port named '{fromPort}'",
                        {'node': frm, 'missing_output_port': fromPort, 'valid_output_ports': [p.get('name') for p in src_outputs]}
                    )
                actual = found_out.get('type')
            else:
                # fallback: use known id_to_out_type if determined (e.g., Literal), else first declared output
                actual = id_to_out_type.get(frm)
                if not actual:
                    if src_outputs:
                        actual = src_outputs[0].get('type')
                    else:
                        actual = 'any'

            # compare types with coercion rules
            if not _is_compatible(expected, actual):
                details = {'from': frm, 'to': to, 'toPort': toPort, 'expected': expected, 'actual': actual}
                # suggest a cast to expected if safe
                details['suggested_cast'] = expected
                raise ValidationError(
                    f"Type mismatch on connection {frm}->{to} (toPort={toPort}): expected {expected}, got {actual}",
                    details
                )

    return True


if __name__ == '__main__':
    import json, sys
    if len(sys.argv) < 3:
        print('Usage: validator.py ir.json node_defs.json')
        sys.exit(1)
    ir = json.load(open(sys.argv[1]))
    node_defs = json.load(open(sys.argv[2]))
    try:
        nodes = ir.get('nodes', [])
        edges = ir.get('edges', [])
        topological_sort(nodes, edges)
        validate_types(nodes, node_defs, edges)
        print('OK')
    except ValidationError as e:
        print('Validation error:', e, 'details:', getattr(e, 'details', {}))
        sys.exit(2)
