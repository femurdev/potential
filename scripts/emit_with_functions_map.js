const fs = require('fs');

function emitCppWithMap(graph) {
  const includes = new Set();
  if (Array.isArray(graph.imports)) graph.imports.forEach(i => includes.add(i));

  function emitGraphBody(g) {
    const lines = [];
    const nodeMap = {};
    const edgesByDest = new Map();
    for (const e of g.edges || []) {
      const key = `${e.toNode}:${e.toPort}`;
      if (!edgesByDest.has(key)) edgesByDest.set(key, []);
      edgesByDest.get(key).push(e);
    }
    let tmp = 0;
    function newTmp(pfx) { tmp++; return `${pfx}_${tmp}` }
    function resolveInput(node, name) {
      const key = `${node.id}:${name}`;
      const inc = edgesByDest.get(key) || [];
      if (inc.length > 0) {
        const e = inc[0];
        const sym = (g.__symbolTable || new Map()).get(`${e.fromNode}:${e.fromPort}`);
        if (sym) return sym;
        const fromNode = (g.nodes || []).find(n => n.id === e.fromNode);
        if (fromNode && fromNode.params && fromNode.params.value !== undefined) return JSON.stringify(fromNode.params.value);
        return '0';
      }
      if (node.params && node.params[name] !== undefined) return JSON.stringify(node.params[name]);
      return '0';
    }

    // simple symbol table per graph to help resolve consts within same body
    g.__symbolTable = new Map();

    for (const node of g.nodes || []) {
      const startLine = lines.length + 1;
      switch (node.type) {
        case 'Const': {
          const out = (node.outputs && node.outputs[0] && node.outputs[0].name) || 'out';
          const v = node.params && node.params.value;
          const varName = newTmp('const');
          if (typeof v === 'string') { includes.add('<string>'); lines.push(`auto ${varName} = std::string(${JSON.stringify(v)});`); }
          else lines.push(`auto ${varName} = ${JSON.stringify(v)};`);
          g.__symbolTable.set(`${node.id}:${out}`, varName);
          break;
        }
        case 'Add': {
          const a = resolveInput(node, 'a');
          const b = resolveInput(node, 'b');
          const varName = newTmp('add');
          lines.push(`auto ${varName} = (${a}) + (${b});`);
          const out = (node.outputs && node.outputs[0] && node.outputs[0].name) || 'out';
          g.__symbolTable.set(`${node.id}:${out}`, varName);
          break;
        }
        case 'Print': {
          includes.add('<iostream>');
          const txt = resolveInput(node, 'text');
          lines.push(`std::cout << ${txt} << std::endl;`);
          break;
        }
        default:
          lines.push(`// Unknown node type: ${node.type}`);
      }
      const endLine = lines.length;
      nodeMap[node.id] = { startLine, endLine };
    }
    return { lines, nodeMap };
  }

  // functions
  const functionStrings = [];
  const functionMaps = [];
  for (const f of graph.functions || []) {
    const { lines, nodeMap } = emitGraphBody(f.graph);
    const body = lines.map(l => '  ' + l).join('\n');
    let funcBody = body;
    if (!lines.some(l => l.trim().startsWith('return'))) {
      if (!/void\s+/.test(f.signature || '')) funcBody += '\n  return 0;';
    }
    const signature = f.signature || `int ${f.name}()`;
    functionStrings.push(`${signature} {\n${funcBody}\n}`);
    functionMaps.push(nodeMap);
  }

  // main
  const { lines: mainLines, nodeMap: mainMap } = emitGraphBody(graph);

  const includesText = Array.from(includes).map(i => `#include ${i}`).join('\n');
  const functionsPart = functionStrings.join('\n\n');
  const mainBody = mainLines.map(l => '  ' + l).join('\n');
  const full = `${includesText}\n\n${functionsPart}\n\nint main() {\n${mainBody}\n  return 0;\n}\n`;

  // build map -> global lines
  const map = {};
  const includeLines = includesText.split('\n').filter(l=>l.trim().length>0).length;
  let currentLine = includeLines + 2;
  for (let i = 0; i < functionStrings.length; i++) {
    const fstr = functionStrings[i];
    const fmap = functionMaps[i];
    const fLines = fstr.split('\n').length;
    for (const [nid, rng] of Object.entries(fmap)) {
      map[nid] = { startLine: currentLine + rng.startLine - 1, endLine: currentLine + rng.endLine - 1 };
    }
    currentLine += fLines + 2;
  }
  currentLine += 1;
  for (const [nid, rng] of Object.entries(mainMap)) {
    map[nid] = { startLine: currentLine + rng.startLine - 1, endLine: currentLine + rng.endLine - 1 };
  }
  return { code: full, map };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 1) { console.error('Usage: node emit_with_functions_map.js <graph.json> [out.cpp]'); process.exit(2); }
  const graph = JSON.parse(fs.readFileSync(args[0],'utf8'));
  const out = args[1] || 'out.cpp';
  const res = emitCppWithMap(graph);
  fs.writeFileSync(out, res.code, 'utf8');
  fs.writeFileSync(out + '.map.json', JSON.stringify(res.map, null, 2), 'utf8');
  console.log('Wrote', out, 'and', out + '.map.json');
}
