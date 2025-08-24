import os
import re

from validator import topological_sort, ValidationError, _canonical_type


class CppEmitter:
    TYPE_MAP = {
        'number': 'double',
        'double': 'double',
        'int': 'int',
        'string': 'std::string',
        'bool': 'bool',
        'any': 'auto'
    }

    def __init__(self, ir: Dict[str, Any], node_defs: Dict[str, Any] = None):
        self.ir = ir
        self.node_defs = node_defs or {}
        self.includes = set(ir.get("imports", []))
        self.code_lines: List[str] = []
        self.indent_level = 0
        self.var_names: Dict[str, str] = {}  # node id -> C++ variable name
        self._used_names: Dict[str, int] = {}
        self.mapping: List[Dict[str, Any]] = []  # {node_id, function?, start_line, end_line, start_col?, end_col?, port?}
        self._port_mappings: List[Dict[str, Any]] = []  # fallback port mapping entries if immediate resolution fails

        # Build incoming edge maps: for each destination node, map toPort->fromNode; also keep positional list
        self.incoming_by_node: Dict[str, Dict[str, str]] = {}
        self.incoming_list_by_node: Dict[str, List[str]] = {}
        edges = ir.get('edges', []) or []
        for e in edges:
            frm = e.get('from')
            to = e.get('to')
            toPort = e.get('toPort')
            if to not in self.incoming_by_node:
                self.incoming_by_node[to] = {}
            if toPort:
                self.incoming_by_node[to][toPort] = frm
            else:
                # positional
                self.incoming_list_by_node.setdefault(to, []).append(frm)

    def emit_include(self):
        for inc in sorted(self.includes):
            self.code_lines.append(f"#include {inc}")
        self.code_lines.append("")

    def indent(self):
        return "    " * self.indent_level

    def sanitize(self, node_id: str) -> str:
        # Replace invalid identifier characters with '_', ensure doesn't start with digit
        s = re.sub(r'[^0-9a-zA-Z_]', '_', node_id)
        if re.match(r'^[0-9]', s):
            s = '_' + s
        return s

    def make_var(self, node_id: str) -> str:
        base = 'v_' + self.sanitize(node_id)
        count = self._used_names.get(base, 0)
        if count == 0:
            self._used_names[base] = 1
            return base
        else:
            self._used_names[base] = count + 1
            return f"{base}_{count}"

    def cpp_type(self, t: str) -> str:
        return self.TYPE_MAP.get(t, t)

    def ensure_lib_includes(self, node_type: str):
        ddef = self.node_defs.get(node_type, {})
        lib = ddef.get('lib')
        if lib:
            inc = lib.get('include')
            if inc:
                self.includes.add(inc)

    def escape_string(self, s: str) -> str:
        # simple C++ string escape
        esc = s.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n').replace('\t', '\\t')
        return esc

    def _marker_start(self, node_id: str, port: Optional[str]) -> str:
        # unique start marker comment (kept for compatibility/debug)
        port_part = port if port is not None else 'port'
        return f"/*__NODE:{self.sanitize(node_id)}:PORT:{port_part}__*/"

    def _marker_end(self) -> str:
        return "/*__ENDNODE__*/"

    def record_map(self, node_id: str, start_line: int, end_line: int, function: Optional[str] = None, port: Optional[str] = None):
        self.mapping.append({
            'node_id': node_id,
            'function': function,
            'start_line': start_line,
            'end_line': end_line,
            'start_col': None,
            'end_col': None,
            'port': port
        })

    def emit_line_with_fragments(self, fragments: List[Dict[str, Any]], function: Optional[str] = None):
        """
        fragments: list of { 'text': str, optional 'marker': { 'node_id':..., 'port':... } }
        Appends the concatenated line to code_lines and records mapping entries for fragments that have marker.
        Returns the 1-based line number.
        """
        line_text = ''.join([f.get('text', '') for f in fragments])
        self.code_lines.append(line_text)
        line_no = len(self.code_lines)
        offset = 0
        for frag in fragments:
            text = frag.get('text', '')
            mk = frag.get('marker')
            if mk:
                node_id = mk.get('node_id')
                port = mk.get('port')
                start_col = offset + 1
                end_col = offset + len(text)
                # Append precise mapping entry
                self.mapping.append({
                    'node_id': node_id,
                    'function': function,
                    'start_line': line_no,
                    'end_line': line_no,
                    'start_col': start_col,
                    'end_col': end_col,
                    'port': port
                })
            offset += len(text)
        return line_no

    def record_port_expr(self, node_id: str, port: str, marker_expr: str, line: int):
        # Backwards-compatible fallback: try to resolve and record mapping using the already-emitted line
        # If the marker_expr is the raw expression (no markers), we will find it; otherwise fallback to stored list
        try:
            if 1 <= line <= len(self.code_lines):
                text = self.code_lines[line-1]
                idx = text.find(marker_expr)
                if idx >= 0:
                    start_col = idx + 1
                    end_col = start_col + len(marker_expr) - 1
                    self.mapping.append({
                        'node_id': node_id,
                        'function': None,
                        'start_line': line,
                        'end_line': line,
                        'start_col': start_col,
                        'end_col': end_col,
                        'port': port
                    })
                    return
        except Exception:
            pass
        # Fallback: record for later resolution
        self._port_mappings.append({'node_id': node_id, 'port': port, 'expr': marker_expr, 'line': line})

    def _resolve_input_for_node(self, node: Dict[str, Any], port_name: Optional[str], index: Optional[int] = None, local_incoming_map: Optional[Dict[str, str]] = None, local_incoming_list: Optional[Dict[str, List[str]]] = None) -> Optional[str]:
        # Try to resolve an input source node id by port name or positional index.
        nid = node['id']
        # check provided incoming maps (function-local) first
        if local_incoming_map and nid in local_incoming_map and port_name:
            if port_name in local_incoming_map[nid]:
                return local_incoming_map[nid][port_name]
        if self.incoming_by_node and nid in self.incoming_by_node and port_name:
            if port_name in self.incoming_by_node[nid]:
                return self.incoming_by_node[nid][port_name]
        # positional fallback: try local list then global list
        if index is not None:
            if local_incoming_list and nid in local_incoming_list and index < len(local_incoming_list[nid]):
                return local_incoming_list[nid][index]
            if nid in self.incoming_list_by_node and index < len(self.incoming_list_by_node[nid]):
                return self.incoming_list_by_node[nid][index]
        # legacy: check node.inputs array
        inputs = node.get('inputs', [])
        if port_name is None and index is not None and index < len(inputs):
            return inputs[index]
        return None

    def _finalize_mappings(self):
        # compute start_col/end_col for coarse mapping entries based on code_lines
        # code_lines are 0-indexed, mapping lines are 1-indexed
        for m in self.mapping:
            s = m.get('start_line')
            e = m.get('end_line')
            if s and 1 <= s <= len(self.code_lines):
                line_text = self.code_lines[s-1]
                # find first non-space char
                first = len(line_text) - len(line_text.lstrip(' ')) + 1
                if m.get('start_col') is None:
                    m['start_col'] = first
            if e and 1 <= e <= len(self.code_lines):
                line_text = self.code_lines[e-1]
                if m.get('end_col') is None:
                    m['end_col'] = len(line_text)
        # resolve any remaining port mappings by searching for expressions in the specified line
        for p in self._port_mappings:
            line = p.get('line')
            expr = p.get('expr')
            node_id = p.get('node_id')
            port = p.get('port')
            if not line or line < 1 or line > len(self.code_lines):
                continue
            text = self.code_lines[line-1]
            idx = text.find(expr)
            if idx >= 0:
                start_col = idx + 1
                end_col = start_col + len(expr) - 1
                # append a mapping entry for this port
                self.mapping.append({
                    'node_id': node_id,
                    'function': None,
                    'start_line': line,
                    'end_line': line,
                    'start_col': start_col,
                    'end_col': end_col,
                    'port': port
                })

    def emit_function_def(self, func: Dict[str, Any]):
        # func: {name, params, returnType, graph}
        name = func.get('name')
        params = func.get('params', [])
        return_type = func.get('returnType', 'void')
        graph = func.get('graph', {})
        nodes = graph.get('nodes', [])
        edges = graph.get('edges', []) or []
        # build local incoming maps for function graph
        local_incoming_map: Dict[str, Dict[str, str]] = {}
        local_incoming_list: Dict[str, List[str]] = {}
        for e in edges:
            frm = e.get('from')
            to = e.get('to')
            toPort = e.get('toPort')
            if toPort:
                local_incoming_map.setdefault(to, {})[toPort] = frm
            else:
                local_incoming_list.setdefault(to, []).append(frm)

        # collect includes from nodes
        for n in nodes:
            self.ensure_lib_includes(n.get('type'))
        # signature
        cpp_return = self.cpp_type(return_type) if return_type else 'void'
        param_list = []
        for p in params:
            ptype = self.cpp_type(p.get('type', 'auto'))
            pname = p.get('name')
            param_list.append(f"{ptype} {pname}")
        sig = f"{cpp_return} {name}({', '.join(param_list)})"
        self.code_lines.append(sig + ' {')
        self.indent_level += 1
        # local emitter state
        local_var_names: Dict[str, str] = {}
        local_used_names: Dict[str, int] = {}

        def local_make_var(node_id: str) -> str:
            base = 'v_' + re.sub(r'[^0-9a-zA-Z_]', '_', node_id)
            count = local_used_names.get(base, 0)
            if count == 0:
                local_used_names[base] = 1
                return base
            else:
                local_used_names[base] = count + 1
                return f"{base}_{count}"

        def wrap_expr_for_port(nid: str, port: str, expr: str) -> str:
            # kept for compatibility: return raw expr; markers are tracked via fragments
            return expr

        # map Param nodes to param names based on properties or order
        param_nodes = [n for n in nodes if n.get('type') == 'Param']
        # try to match by properties.name
        assigned = set()
        for p in params:
            pname = p.get('name')
            matched = None
            for pn in param_nodes:
                prop_name = pn.get('properties', {}).get('name')
                if prop_name == pname and pn['id'] not in assigned:
                    matched = pn
                    break
            if matched:
                local_var_names[matched['id']] = pname
                assigned.add(matched['id'])

        # any remaining param nodes assign by order
        pi = 0
        for pn in param_nodes:
            if pn['id'] in assigned:
                continue
            if pi < len(params):
                local_var_names[pn['id']] = params[pi].get('name')
                pi += 1
            else:
                # give it a generated name
                local_var_names[pn['id']] = local_make_var(pn['id'])

        # topological order for function nodes
        try:
            ordered = topological_sort(nodes, edges)
        except ValidationError:
            ordered = nodes
            self.code_lines.append(self.indent() + '// Warning: topological sort failed inside function, using graph order')

        for n in ordered:
            nid = n['id']
            ntype = n['type']
            start = len(self.code_lines) + 1
            if ntype == 'Param':
                # already mapped
                if nid not in local_var_names:
                    local_var_names[nid] = local_make_var(nid)
                # Params don't emit code
                end = len(self.code_lines)
                self.record_map(nid, start, end, function=name)
                continue
            if ntype == 'Literal':
                val = n.get('properties', {}).get('value')
                if isinstance(val, str):
                    ctype = 'std::string'
                    lit = f'"{self.escape_string(val)}"'
                    self.includes.add('<string>')
                elif isinstance(val, int) or isinstance(val, float):
                    ctype = 'double'
                    lit = str(val)
                else:
                    ctype = 'auto'
                    lit = str(val)
                var = local_make_var(nid)
                local_var_names[nid] = var
                fragments = [ {'text': self.indent() + f"{ctype} {var} = "}, {'text': lit, 'marker': {'node_id': nid, 'port': 'out'}}, {'text': ';'} ]
                self.emit_line_with_fragments(fragments, function=name)
            elif ntype == 'Cast':
                # Cast node inside function
                target = n.get('properties', {}).get('targetType', 'double')
                in_src = self._resolve_input_for_node(n, 'in', 0, local_incoming_map, local_incoming_list)
                in_expr = local_var_names.get(in_src, in_src if in_src else '0')
                out_var = local_make_var(nid)
                local_var_names[nid] = out_var
                # choose cast emission
                tgt = self.cpp_type(target)
                if _canonical_type(target) in ('double', 'int'):
                    expr = f"static_cast<{tgt}>({in_expr})"
                elif _canonical_type(target) == 'string':
                    self.includes.add('<string>')
                    expr = f"std::to_string({in_expr})"
                else:
                    expr = f"static_cast<{tgt}>({in_expr})"
                frags = [ {'text': self.indent() + f"{tgt} {out_var} = "}, {'text': expr, 'marker': {'node_id': nid, 'port': 'in'}}, {'text': ';'} ]
                self.emit_line_with_fragments(frags, function=name)
            elif ntype in ('Add', 'Sub', 'Mul', 'Div'):
                # Determine inputs by ports if available, else positional
                tdef = self.node_defs.get(ntype, {})
                input_ports = tdef.get('inputs', [])
                a_src = None
                b_src = None
                a_port = None
                b_port = None
                # try to resolve by port name
                if input_ports and len(input_ports) >= 2:
                    a_name = input_ports[0].get('name')
                    b_name = input_ports[1].get('name')
                    a_src = self._resolve_input_for_node(n, a_name, 0, local_incoming_map, local_incoming_list)
                    b_src = self._resolve_input_for_node(n, b_name, 1, local_incoming_map, local_incoming_list)
                    a_port = a_name
                    b_port = b_name
                # fallback positional
                if a_src is None:
                    a_src = self._resolve_input_for_node(n, None, 0, local_incoming_map, local_incoming_list)
                if b_src is None:
                    b_src = self._resolve_input_for_node(n, None, 1, local_incoming_map, local_incoming_list)
                a = local_var_names.get(a_src, a_src if a_src else '0')
                b = local_var_names.get(b_src, b_src if b_src else '0')
                op = {'Add': '+', 'Sub': '-', 'Mul': '*', 'Div': '/'}[ntype]
                var = local_make_var(nid)
                local_var_names[nid] = var
                # build fragments: indent + declaration + operand a (marker) + op + operand b (marker) + semicolon
                fragments = [
                    {'text': self.indent() + f"double {var} = "},
                    {'text': a, 'marker': {'node_id': nid, 'port': a_port or 'a'}},
                    {'text': f" {op} "},
                    {'text': b, 'marker': {'node_id': nid, 'port': b_port or 'b'}},
                    {'text': ';'}
                ]
                self.emit_line_with_fragments(fragments, function=name)
            else:
                # external or unknown
                ddef = self.node_defs.get(ntype, {})
                lib = ddef.get('lib')
                # resolve inputs
                inputs = n.get('inputs', [])
                input_vars = []
                # try port-aware resolution if node_defs has inputs
                defs_inputs = ddef.get('inputs', [])
                if defs_inputs:
                    for idx, p in enumerate(defs_inputs):
                        pname = p.get('name')
                        src = self._resolve_input_for_node(n, pname, idx, local_incoming_map, local_incoming_list)
                        if src is None:
                            src = self._resolve_input_for_node(n, None, idx, local_incoming_map, local_incoming_list)
                        input_vars.append(local_var_names.get(src, src if src else '0'))
                else:
                    # fallback to positional list
                    for idx, src in enumerate(inputs):
                        input_vars.append(local_var_names.get(src, src if src else '0'))

                if lib:
                    fn_name = lib.get('name')
                    out_var = local_make_var(nid)
                    local_var_names[nid] = out_var
                    returns = ddef.get('outputs', [])
                    if returns:
                        out_type = self.cpp_type(returns[0].get('type'))
                    else:
                        out_type = 'double'
                    # build fragments for function call with marker fragments for each arg
                    frags = [ {'text': self.indent() + f"{out_type} {out_var} = {fn_name}("} ]
                    for idx, p in enumerate(defs_inputs):
                        pname = p.get('name')
                        expr = input_vars[idx] if idx < len(input_vars) else '0'
                        if idx > 0:
                            frags.append({'text': ', '})
                        frags.append({'text': expr, 'marker': {'node_id': nid, 'port': pname}})
                    frags.append({'text': ');'})
                    self.emit_line_with_fragments(frags, function=name)
                else:
                    fragments = [{'text': self.indent() + f"// Unhandled node {nid} of type {ntype} inside function", 'marker': {'node_id': nid, 'port': None}}]
                    self.emit_line_with_fragments(fragments, function=name)
            end = len(self.code_lines)
            self.record_map(nid, start, end, function=name)

        # emit return statement
        ret_id = graph.get('return')
        if return_type and return_type != 'void':
            if not ret_id:
                # no return specified: attempt to use last computed
                # find last non-param node
                last = None
                for n in reversed(ordered):
                    if n.get('type') != 'Param':
                        last = n
                        break
                if last:
                    ret_id = last['id']
            ret_expr = local_var_names.get(ret_id, ret_id if ret_id else '0')
            fragments = [ {'text': self.indent() + f"return "}, {'text': ret_expr, 'marker': {'node_id': f"{name}::return", 'port': 'value'}}, {'text': ';'} ]
            self.emit_line_with_fragments(fragments, function=name)
            # record return mapping under function-level special node
            start = len(self.code_lines)
            end = len(self.code_lines)
            self.record_map(f"{name}::return", start, end, function=name)
        self.indent_level -= 1
        self.code_lines.append('}')
        self.code_lines.append('')

    def emit_from_graph(self):
        nodes_map = {n['id']: n for n in self.ir.get('nodes', [])}
        nodes_list = list(nodes_map.values())
        try:
            ordered = topological_sort(nodes_list, self.ir.get('edges', []))
        except ValidationError:
            # Fallback: use insertion order but warn via comment
            self.code_lines.append(self.indent() + '// Warning: topological sort failed, using graph order')
            ordered = nodes_list

        def wrap_expr_for_port(nid: str, port: str, expr: str) -> str:
            return expr

        for n in ordered:
            nid = n['id']
            ntype = n['type']
            self.ensure_lib_includes(ntype)
            start = len(self.code_lines) + 1
            if ntype == 'Literal':
                val = n.get('properties', {}).get('value')
                # infer type
                if isinstance(val, str):
                    ctype = 'std::string'
                    lit = f'"{self.escape_string(val)}"'
                    self.includes.add('<string>')
                elif isinstance(val, int) or isinstance(val, float):
                    ctype = 'double'
                    lit = str(val)
                else:
                    ctype = 'auto'
                    lit = str(val)
                var = self.make_var(nid)
                self.var_names[nid] = var
                fragments = [ {'text': self.indent() + f"{ctype} {var} = "}, {'text': lit, 'marker': {'node_id': nid, 'port': 'out'}}, {'text': ';'} ]
                self.emit_line_with_fragments(fragments, function=name)
            elif ntype in ('Add', 'Sub', 'Mul', 'Div'):
                tdef = self.node_defs.get(ntype, {})
                input_ports = tdef.get('inputs', [])
                # resolve by ports if possible
                a_src = None
                b_src = None
                a_port = None
                b_port = None
                if input_ports and len(input_ports) >= 2:
                    a_name = input_ports[0].get('name')
                    b_name = input_ports[1].get('name')
                    a_src = self._resolve_input_for_node(n, a_name, 0)
                    b_src = self._resolve_input_for_node(n, b_name, 1)
                    a_port = a_name
                    b_port = b_name
                if a_src is None:
                    a_src = self._resolve_input_for_node(n, None, 0)
                if b_src is None:
                    b_src = self._resolve_input_for_node(n, None, 1)
                a = self.var_names.get(a_src, a_src if a_src else '0')
                b = self.var_names.get(b_src, b_src if b_src else '0')
                op = {'Add': '+', 'Sub': '-', 'Mul': '*', 'Div': '/'}[ntype]
                var = self.make_var(nid)
                self.var_names[nid] = var
                fragments = [
                    {'text': self.indent() + f"double {var} = "},
                    {'text': a, 'marker': {'node_id': nid, 'port': a_port or 'a'}},
                    {'text': f" {op} "},
                    {'text': b, 'marker': {'node_id': nid, 'port': b_port or 'b'}},
                    {'text': ';'}
                ]
                self.emit_line_with_fragments(fragments, function=None)
            elif ntype == 'Print':
                # resolve input value by named port or positional
                tdef = self.node_defs.get('Print', {})
                input_ports = tdef.get('inputs', [])
                src_id = None
                src_port = None
                if input_ports and len(input_ports) >= 1:
                    pname = input_ports[0].get('name')
                    src_id = self._resolve_input_for_node(n, pname, 0)
                    src_port = pname
                if src_id is None:
                    src_id = self._resolve_input_for_node(n, None, 0)
                if not src_id:
                    self.code_lines.append(self.indent() + f"// Print node {nid} has no input")
                    end = len(self.code_lines)
                    self.record_map(nid, start, end, function=None)
                    continue
                src = self.var_names.get(src_id, None)
                if src is None:
                    src = '\"\"'
                fragments = [
                    {'text': self.indent() + 'std::cout << '},
                    {'text': src, 'marker': {'node_id': nid, 'port': src_port or 'value'}},
                    {'text': ' << std::endl;'}
                ]
                self.emit_line_with_fragments(fragments, function=None)
            elif ntype == 'Cast':
                target = n.get('properties', {}).get('targetType', 'double')
                in_src = self._resolve_input_for_node(n, 'in', 0)
                in_expr = self.var_names.get(in_src, in_src if in_src else '0')
                out_var = self.make_var(nid)
                self.var_names[nid] = out_var
                tgt = self.cpp_type(target)
                if _canonical_type(target) in ('double', 'int'):
                    expr = f"static_cast<{tgt}>({in_expr})"
                elif _canonical_type(target) == 'string':
                    self.includes.add('<string>')
                    expr = f"std::to_string({in_expr})"
                else:
                    expr = f"static_cast<{tgt}>({in_expr})"
                frags = [ {'text': self.indent() + f"{tgt} {out_var} = "}, {'text': expr, 'marker': {'node_id': nid, 'port': 'in'}}, {'text': ';'} ]
                self.emit_line_with_fragments(frags, function=None)
            elif ntype == 'Call':
                props = n.get('properties', {})
                fname = props.get('name')
                # find function signature in IR
                functions = {f['name']: f for f in self.ir.get('functions', [])}
                fdef = functions.get(fname)
                # resolve args using function param names if available
                wrapped_args = []
                if fdef:
                    params = fdef.get('params', [])
                    for idx, p in enumerate(params):
                        pname = p.get('name')
                        src = self._resolve_input_for_node(n, pname, idx)
                        if src is None:
                            src = self._resolve_input_for_node(n, None, idx)
                        expr = self.var_names.get(src, src if src else '0')
                        wrapped_args.append((pname, expr))
                else:
                    for idx, src in enumerate(n.get('inputs', [])):
                        expr = self.var_names.get(src, src)
                        wrapped_args.append((f'arg{idx}', expr))

                out_var = self.make_var(nid)
                self.var_names[nid] = out_var
                if fdef:
                    ret_type = fdef.get('returnType', 'number')
                    cpp_ret = self.cpp_type(ret_type)
                else:
                    cpp_ret = 'auto'
                # build fragments
                frags = [ {'text': self.indent() + f"{cpp_ret} {out_var} = {fname}("} ]
                for i, (pname, expr) in enumerate(wrapped_args):
                    if i > 0:
                        frags.append({'text': ', '})
                    frags.append({'text': expr, 'marker': {'node_id': nid, 'port': pname}})
                frags.append({'text': ');'})
                self.emit_line_with_fragments(frags, function=None)
            else:
                # external or unknown node: try to map via node_defs
                ddef = self.node_defs.get(n.get('type'), {})
                lib = ddef.get('lib')
                defs_inputs = ddef.get('inputs', [])
                wrapped_args = []
                if defs_inputs:
                    for idx, p in enumerate(defs_inputs):
                        pname = p.get('name')
                        src = self._resolve_input_for_node(n, pname, idx)
                        if src is None:
                            src = self._resolve_input_for_node(n, None, idx)
                        expr = self.var_names.get(src, src if src else '0')
                        wrapped_args.append((pname, expr))
                else:
                    for idx, src in enumerate(n.get('inputs', [])):
                        expr = self.var_names.get(src, src)
                        wrapped_args.append((f'arg{idx}', expr))
                if lib:
                    fn_name = lib.get('name')
                    out_var = self.make_var(nid)
                    self.var_names[nid] = out_var
                    returns = ddef.get('outputs', [])
                    if returns:
                        out_type = self.cpp_type(returns[0].get('type'))
                    else:
                        out_type = 'double'
                    frags = [ {'text': self.indent() + f"{out_type} {out_var} = {fn_name}("} ]
                    for i, (pname, expr) in enumerate(wrapped_args):
                        if i > 0:
                            frags.append({'text': ', '})
                        frags.append({'text': expr, 'marker': {'node_id': nid, 'port': pname}})
                    frags.append({'text': ');'})
                    self.emit_line_with_fragments(frags, function=None)
                else:
                    self.code_lines.append(self.indent() + f"// Unhandled node {nid} of type {ntype}")
            end = len(self.code_lines)
            self.record_map(nid, start, end, function=None)

    def emit_main(self):
        self.code_lines.append("int main() {")
        self.indent_level += 1
        self.emit_from_graph()
        self.code_lines.append(self.indent() + "return 0;")
        self.indent_level -= 1
        self.code_lines.append("}")

    def emit(self) -> str:
        # include lib headers from functions and nodes
        for f in self.ir.get('functions', []):
            # collect node types in function graph
            for n in f.get('graph', {}).get('nodes', []):
                self.ensure_lib_includes(n.get('type'))
        for n in self.ir.get('nodes', []):
            self.ensure_lib_includes(n.get('type'))

        # ensure iostream included
        if not any('iostream' in inc for inc in self.includes):
            self.includes.add("<iostream>")

        self.emit_include()

        # emit functions
        for f in self.ir.get('functions', []):
            self.emit_function_def(f)

        # emit main
        self.emit_main()

        # finalize mapping columns & port entries
        self._finalize_mappings()

        return "\n".join(self.code_lines)


if __name__ == '__main__':
    import sys
    if len(sys.argv) < 2:
        print("Usage: cpp_emitter.py ir.json [node_defs.json]")
        sys.exit(1)
    ir = json.load(open(sys.argv[1]))
    node_defs = {}
    if len(sys.argv) >= 3 and os.path.exists(sys.argv[2]):
        node_defs = json.load(open(sys.argv[2]))
    emitter = CppEmitter(ir, node_defs)
    print(emitter.emit())
