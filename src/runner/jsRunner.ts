import * as fs from 'fs';

type Node = any;
type Edge = { fromNode: string; fromPort: string; toNode: string; toPort: string };

type GraphIR = { nodes: Node[]; edges: Edge[]; functions?: any[] };

// Simple JS runner: supports Const, Add, Print, VarSet, VarGet
export function runGraph(graph: GraphIR) {
  const state = { vars: new Map<string, any>(), nodeOut: new Map<string, any>() };
  const edgesByDest = new Map<string, Edge[]>();
  for (const e of graph.edges || []) {
    const k = `${e.toNode}:${e.toPort}`;
    if (!edgesByDest.has(k)) edgesByDest.set(k, []);
    edgesByDest.get(k)!.push(e);
  }

  function resolveInput(node: Node, inputName: string) {
    const key = `${node.id}:${inputName}`;
    const incoming = edgesByDest.get(key) || [];
    if (incoming.length > 0) {
      const e = incoming[0];
      return state.nodeOut.get(`${e.fromNode}:${e.fromPort}`);
    }
    if (node.params && node.params[inputName] !== undefined) return node.params[inputName];
    return 0;
  }

  for (const node of graph.nodes || []) {
    switch (node.type) {
      case 'Const': {
        const v = node.params?.value;
        const out = (node.outputs && node.outputs[0] && node.outputs[0].name) || 'out';
        state.nodeOut.set(`${node.id}:${out}`, v);
        break;
      }
      case 'Add': {
        const a = resolveInput(node, 'a');
        const b = resolveInput(node, 'b');
        const out = (node.outputs && node.outputs[0] && node.outputs[0].name) || 'out';
        state.nodeOut.set(`${node.id}:${out}`, a + b);
        break;
      }
      case 'VarSet': {
        const name = node.params?.name || node.params?.var || 'v';
        const val = resolveInput(node, 'value');
        state.vars.set(name, val);
        if (node.outputs && node.outputs[0]) state.nodeOut.set(`${node.id}:${node.outputs[0].name}`, val);
        break;
      }
      case 'VarGet': {
        const name = node.params?.name || node.params?.var || 'v';
        const out = (node.outputs && node.outputs[0] && node.outputs[0].name) || 'out';
        state.nodeOut.set(`${node.id}:${out}`, state.vars.get(name));
        break;
      }
      case 'Print': {
        const txt = resolveInput(node, 'text');
        console.log(txt);
        break;
      }
      default:
        console.log('Unknown node in runner:', node.type);
    }
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: node jsRunner.js <graph.json>');
    process.exit(2);
  }
  const raw = fs.readFileSync(args[0], 'utf8');
  const graph = JSON.parse(raw);
  runGraph(graph);
}
