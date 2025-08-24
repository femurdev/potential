// TypeScript port of scripts/js_graph_runner.js for in-browser preview
// Exports evaluateGraph(ir) -> { stdout: string, vars: Record<string, any> }

export type IR = any;

export function evaluateGraph(ir: IR, opts?: { iterationLimit?: number }): { stdout: string; vars: Record<string, any> } {
  const iterationLimit = opts?.iterationLimit ?? 100000;
  const nodes: any[] = ir.nodes || [];
  const edges: any[] = ir.edges || [];
  const nodesById: Record<string, any> = {};
  nodes.forEach((n) => (nodesById[n.id] = n));

  function buildEdgeMaps(nodesLocal: any[], edgesLocal: any[]) {
    const incoming: Record<string, string[]> = {};
    const outgoing: Record<string, string[]> = {};
    const incomingByPort: Record<string, Record<string, string>> = {};
    const controlAdj: Record<string, any[]> = {};
    const controlIncoming: Record<string, any[]> = {};
    (nodesLocal || []).forEach((n) => {
      incoming[n.id] = [];
      outgoing[n.id] = [];
      incomingByPort[n.id] = {};
      controlAdj[n.id] = [];
      controlIncoming[n.id] = [];
    });
    (edgesLocal || []).forEach((e) => {
      const from = e.from || e.fromNode || e.fromId;
      const to = e.to || e.toNode || e.toId;
      const kind = e.kind || 'data';
      const toPort = e.toPort || e.toPortName || e.inPort;
      const fromPort = e.fromPort || e.fromPortName || e.outPort;
      if (!from || !to) return;
      if (kind === 'data') {
        incoming[to].push(from);
        outgoing[from].push(to);
        if (toPort) incomingByPort[to][toPort] = from;
      } else if (kind === 'control') {
        controlAdj[from].push({ to, toPort, fromPort });
        controlIncoming[to].push({ from, toPort, fromPort });
      }
    });
    return { incoming, outgoing, incomingByPort, controlAdj, controlIncoming };
  }

  const { incoming, incomingByPort, controlAdj, controlIncoming } = buildEdgeMaps(nodes, edges);

  const dataCache: Record<string, any> = {};
  const varStore: Record<string, any> = {};
  let stdoutLines: string[] = [];

  let iterations = 0;
  function tickGuard() {
    iterations += 1;
    if (iterations > iterationLimit) {
      throw new Error('Iteration limit exceeded in JS preview runner');
    }
  }

  function evalNode(id: string): any {
    if (dataCache.hasOwnProperty(id)) return dataCache[id];
    tickGuard();
    const n = nodesById[id];
    if (!n) return undefined;
    let val: any = undefined;
    const type = n.type;
    if (type === 'Literal') {
      // accept properties.value or props.value
      val = (n.properties && n.properties.value) ?? (n.props && n.props.value);
    } else if (type === 'Add' || type === 'Sub' || type === 'Mul' || type === 'Div') {
      const ins = incoming[id] || [];
      const a = ins[0] ? evalNode(ins[0]) : 0;
      const b = ins[1] ? evalNode(ins[1]) : 0;
      if (type === 'Add') val = a + b;
      if (type === 'Sub') val = a - b;
      if (type === 'Mul') val = a * b;
      if (type === 'Div') val = a / b;
    } else if (type === 'LessThan') {
      const ins = incoming[id] || [];
      const a = ins[0] ? evalNode(ins[0]) : 0;
      const b = ins[1] ? evalNode(ins[1]) : 0;
      val = a < b;
    } else if (type === 'VarGet') {
      const name = (n.properties && n.properties.name) || (n.props && n.props.varName) || n.id;
      val = varStore[name];
    } else if (type === 'Call') {
      // No host library calls in JS preview — return undefined or attempt builtins (e.g., sin)
      const props = n.properties || n.props || {};
      const fname = props.name || props.fn;
      const ins = incoming[id] || [];
      const args = ins.map((srcId: string) => evalNode(srcId));
      try {
        if (fname === 'sin' && args.length === 1) val = Math.sin(args[0]);
        else if (fname === 'cos' && args.length === 1) val = Math.cos(args[0]);
        else val = undefined;
      } catch (e) {
        val = undefined;
      }
    } else if (type === 'Print') {
      const parts: any[] = [];
      const byPort = incomingByPort[id] || {};
      if (Object.keys(byPort).length) {
        const inputs = Array.isArray(n.inputs) ? n.inputs : (n.properties && n.properties.inputs) || (n.props && n.props.inputs) || [];
        if (inputs && inputs.length) {
          inputs.forEach((p: any) => {
            const src = byPort[p.name];
            if (src !== undefined) parts.push(evalNode(src));
          });
        } else {
          Object.keys(byPort).forEach((k) => {
            parts.push(evalNode(byPort[k]));
          });
        }
      } else {
        (incoming[id] || []).forEach((src) => parts.push(evalNode(src)));
      }
      if (parts.length) stdoutLines.push(parts.map((x) => String(x)).join(' '));
      else if (n.properties && typeof n.properties.text === 'string') stdoutLines.push(n.properties.text);
      else if (n.props && typeof n.props.text === 'string') stdoutLines.push(n.props.text);
      val = null;
    } else {
      // Fallback: props.value
      val = (n.properties && n.properties.value) ?? (n.props && n.props.value);
    }

    dataCache[id] = val;
    return val;
  }

  // find control entries (nodes with control outgoing but no control incoming)
  const controlEntries = nodes
    .filter((n) => (controlAdj[n.id] || []).length > 0 && (controlIncoming[n.id] || []).length === 0)
    .map((n) => n.id);

  // Evaluate standalone Print/data nodes
  nodes.forEach((n) => {
    if ((controlAdj[n.id] || []).length === 0 && (controlIncoming[n.id] || []).length === 0) {
      if (n.type === 'Print') evalNode(n.id);
    }
  });

  function runControlFrom(startId: string, visited = new Set<string>()) {
    const stack = [startId];
    while (stack.length) {
      tickGuard();
      const u = stack.shift() as string;
      if (visited.has(u)) continue;
      visited.add(u);
      const node = nodesById[u];
      if (!node) continue;
      const type = node.type;
      if (type === 'Print') {
        const parts: any[] = [];
        const byPort = incomingByPort[u] || {};
        if (Object.keys(byPort).length) {
          const inputs = Array.isArray(node.inputs) ? node.inputs : (node.properties && node.properties.inputs) || (node.props && node.props.inputs) || [];
          if (inputs && inputs.length) {
            inputs.forEach((p: any) => {
              const src = byPort[p.name];
              if (src !== undefined) parts.push(evalNode(src));
            });
          } else Object.keys(byPort).forEach((k) => parts.push(evalNode(byPort[k])));
        } else (incoming[u] || []).forEach((src) => parts.push(evalNode(src)));
        if (parts.length) stdoutLines.push(parts.map((x) => String(x)).join(' '));
        else if (node.properties && typeof node.properties.text === 'string') stdoutLines.push(node.properties.text);
      } else if (type === 'VarDecl') {
        const name = (node.properties && node.properties.name) || (node.props && node.props.varName) || node.id;
        const init = (node.properties && node.properties.initialValue) ?? (node.props && node.props.initialValue) ?? 0;
        varStore[name] = init;
      } else if (type === 'VarSet') {
        const name = (node.properties && node.properties.name) || (node.props && node.props.varName);
        const ins = incoming[u] || [];
        const val = ins[0] ? evalNode(ins[0]) : undefined;
        if (name) varStore[name] = val;
      } else if (type === 'If') {
        const condIns = incoming[u] || [];
        const condVal = condIns[0] ? evalNode(condIns[0]) : false;
        const targets = controlAdj[u] || [];
        let thenTarget: string | null = null;
        let elseTarget: string | null = null;
        targets.forEach((t) => {
          if (t.toPort === 'then' || t.toPort === 'true') thenTarget = t.to;
          else if (t.toPort === 'else' || t.toPort === 'false') elseTarget = t.to;
        });
        if (!thenTarget && targets[0]) thenTarget = targets[0].to;
        if (!elseTarget && targets[1]) elseTarget = targets[1].to;
        if (condVal && thenTarget) runControlFrom(thenTarget, visited);
        else if (!condVal && elseTarget) runControlFrom(elseTarget, visited);
      } else if (type === 'While') {
        const condIns = incoming[u] || [];
        const targets = controlAdj[u] || [];
        const bodyTarget = targets.length ? targets[0].to : null;
        let loopGuard = 0;
        while (true) {
          tickGuard();
          const condVal = condIns[0] ? evalNode(condIns[0]) : false;
          if (!condVal) break;
          if (bodyTarget) runControlFrom(bodyTarget, visited);
          loopGuard += 1;
          if (loopGuard > 10000) throw new Error('While loop guard exceeded in JS preview');
        }
      }

      (controlAdj[u] || []).forEach((edge) => {
        const t = edge.to;
        if (!visited.has(t)) stack.push(t);
      });
    }
  }

  controlEntries.forEach((eid) => runControlFrom(eid));

  return { stdout: stdoutLines.join('\n'), vars: { ...varStore } };
}
