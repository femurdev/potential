// Simplified, robust CppEmitter
const fs = require('fs');
const path = require('path');

function loadRegistry(regPath) {
  try { return JSON.parse(fs.readFileSync(regPath, 'utf8')); } catch (e) { return {}; }
}

function loadPlugins(pluginsDir) {
  const plugins = {};
  try {
    const files = fs.readdirSync(pluginsDir);
    files.forEach(f => {
      if (!f.endsWith('.json')) return;
      try {
        const p = JSON.parse(fs.readFileSync(path.join(pluginsDir, f), 'utf8'));
        const key = p.nodeType || p.name;
        plugins[key] = p;
      } catch (e) {
        console.warn('Failed to load plugin', f, e && e.message);
      }
    });
  } catch (e) {}
  return plugins;
}

function buildEdgeMaps(nodes, edges) {
  const incoming = {}, outgoing = {}, incomingByPort = {};
  (nodes || []).forEach(n => { incoming[n.id] = []; outgoing[n.id] = []; incomingByPort[n.id] = {}; });
  (edges || []).forEach(e => {
    const from = e.from || e.fromNode || e.fromId;
    const to = e.to || e.toNode || e.toId;
    const kind = e.kind || 'data';
    const toPort = e.toPort || e.toPortName || e.inPort;
    if (kind === 'data') {
      if (!incoming[to]) incoming[to] = [];
      incoming[to].push(from);
      if (!outgoing[from]) outgoing[from] = [];
      outgoing[from].push(to);
      if (toPort) incomingByPort[to][toPort] = from;
    }
  });
  return { incoming, outgoing, incomingByPort };
}

function topologicalSort(nodes, edges) {
  const ids = (nodes || []).map(n => n.id);
  const inDegree = {}, adj = {};
  ids.forEach(id => { inDegree[id] = 0; adj[id] = []; });
  (edges || []).forEach(e => {
    const from = e.from || e.fromNode || e.fromId;
    const to = e.to || e.toNode || e.toId;
    const kind = e.kind || 'data';
    if (kind === 'data' && adj[from] !== undefined) { adj[from].push(to); inDegree[to] = (inDegree[to]||0)+1; }
  });
  const queue = ids.filter(id => !inDegree[id]);
  queue.sort();
  const order = [];
  while (queue.length) {
    const u = queue.shift(); order.push(u);
    (adj[u]||[]).forEach(v => { inDegree[v] -= 1; if (inDegree[v] === 0) queue.push(v); });
  }
  if (order.length !== ids.length) {
    return { order: ids.slice(), cycle: true };
  }
  return { order, cycle: false };
}

function sanitizeId(id) {
  if (!id) return '_';
  let s = String(id).replace(/[^A-Za-z0-9_]/g, '_');
  if (!/^[A-Za-z_]/.test(s)) s = '_' + s;
  return s;
}

function buildSymbolMap(nodes, prefix) {
  prefix = prefix || '';
  const used = new Set();
  const map = {};
  (nodes || []).forEach(n => {
    const id = (n && n.id) || '';
    let base = prefix + 'v_' + sanitizeId(id);
    if (!/^[A-Za-z_]/.test(base)) base = '_' + base;
    let name = base;
    let i = 1;
    while (used.has(name)) { name = base + '_' + (i++); }
    used.add(name);
    map[id] = name;
  });
  return map;
}

function collectControlAdj(nodes, edges) {
  const controlAdj = {};
  (nodes||[]).forEach(n => controlAdj[n.id] = []);
  (edges||[]).forEach(e => {
    const kind = e.kind || 'data';
    if (kind !== 'control') return;
    const from = e.from || e.fromNode || e.fromId;
    const to = e.to || e.toNode || e.toId;
    const toPort = e.toPort || e.toPortName || e.inPort;
    if (controlAdj[from]) controlAdj[from].push({ to, toPort });
  });
  return controlAdj;
}

function collectDataPredecessors(startId, edges) {
  const preds = new Set();
  const incomingMap = {};
  (edges||[]).forEach(e => { const from = e.from || e.fromNode || e.fromId; const to = e.to || e.toNode || e.toId; const kind = e.kind || 'data'; if (kind === 'data') { incomingMap[to] = incomingMap[to] || []; incomingMap[to].push(from); } });
  const stack = [startId];
  while (stack.length) {
    const u = stack.pop();
    if (preds.has(u)) continue;
    preds.add(u);
    const ins = incomingMap[u]||[];
    ins.forEach(p=> stack.push(p));
  }
  return Array.from(preds);
}

function collectControlSubgraph(start, controlAdj) {
  const visited = new Set(); const stack = [start];
  while (stack.length) { const u = stack.pop(); if (visited.has(u)) continue; visited.add(u); (controlAdj[u]||[]).forEach(edge => { if (!visited.has(edge.to)) stack.push(edge.to); }); }
  return Array.from(visited);
}

function collectIncludes(ir, registry, plugins, nodes) {
  const inc = new Set(ir.imports || []);
  (nodes||[]).forEach(n => { const reg = registry[n.type] || plugins[n.type]; if (reg && reg.include) inc.add(reg.include); });
  if ((nodes||[]).some(n => n.type === 'Print')) inc.add('<iostream>');
  if ((nodes||[]).some(n => n.type === 'Literal' && typeof(n.props && n.props.value) === 'string')) inc.add('<string>');
  return Array.from(inc);
}

function emitGraph(nodes, edges, registry, plugins, varNamePrefix, emittedSet, state) {
  state = state || {};
  varNamePrefix = varNamePrefix || '';
  const lines = [];
  const nodeById = {};
  (nodes||[]).forEach(n => nodeById[n.id] = n);
  const symbolMap = state.symbolMap || buildSymbolMap(nodes, varNamePrefix);
  const varName = id => symbolMap[id] || (varNamePrefix + 'v_' + sanitizeId(id));
  const { incoming, incomingByPort } = buildEdgeMaps(nodes, edges);
  const topo = topologicalSort(nodes, edges);
  let hasReturn = false;

  const order = topo.order;
  if (topo.cycle) lines.push('    // Warning: data dependency cycle detected, emitting in source order');

  for (const id of order) {
    if (emittedSet && emittedSet.has(id)) continue;
    const n = nodeById[id]; if (!n) continue;
    lines.push('    // node:' + id);
    if (n.type === 'Literal' || n.type === 'Const') {
      const val = (n.props && n.props.value) || (n.params && n.params.value);
      if (typeof val === 'string') lines.push('    std::string ' + varName(id) + ' = ' + JSON.stringify(val) + ';');
      else if (typeof val === 'boolean') lines.push('    bool ' + varName(id) + ' = ' + (val ? 'true' : 'false') + ';');
      else if (Number.isInteger(val)) lines.push('    int ' + varName(id) + ' = ' + JSON.stringify(val) + ';');
      else lines.push('    double ' + varName(id) + ' = ' + JSON.stringify(val || 0) + ';');
      if (emittedSet) emittedSet.add(id);
      continue;
    }
    if (n.type === 'VarDecl') {
      const vname = (n.props && n.props.varName) || id;
      const symbol = 'var_' + sanitizeId(vname);
      state.varSymbols = state.varSymbols || {};
      state.varSymbols[vname] = symbol;
      const vtype = cppTypeFrom((n.props && n.props.varType) || 'int');
      if (n.props && n.props.initialValue !== undefined) lines.push('    ' + vtype + ' ' + symbol + ' = ' + JSON.stringify(n.props.initialValue) + ';');
      else lines.push('    ' + vtype + ' ' + symbol + ' = 0;');
      if (emittedSet) emittedSet.add(id);
      continue;
    }
    if (n.type === 'VarSet') {
      const vname = (n.props && n.props.varName);
      const symbol = (state.varSymbols && state.varSymbols[vname]) || ('var_' + sanitizeId(vname));
      const ins = incoming[n.id] || [];
      const valExpr = ins[0] ? varName(ins[0]) : '0';
      lines.push('    ' + symbol + ' = ' + valExpr + ';');
      if (emittedSet) emittedSet.add(id);
      continue;
    }
    if (n.type === 'VarGet') {
      const vname = (n.props && n.props.varName);
      const symbol = (state.varSymbols && state.varSymbols[vname]) || ('var_' + sanitizeId(vname));
      lines.push('    auto ' + varName(id) + ' = ' + symbol + ';');
      if (emittedSet) emittedSet.add(id);
      continue;
    }
    if (n.type === 'Arg') {
      // Arg: parameter placeholder - rely on function-level symbolMap to map this Arg node id to the parameter name
      const pname = (state && state.symbolMap && state.symbolMap[id]) || (n.props && n.props.name) || (n.params && n.params.name);
      if (!pname) {
        // no parameter mapping found; emit a placeholder comment so downstream knows this arg is present
        lines.push('    // Arg node ' + id + ' has no parameter name');
      }
      if (emittedSet) emittedSet.add(id);
      continue;
    }

    if (n.type === 'Return') {
      const ins = incoming[n.id] || [];
      const expr = ins[0] ? varName(ins[0]) : '0';
      lines.push('    return ' + expr + ';');
      if (emittedSet) emittedSet.add(id);
      // indicate hasReturn via state if provided (caller may inspect)
      // we cannot set an outer variable here; caller reads returned res.hasReturn
      continue;
    }

    if (n.type === 'Print') {
      const insBy = incomingByPort[n.id] || {};
      const parts = [];
      const inputs = Array.isArray(n.inputs) ? n.inputs.map(i=>i.name) : Object.keys(insBy);
      if (inputs && inputs.length) {
        inputs.forEach(k => { const src = insBy[k] || (incoming[n.id]||[])[0]; if (src) parts.push(varName(src)); });
      } else {
        (incoming[n.id]||[]).forEach(src => parts.push(varName(src)));
      }
      if (parts.length) {
        let out = '    std::cout';
        parts.forEach((p, idx) => { out += ' << ' + p + (idx<parts.length-1 ? ' << " "' : ''); });
        out += ' << std::endl;';
        lines.push(out);
      } else if (n.props && typeof n.props.text === 'string') {
        lines.push('    std::cout << ' + JSON.stringify(n.props.text) + ' << std::endl;');
      } else lines.push('    // Print node ' + n.id + ' has no inputs');
      if (emittedSet) emittedSet.add(id);
      continue;
    }
    if (['Add','Sub','Mul','Div','LessThan'].includes(n.type)) {
      const ins = incoming[n.id] || [];
      const a = ins[0] ? varName(ins[0]) : '0';
      const b = ins[1] ? varName(ins[1]) : '0';
      if (n.type === 'LessThan') lines.push('    bool ' + varName(id) + ' = ' + a + ' < ' + b + ';');
      else {
        const op = n.type === 'Add' ? '+' : n.type === 'Sub' ? '-' : n.type === 'Mul' ? '*' : '/';
        lines.push('    double ' + varName(id) + ' = ' + a + ' ' + op + ' ' + b + ';');
      }
      if (emittedSet) emittedSet.add(id);
      continue;
    }
    if (n.type === 'Call' || n.type === 'CallFunction' || n.type === 'CallFunc') {
      const fn = (n.params && (n.params.functionName || n.params.name)) || (n.props && (n.props.functionName || n.props.target || n.props.name)) || n.props && n.props.name || n.type;
      const insBy = incomingByPort[n.id] || {};
      const args = [];
      if (n.inputs && n.inputs.length) {
        n.inputs.forEach(p => { const src = insBy[p.name] || (incoming[n.id]||[]).shift(); args.push(src ? varName(src) : '/*missing*/'); });
      } else {
        (incoming[n.id]||[]).forEach(s => args.push(varName(s)));
      }
      const call = fn + '(' + args.join(', ') + ')';
      // Decide whether the callee returns void (use functionReturnTypes if available)
      const fnRet = (typeof functionReturnTypes !== 'undefined' && functionReturnTypes[fn]) ? functionReturnTypes[fn] : undefined;
      if (fnRet === 'void') {
        lines.push('    ' + call + ';');
      } else {
        lines.push('    auto ' + varName(id) + ' = ' + call + ';');
      }
      if (emittedSet) emittedSet.add(id);
      continue;
    }
    // default: unhandled
    lines.push('    // Unhandled node type in graph: ' + n.type + ' (id=' + n.id + ')');
    if (emittedSet) emittedSet.add(id);
  }
  return { code: lines.join('\n'), hasReturn: hasReturn };
}

function cppTypeFrom(vtype) {
  if (!vtype) return 'double';
  if (vtype === 'string') return 'std::string';
  return vtype;
}

function emit(ir, registry, plugins) {
  const nodes = ir.nodes || [];
  const edges = ir.edges || [];
  const nodesMap = {};
  nodes.forEach(n => nodesMap[n.id] = n);
  const includes = collectIncludes(ir, registry, plugins, nodes);
  let outLines = [];
  includes.forEach(i => outLines.push('#include ' + i));
  outLines.push('');
  outLines.push('using namespace std;');
  outLines.push('');
  const controlAdj = collectControlAdj(nodes, edges);
  // Build function return type map for callsite emission decisions
  const functionReturnTypes = {};
  (ir.functions||[]).forEach(f=>{ const g = f.graph || { nodes: [], edges: [] }; const hasReturnNode = (g.nodes||[]).some(n=>n.type==='Return'); let r = 'void'; if (f.returns && f.returns.type) r = cppTypeFrom(f.returns.type); else if (f.signature && typeof f.signature === 'string' && f.signature.trim().length) { try { const ms = f.signature.trim().match(/^\s*([A-Za-z0-9_:\\<\\>]+)/); if (ms && ms[1]) r = cppTypeFrom(ms[1]); } catch(e){} } else if (hasReturnNode) r = 'int'; functionReturnTypes[f.name]=r; });


  // Emit functions
  (ir.functions||[]).forEach(f => {

    const fname = f.name;
    let retType = 'void';
    let paramsList = '';
    const hasReturnNode = (g.nodes||[]).some(n=>n.type==='Return');
    if (f.returns && f.returns.type) retType = cppTypeFrom(f.returns.type);
    if (f.signature && typeof f.signature === 'string' && f.signature.trim().length) {
      // parse return type from signature if possible
      try { const ms = f.signature.trim().match(/^\s*([A-Za-z0-9_\:\<\>]+)/); if (ms && ms[1]) retType = cppTypeFrom(ms[1]); } catch(e) {}
    } else if (hasReturnNode && (!f.returns || !f.returns.type)) {
      retType = 'int';
    }
    if (f.params && Array.isArray(f.params) && f.params.length) paramsList = f.params.map(p => cppTypeFrom(p.type||'double') + ' ' + p.name).join(', ');
    if (f.signature && typeof f.signature === 'string' && f.signature.trim().length) {
      outLines.push(f.signature + ' {');
    } else {
      outLines.push(retType + ' ' + fname + '(' + paramsList + ') {');
    }
    const funcState = { symbolMap: buildSymbolMap(g.nodes||[], fname + '_') };
    // map Arg nodes to parameter names if present
    if (f.params && Array.isArray(f.params) && f.params.length) {
      const paramNames = f.params.map(p=>p.name);
      (g.nodes||[]).forEach(n=>{ const aname = (n.props && n.props.name) || (n.params && n.params.name); if (n.type === 'Arg' && aname) { const pname = aname; if (paramNames.includes(pname)) { funcState.symbolMap[n.id] = pname; } } });
    }
    const res = emitGraph(g.nodes||[], g.edges||[], registry, plugins, fname + '_', new Set(), funcState);
    // Postprocess emitted function code to replace prefixed arg temporaries with parameter names if mapped
    let funcCode = res.code;
    Object.keys(funcState.symbolMap||{}).forEach(k=>{ const mapped = funcState.symbolMap[k]; if (mapped && mapped !== (fname + '_v_' + k)) { const pref = (fname + '_v_' + sanitizeId(k)); funcCode = funcCode.split(pref).join(mapped); } });
    outLines.push(funcCode);
    outLines.push('    return (' + retType + ')0;');
    outLines.push('}');
    outLines.push('');
  });

  // Emit main data nodes
  outLines.push('int main() {');
  const emittedMain = new Set();
  // compute data nodes excluding control nodes
  const controlNodesAll = new Set();
  Object.keys(controlAdj).forEach(src => controlAdj[src].forEach(edge => { const sub = collectControlSubgraph(edge.to, controlAdj); sub.forEach(id => controlNodesAll.add(id)); }));
  const dataNodes = nodes.filter(n => !controlNodesAll.has(n.id));
  const res = emitGraph(dataNodes, edges, registry, plugins, '', emittedMain, {});
  outLines.push(res.code);

  // Simple control handling: emit If/While using existing variables
  nodes.forEach(n => {
    if (n.type === 'If') {
      const incomingMap = buildEdgeMaps(nodes, edges).incoming;
      const condIns = incomingMap[n.id] || [];
      const condVar = condIns[0] ? (buildSymbolMap(nodes, '')[condIns[0]] || ('v_' + sanitizeId(condIns[0]))) : 'false';
      outLines.push('    if (' + condVar + ') {');
      const targets = controlAdj[n.id] || [];
      const thenTarget = targets[0] && targets[0].to;
      if (thenTarget) {
        const bodyCode = emitControlBody(thenTarget, controlAdj, nodesMap, edges, registry, plugins, emittedMain, '');
        outLines.push(bodyCode);
      }
      outLines.push('    }');
    } else if (n.type === 'While') {
      const incomingMap = buildEdgeMaps(nodes, edges).incoming;
      const condIns = incomingMap[n.id] || [];
      const condVar = condIns[0] ? (buildSymbolMap(nodes, '')[condIns[0]] || ('v_' + sanitizeId(condIns[0]))) : 'false';
      // Emit a guarded loop to prevent infinite loops during testing (max iterations guard)
      outLines.push('    {');
      outLines.push('      int __loop_guard = 0;');
      outLines.push('      while ((' + condVar + ') && (++__loop_guard < 100000)) {');
      const targets = controlAdj[n.id] || [];
      const bodyTarget = targets[0] && targets[0].to;
      if (bodyTarget) {
        const bodyCode = emitControlBody(bodyTarget, controlAdj, nodesMap, edges, registry, plugins, emittedMain, '');
        outLines.push(bodyCode);
      }
      outLines.push('      }');
      outLines.push('    }');
    }
  });

  outLines.push('    return 0;');
  outLines.push('}');
  return outLines.join('\n');
}

function emitControlBody(startId, controlAdj, nodesMap, edges, registry, plugins, emitted, varNamePrefix) {
  const controlNodes = collectControlSubgraph(startId, controlAdj);
  const subNodes = controlNodes.map(id => nodesMap[id]).filter(n => n !== undefined);
  const subEdges = (edges || []).filter(e => { const from = e.from || e.fromNode || e.fromId; const to = e.to || e.toNode || e.toId; return controlNodes.includes(from) || controlNodes.includes(to) || (from && to && controlNodes.includes(from) && controlNodes.includes(to)); });
  const funcState = { symbolMap: buildSymbolMap(subNodes, varNamePrefix) };
  const res = emitGraph(subNodes, subEdges, registry, plugins, varNamePrefix, emitted, funcState);
  return res.code;
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error('Usage: node cpp_emitter.js <ir.json>'); process.exit(2); }
  const ir = JSON.parse(fs.readFileSync(file, 'utf8'));
  const registry = loadRegistry(path.join(__dirname, 'lib_registry.json'));
  const plugins = loadPlugins(path.join(__dirname, '..', 'plugins'));
  try {
    const cpp = emit(ir, registry, plugins);
    console.log(cpp);
    try {
      const mapping = buildSymbolMap((ir.nodes||[]), '');
      const outMapPath = path.join(process.cwd(), path.basename(file).replace(/\.json$/,'') + '.cpp.map.json');
      fs.writeFileSync(outMapPath, JSON.stringify(mapping, null, 2), 'utf8');
      console.error('Wrote node->symbol map to ' + outMapPath);
    } catch (e) { console.error('Failed to write mapping file:', e && e.message); }
  } catch (e) { console.error('Emitter error:', e && e.message); process.exit(1); }
}

module.exports = { emit };
