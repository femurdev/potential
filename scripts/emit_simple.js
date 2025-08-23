
// Very small JS emitter supporting Const, Add, Print
function emitCpp(graph) {
  const includes = new Set();
  if (Array.isArray(graph.imports)) graph.imports.forEach(i=>includes.add(i));

  // simple edge lookup
  const edgesByDest = new Map();
  for (const e of graph.edges || []) {
    const key = `${e.toNode}:${e.toPort}`;
    if (!edgesByDest.has(key)) edgesByDest.set(key, []);
    edgesByDest.get(key).push(e);
  }

  // Simple validation: ensure required inputs are connected or have defaults
  for (const node of graph.nodes || []) {
    for (const inp of node.inputs || []) {
      const key = `${node.id}:${inp.name}`;
      const incoming = edgesByDest.get(key) || [];
      const hasDefault = node.params && (node.params[inp.name] !== undefined || node.params.value !== undefined);
      if (incoming.length === 0 && !hasDefault) {
        throw new Error(`Unconnected required input '${inp.name}' on node ${node.id}`);
      }
    }
  }

  const symbolTable = new Map();
  let tmp = 0;
  function newTmp(pfx){ tmp++; return `${pfx}_${tmp}` }

  const lines = [];

  function resolveInput(node, name) {
    const key = `${node.id}:${name}`;
    const inc = edgesByDest.get(key) || [];
    if (inc.length>0) {
      const e = inc[0];
      const sym = symbolTable.get(`${e.fromNode}:${e.fromPort}`);
      if (sym) return sym;
      const fromNode = graph.nodes.find(n=>n.id===e.fromNode);
      if (fromNode && fromNode.params && fromNode.params.value!==undefined) return JSON.stringify(fromNode.params.value);
      return '0';
    }
    if (node.params && node.params[name]!==undefined) return JSON.stringify(node.params[name]);
    return '0';
  }

  for (const node of graph.nodes || []) {
    if (node.type === 'Const') {
      const out = (node.outputs && node.outputs[0] && node.outputs[0].name) || 'out';
      const v = node.params && node.params.value;
      const varName = newTmp('const');
      if (typeof v === 'string') { includes.add('<string>'); lines.push(`auto ${varName} = std::string(${JSON.stringify(v)});`); }
      else lines.push(`auto ${varName} = ${JSON.stringify(v)};`);
      symbolTable.set(`${node.id}:${out}`, varName);
    } else if (node.type === 'Add') {
      const a = resolveInput(node,'a');
      const b = resolveInput(node,'b');
      const varName = newTmp('add');
      lines.push(`auto ${varName} = (${a}) + (${b});`);
      const out = (node.outputs && node.outputs[0] && node.outputs[0].name) || 'out';
      symbolTable.set(`${node.id}:${out}`, varName);
    } else if (node.type === 'Print') {
      includes.add('<iostream>');
      const txt = resolveInput(node,'text');
      lines.push(`std::cout << ${txt} << std::endl;`);
    } else {
      lines.push(`// Unknown node type: ${node.type}`);
    }
  }

  const incText = Array.from(includes).map(i=>`#include ${i}`).join('\n');
  const body = lines.map(l=>'  '+l).join('\n');
  return `${incText}\n\nint main() {\n${body}\n  return 0;\n}\n`;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 1) { console.error('Usage: node emit_simple.js <graph.json> [out.cpp]'); process.exit(2); }
  const fs = require('fs');
  const graph = JSON.parse(fs.readFileSync(args[0],'utf8'));
  const out = args[1] || 'out.cpp';
  try {
    const code = emitCpp(graph);
    fs.writeFileSync(out, code,'utf8');
    console.log('Wrote', out);
  } catch (e) {
    console.error('Emitter error:', e.message);
    process.exit(1);
  }
}
