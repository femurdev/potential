#!/usr/bin/env node
// Simple JS Graph Runner for NodeGraphCPP IR
// Usage: node scripts/js_graph_runner.js <ir.json>

const fs = require('fs');

function buildEdgeMaps(nodes, edges) {
  const incoming = {}; // data incoming
  const outgoing = {};
  const incomingByPort = {};
  const controlAdj = {};
  const controlIncoming = {};
  (nodes || []).forEach(n => { incoming[n.id] = []; outgoing[n.id] = []; incomingByPort[n.id] = {}; controlAdj[n.id] = []; controlIncoming[n.id] = []; });
  (edges || []).forEach(e => {
    const from = e.from || e.fromNode || e.fromId;
    const to = e.to || e.toNode || e.toId;
    const kind = e.kind || 'data';
    const toPort = e.toPort || e.toPortName || e.inPort;
    const fromPort = e.fromPort || e.fromPortName || e.outPort;
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

function evaluateGraph(ir) {
  const nodes = ir.nodes || [];
  const edges = ir.edges || [];
  const nodesById = {};
  nodes.forEach(n => nodesById[n.id] = n);
  const { incoming, incomingByPort, controlAdj, controlIncoming } = buildEdgeMaps(nodes, edges);

  const dataCache = {}; // nodeId -> value
  const varStore = {}; // varName -> value

  function evalNode(id) {
    if (dataCache.hasOwnProperty(id)) return dataCache[id];
    const n = nodesById[id];
    if (!n) return undefined;
    let val = undefined;
    if (n.type === 'Literal') {
      val = n.props && n.props.value;
    } else if (n.type === 'Add' || n.type === 'Sub' || n.type === 'Mul' || n.type === 'Div') {
      const ins = incoming[id] || [];
      const a = ins[0] ? evalNode(ins[0]) : 0;
      const b = ins[1] ? evalNode(ins[1]) : 0;
      if (n.type === 'Add') val = a + b;
      if (n.type === 'Sub') val = a - b;
      if (n.type === 'Mul') val = a * b;
      if (n.type === 'Div') val = a / b;
    } else if (n.type === 'LessThan') {
      const ins = incoming[id] || [];
      const a = ins[0] ? evalNode(ins[0]) : 0;
      const b = ins[1] ? evalNode(ins[1]) : 0;
      val = a < b;
    } else if (n.type === 'VarGet') {
      const name = (n.props && n.props.varName) || n.id;
      val = varStore[name];
    } else if (n.type === 'Call') {
      // best-effort: no external function execution
      val = undefined;
    } else if (n.type === 'Print') {
      // If Print is used as data node, evaluate inputs and perform print as side-effect
      const parts = [];
      const byPort = incomingByPort[id] || {};
      if (Object.keys(byPort).length) {
        const inputs = Array.isArray(n.inputs) ? n.inputs : (n.props && n.props.inputs) || [];
        if (inputs && inputs.length) {
          inputs.forEach(p => {
            const src = byPort[p.name];
            if (src !== undefined) parts.push(evalNode(src));
          });
        } else {
          Object.keys(byPort).forEach(k => { parts.push(evalNode(byPort[k])); });
        }
      } else {
        (incoming[id] || []).forEach(src => parts.push(evalNode(src)));
      }
      if (parts.length) console.log(...parts);
      else if (n.props && typeof n.props.text === 'string') console.log(n.props.text);
      val = null;
    } else {
      // Fallback: try to read props.value
      if (n.props && n.props.value !== undefined) val = n.props.value;
    }
    dataCache[id] = val;
    return val;
  }

  // Execute top-level control flow: find control entry nodes (no incoming control)
  const controlEntries = nodes.filter(n => (controlIncoming[n.id] || []).length === 0 && (controlAdj[n.id] || []).length > 0).map(n=>n.id);

  // Also consider nodes with no control edges and no data consumers: evaluate them
  nodes.forEach(n => {
    if ((controlAdj[n.id] || []).length === 0 && (controlIncoming[n.id] || []).length === 0) {
      // If node is a pure data node with side-effects (Print), evaluate it
      if (n.type === 'Print') evalNode(n.id);
    }
  });

  function runControlFrom(startId, visited = new Set()) {
    // perform BFS/DFS along control edges, executing encountered nodes
    const stack = [startId];
    while (stack.length) {
      const u = stack.shift();
      if (visited.has(u)) continue;
      visited.add(u);
      const node = nodesById[u];
      if (!node) continue;
      if (node.type === 'Print') {
        // Print inside control flow: evaluate its inputs and print
        const parts = [];
        const byPort = incomingByPort[u] || {};
        if (Object.keys(byPort).length) {
          const inputs = Array.isArray(node.inputs) ? node.inputs : (node.props && node.props.inputs) || [];
          if (inputs && inputs.length) {
            inputs.forEach(p => { const src = byPort[p.name]; if (src !== undefined) parts.push(evalNode(src)); });
          } else Object.keys(byPort).forEach(k => parts.push(evalNode(byPort[k])));
        } else (incoming[u] || []).forEach(src => parts.push(evalNode(src)));
        if (parts.length) console.log(...parts);
        else if (node.props && typeof node.props.text === 'string') console.log(node.props.text);
      } else if (node.type === 'VarDecl') {
        const name = (node.props && node.props.varName) || node.id;
        const init = node.props && node.props.initialValue !== undefined ? node.props.initialValue : 0;
        varStore[name] = init;
      } else if (node.type === 'VarSet') {
        const name = (node.props && node.props.varName);
        const ins = incoming[u] || [];
        const val = ins[0] ? evalNode(ins[0]) : undefined;
        varStore[name] = val;
      } else if (node.type === 'If') {
        const condIns = incoming[u] || [];
        const condVal = condIns[0] ? evalNode(condIns[0]) : false;
        const targets = controlAdj[u] || [];
        let thenTarget = null, elseTarget = null;
        targets.forEach(t => {
          if (t.toPort === 'then' || t.toPort === 'true') thenTarget = t.to;
          else if (t.toPort === 'else' || t.toPort === 'false') elseTarget = t.to;
        });
        if (!thenTarget && targets[0]) thenTarget = targets[0].to;
        if (!elseTarget && targets[1]) elseTarget = targets[1].to;
        if (condVal && thenTarget) runControlFrom(thenTarget, visited);
        else if (!condVal && elseTarget) runControlFrom(elseTarget, visited);
      } else if (node.type === 'While') {
        const condIns = incoming[u] || [];
        const targets = controlAdj[u] || [];
        const bodyTarget = targets.length ? targets[0].to : null;
        while (true) {
          const condVal = condIns[0] ? evalNode(condIns[0]) : false;
          if (!condVal) break;
          if (bodyTarget) runControlFrom(bodyTarget, visited);
        }
      } else {
        // For other control nodes, just step to their control targets
      }
      // enqueue control successors (if any not specific to If/While handled above)
      (controlAdj[u] || []).forEach(edge => {
        const t = edge.to;
        if (!visited.has(t)) stack.push(t);
      });
    }
  }

  // Run from each control entry
  controlEntries.forEach(eid => runControlFrom(eid));
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error('Usage: node scripts/js_graph_runner.js <ir.json>'); process.exit(2); }
  const ir = JSON.parse(fs.readFileSync(file, 'utf8'));
  evaluateGraph(ir);
}

module.exports = { evaluateGraph };
