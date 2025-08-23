
type Edge = { fromNode: string; fromPort: string; toNode: string; toPort: string };
type Port = { name: string; type?: string };
type Node = { id: string; type: string; inputs?: Port[]; outputs?: Port[]; params?: any };

type FunctionParam = { name: string; type?: string };
type FunctionReturn = { type?: string };

type FunctionIR = { name: string; signature?: string; params?: FunctionParam[]; returns?: FunctionReturn; graph: any };

type GraphIR = { nodes: Node[]; edges: Edge[]; functions?: FunctionIR[] };

type Diagnostic = {
  severity: 'error' | 'warning' | 'info';
  message: string;
  nodeId?: string;
  port?: string;
  edge?: Edge;
};

function findCyclePath(nodes: Node[], edges: Edge[]): string[] | null {
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) {
    if (!adj.has(e.fromNode)) adj.set(e.fromNode, []);
    adj.get(e.fromNode)!.push(e.toNode);
  }

  const visited = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();

  function dfs(u: string): string[] | null {
    visited.add(u);
    stack.push(u);
    onStack.add(u);

    for (const v of adj.get(u) || []) {
      if (!visited.has(v)) {
        const res = dfs(v);
        if (res) return res;
      } else if (onStack.has(v)) {
        // found cycle; return path from v to u
        const idx = stack.indexOf(v);
        if (idx >= 0) return stack.slice(idx).concat(v);
        return [v, u, v];
      }
    }

    stack.pop();
    onStack.delete(u);
    return null;
  }

  for (const n of nodes) {
    if (!visited.has(n.id)) {
      const res = dfs(n.id);
      if (res) return res;
    }
  }
  return null;
}

export function validateGraph(graph: GraphIR): { ok: boolean; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  if (!graph.nodes || !Array.isArray(graph.nodes)) {
    diagnostics.push({ severity: 'error', message: 'Graph has no nodes array' });
    return { ok: false, diagnostics };
  }
  if (!graph.edges || !Array.isArray(graph.edges)) {
    diagnostics.push({ severity: 'error', message: 'Graph has no edges array' });
    return { ok: false, diagnostics };
  }

  // check unique node ids
  const seen = new Set<string>();
  for (const n of graph.nodes) {
    if (seen.has(n.id)) {
      diagnostics.push({ severity: 'error', message: `Duplicate node id: ${n.id}`, nodeId: n.id });
    } else seen.add(n.id);
  }

  // build maps for ports
  const outputs = new Map<string, string | undefined>(); // key: nodeId:port -> type
  const inputs = new Map<string, string | undefined>();
  const nodeById = new Map<string, Node>();
  for (const n of graph.nodes) {
    nodeById.set(n.id, n);
    for (const o of n.outputs || []) outputs.set(`${n.id}:${o.name}`, o.type);
    for (const i of n.inputs || []) inputs.set(`${n.id}:${i.name}`, i.type);
  }

  // Validate edges reference existing nodes and ports
  for (const e of graph.edges) {
    if (!nodeById.has(e.fromNode)) {
      diagnostics.push({ severity: 'error', message: `Edge references missing fromNode: ${e.fromNode}`, edge: e });
      continue;
    }
    if (!nodeById.has(e.toNode)) {
      diagnostics.push({ severity: 'error', message: `Edge references missing toNode: ${e.toNode}`, edge: e });
      continue;
    }
    const fromKey = `${e.fromNode}:${e.fromPort}`;
    const toKey = `${e.toNode}:${e.toPort}`;
    if (!outputs.has(fromKey)) {
      diagnostics.push({ severity: 'error', message: `Edge references missing fromPort: ${fromKey}`, edge: e });
    }
    if (!inputs.has(toKey)) {
      diagnostics.push({ severity: 'error', message: `Edge references missing toPort: ${toKey}`, edge: e, nodeId: e.toNode, port: e.toPort });
    }
  }

  // Fan-in check: multiple edges to same toNode:toPort
  const destCount = new Map<string, number>();
  for (const e of graph.edges) {
    const k = `${e.toNode}:${e.toPort}`;
    destCount.set(k, (destCount.get(k) || 0) + 1);
  }
  for (const [k, c] of destCount.entries()) {
    if (c > 1) {
      diagnostics.push({ severity: 'error', message: `Multiple incoming edges to the same input port: ${k}`, nodeId: k.split(':')[0], port: k.split(':')[1] });
    }
  }

  // Type checks
  for (const e of graph.edges) {
    const fromType = outputs.get(`${e.fromNode}:${e.fromPort}`);
    const toType = inputs.get(`${e.toNode}:${e.toPort}`);
    if (fromType && toType && fromType !== toType) {
      diagnostics.push({ severity: 'error', message: `Type mismatch on edge ${e.fromNode}.${e.fromPort} (${fromType}) -> ${e.toNode}.${e.toPort} (${toType})`, edge: e });
    }
  }

  // Unconnected required inputs
  for (const n of graph.nodes) {
    for (const inp of n.inputs || []) {
      const key = `${n.id}:${inp.name}`;
      const incoming = graph.edges.find((e) => e.toNode === n.id && e.toPort === inp.name);
      if (!incoming) {
        // check if node has a param default
        const hasDefault = n.params && (n.params[inp.name] !== undefined || n.params.value !== undefined);
        if (!hasDefault) {
          diagnostics.push({ severity: 'error', message: `Unconnected required input ${inp.name} on node ${n.id}`, nodeId: n.id, port: inp.name });
        } else {
          diagnostics.push({ severity: 'info', message: `Input ${inp.name} on node ${n.id} is using default param`, nodeId: n.id, port: inp.name });
        }
      }
    }
  }

  // Detect cycles and provide a path if found
  const cyclePath = findCyclePath(graph.nodes, graph.edges);
  if (cyclePath && cyclePath.length > 0) {
    diagnostics.push({ severity: 'error', message: `Cycle detected: ${cyclePath.join(' -> ')}` });
  }

  // Validate functions (if any)
  if (Array.isArray(graph.functions)) {
    for (const f of graph.functions) {
      if (!f.name) {
        diagnostics.push({ severity: 'error', message: `Function missing name in functions array` });
        continue;
      }
      if (!f.graph) {
        diagnostics.push({ severity: 'error', message: `Function ${f.name} missing graph` });
        continue;
      }
      // Validate that declared params match Arg nodes inside function graph
      const declaredParams = (f.params || []).map((p: FunctionParam) => p.name);
      const argNodes: string[] = [];
      const argNames: string[] = [];
      for (const n of f.graph.nodes || []) {
        if (n.type === 'Arg') {
          argNodes.push(n.id);
          const pname = n.params?.name || n.params?.var;
          if (pname) argNames.push(pname);
        }
      }
      // Check for mismatches
      for (const dp of declaredParams) {
        if (!argNames.includes(dp)) {
          diagnostics.push({ severity: 'error', message: `Function ${f.name} declares param '${dp}' but no Arg node with that name found in function graph` });
        }
      }
      for (const an of argNames) {
        if (!declaredParams.includes(an)) {
          diagnostics.push({ severity: 'warning', message: `Function ${f.name} has Arg node '${an}' but function params do not declare it` });
        }
      }
      // Check for Return nodes when function declares a non-void return
      const hasReturnNode = (f.graph.nodes || []).some((n: Node) => n.type === 'Return');
      const retType = f.returns && f.returns.type;
      if (retType && retType !== 'void' && !hasReturnNode) {
        diagnostics.push({ severity: 'error', message: `Function ${f.name} declares return type ${retType} but no Return node found in function graph` });
      }
      // Recursively validate inner graph structure (basic validation)
      try {
        const innerResult = validateGraph({ nodes: f.graph.nodes || [], edges: f.graph.edges || [] });
        for (const d of innerResult.diagnostics) {
          // attach function name in message
          diagnostics.push({ severity: d.severity, message: `In function ${f.name}: ${d.message}`, nodeId: d.nodeId, port: d.port, edge: d.edge });
        }
      } catch (e) {
        diagnostics.push({ severity: 'error', message: `Failed validating function ${f.name}: ${String(e)}` });
      }
    }
  }

  const ok = diagnostics.filter((d) => d.severity === 'error').length === 0;
  return { ok, diagnostics };
}

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: node graphValidator.js <graph.json>');
    process.exit(2);
  }
  const fs = require('fs');
  const raw = fs.readFileSync(args[0], 'utf8');
  const graph = JSON.parse(raw);
  const result = validateGraph(graph);
  if (!result.ok) {
    console.error('Validation failed:');
    for (const d of result.diagnostics) {
      console.error(`${d.severity.toUpperCase()}: ${d.message}${d.nodeId ? ' (node: ' + d.nodeId + (d.port ? ', port: ' + d.port : '') + ')' : ''}`);
    }
    process.exit(1);
  }
  console.log('Validation OK');
}
