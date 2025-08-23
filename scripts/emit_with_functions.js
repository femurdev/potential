const fs = require('fs');
const path = require('path');

function emitCpp(graph) {
  const includes = new Set();
  if (Array.isArray(graph.imports)) graph.imports.forEach(i => includes.add(i));

  // helper to emit a graph into lines, returning lines and symbol table
  function emitGraphBody(g) {
    const lines = [];
    const edgesByDest = new Map();
    for (const e of g.edges || []) {
      const key = `${e.toNode}:${e.toPort}`;
      if (!edgesByDest.has(key)) edgesByDest.set(key, []);
      edgesByDest.get(key).push(e);
    }
    const symbolTable = new Map();
    let tmp = 0;
    function newTmp(pfx) { tmp++; return `${pfx}_${tmp}` }
    function resolveInput(node, name) {
      const key = `${node.id}:${name}`;
      const inc = edgesByDest.get(key) || [];
      if (inc.length > 0) {
        const e = inc[0];
        const sym = symbolTable.get(`${e.fromNode}:${e.fromPort}`);
        if (sym) return sym;
        const fromNode = (g.nodes || []).find(n => n.id === e.fromNode);
        if (fromNode && fromNode.params && fromNode.params.value !== undefined) return JSON.stringify(fromNode.params.value);
        return '0';
      }
      if (node.params && node.params[name] !== undefined) return JSON.stringify(node.params[name]);
      return '0';
    }

    for (const node of g.nodes || []) {
      switch (node.type) {
        case 'Const': {
          const out = (node.outputs && node.outputs[0] && node.outputs[0].name) || 'out';
          const v = node.params && node.params.value;
          const varName = newTmp('const');
          if (typeof v === 'string') { includes.add('<string>'); lines.push(`auto ${varName} = std::string(${JSON.stringify(v)});`); }
          else lines.push(`auto ${varName} = ${JSON.stringify(v)};`);
          symbolTable.set(`${node.id}:${out}`, varName);
          break;
        }
        case 'VarGet': {
          const name = node.params?.name || node.params?.var || 'v';
          const out = (node.outputs && node.outputs[0] && node.outputs[0].name) || 'out';
          const varName = newTmp('get');
          lines.push(`auto ${varName} = ${name};`);
          symbolTable.set(`${node.id}:${out}`, varName);
          break;
        }
        case 'Add': {
          const a = resolveInput(node, 'a');
          const b = resolveInput(node, 'b');
          const varName = newTmp('add');
          lines.push(`auto ${varName} = (${a}) + (${b});`);
          const out = (node.outputs && node.outputs[0] && node.outputs[0].name) || 'out';
          symbolTable.set(`${node.id}:${out}`, varName);
          break;
        }
        case 'Arg': {
          // Arg node inside a function maps to a parameter name; do not emit code, just register symbol
          const out = (node.outputs && node.outputs[0] && node.outputs[0].name) || 'out';
          const pname = node.params?.name || node.params?.var || 'arg';
          symbolTable.set(`${node.id}:${out}`, pname);
          break;
        }
        case 'Return': {
          const v = resolveInput(node, 'value');
          lines.push(`return ${v};`);
          break;
        }
        default:
          lines.push(`// Unknown node type in function body: ${node.type}`);
      }
    }
    return { lines, symbolTable };
  }

  // Emit functions
  const functionStrings = [];
  for (const f of graph.functions || []) {
    // collect includes from function body
    const fbody = emitGraphBody(f.graph);
    // no special include extraction here; includes global set updated in emitGraphBody
    // Build function string
    const bodyText = fbody.lines.map(l => '  ' + l).join('\n');
    const sig = f.signature || `int ${f.name}()`;
    // Ensure return exists
    let bodyWithReturn = bodyText;
    if (!fbody.lines.some(l => l.trim().startsWith('return'))) {
      if (!/void\s+/.test(sig)) bodyWithReturn += '\n  return 0;';
    }
    functionStrings.push(`${sig} {\n${bodyWithReturn}\n}`);
  }

  // Emit main body
  const mainBody = (function() {
    const g = graph;
    const edgesByDest = new Map();
    for (const e of g.edges || []) {
      const key = `${e.toNode}:${e.toPort}`;
      if (!edgesByDest.has(key)) edgesByDest.set(key, []);
      edgesByDest.get(key).push(e);
    }
    const symbolTable = new Map();
    let tmp = 0;
    function newTmp(pfx) { tmp++; return `${pfx}_${tmp}` }
    function resolveInput(node, name) {
      const key = `${node.id}:${name}`;
      const inc = edgesByDest.get(key) || [];
      if (inc.length > 0) {
        const e = inc[0];
        const sym = symbolTable.get(`${e.fromNode}:${e.fromPort}`);
        if (sym) return sym;
        const fromNode = (g.nodes || []).find(n => n.id === e.fromNode);
        if (fromNode && fromNode.params && fromNode.params.value !== undefined) return JSON.stringify(fromNode.params.value);
        return '0';
      }
      if (node.params && node.params[name] !== undefined) return JSON.stringify(node.params[name]);
      return '0';
    }
    const lines = [];
    for (const node of g.nodes || []) {
      switch (node.type) {
        case 'Const': {
          const out = (node.outputs && node.outputs[0] && node.outputs[0].name) || 'out';
          const v = node.params && node.params.value;
          const varName = newTmp('const');
          if (typeof v === 'string') { includes.add('<string>'); lines.push(`auto ${varName} = std::string(${JSON.stringify(v)});`); }
          else lines.push(`auto ${varName} = ${JSON.stringify(v)};`);
          symbolTable.set(`${node.id}:${out}`, varName);
          break;
        }
        case 'CallFunction': {
          const fname = node.params?.functionName;
          const args = [];
          for (const inp of node.inputs || []) args.push(resolveInput(node, inp.name));
          const call = `${fname}(${args.join(', ')})`;
          if (node.outputs && node.outputs[0]) {
            const varName = newTmp('call');
            lines.push(`auto ${varName} = ${call};`);
            symbolTable.set(`${node.id}:${node.outputs[0].name}`, varName);
          } else {
            lines.push(`${call};`);
          }
          break;
        }
        case 'Print': {
          includes.add('<iostream>');
          const txt = resolveInput(node, 'text');
          lines.push(`std::cout << ${txt} << std::endl;`);
          break;
        }
        default:
          lines.push(`// Unknown node type in main: ${node.type}`);
      }
    }
    return lines;
  })();

  // Build final text
  const incText = Array.from(includes).map(i => `#include ${i}`).join('\n');
  const functionsPart = functionStrings.join('\n\n');
  const mainText = mainBody.map(l => '  ' + l).join('\n');
  const full = `${incText}\n\n${functionsPart}\n\nint main() {\n${mainText}\n  return 0;\n}\n`;
  return full;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 1) { console.error('Usage: node emit_with_functions.js <graph.json> [out.cpp]'); process.exit(2); }
  const graph = JSON.parse(fs.readFileSync(args[0],'utf8'));
  const out = args[1] || 'out.cpp';
  fs.writeFileSync(out, emitCpp(graph),'utf8');
  console.log('Wrote', out);
}
