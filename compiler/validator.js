// Validator for the IR: uses edges for dataflow, Tarjan SCC for cycle detection on data edges,
// supports port-level validation and basic type inference using incoming data edges.
const fs = require('fs');

function buildEdgeMaps(nodes, edges) {
  const incoming = {}; // to -> [from]
  const outgoing = {}; // from -> [to]
  const incomingByPort = {}; // to -> { toPort: from }
  (nodes || []).forEach(n => { incoming[n.id] = []; outgoing[n.id] = []; incomingByPort[n.id] = {}; });
  (edges || []).forEach(e => {
    const from = e.from || e.fromNode || e.fromId;
    const to = e.to || e.toNode || e.toId;
    const kind = e.kind || 'data';
    const fromPort = e.fromPort || e.fromPortName || e.outPort;
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

// Tarjan's strongly connected components to detect cycles among data edges
function tarjanSCC(nodes, edges) {
  let index = 0;
  const indices = {};
  const lowlink = {};
  const stack = [];
  const onStack = {};
  const sccs = [];

  const adj = {};
  (nodes || []).forEach(n => adj[n.id] = []);
  (edges || []).forEach(e => {
    const kind = e.kind || 'data';
    const from = e.from || e.fromNode || e.fromId;
    const to = e.to || e.toNode || e.toId;
    if (kind === 'data') {
      if (adj[from]) adj[from].push(to);
    }
  });

  function strongconnect(v) {
    indices[v] = index;
    lowlink[v] = index;
    index += 1;
    stack.push(v);
    onStack[v] = true;

    for (const w of adj[v]) {
      if (indices[w] === undefined) {
        strongconnect(w);
        lowlink[v] = Math.min(lowlink[v], lowlink[w]);
      } else if (onStack[w]) {
        lowlink[v] = Math.min(lowlink[v], indices[w]);
      }
    }

    if (lowlink[v] === indices[v]) {
      const comp = [];
      let w = null;
      do {
        w = stack.pop();
        onStack[w] = false;
        comp.push(w);
      } while (w !== v);
      sccs.push(comp);
    }
  }

  (nodes || []).forEach(n => { if (indices[n.id] === undefined) strongconnect(n.id); });
  return sccs;
}

function inferTypes(nodes, edges) {
  // Use data edges to flow types: incomingMap
  const { incoming } = buildEdgeMaps(nodes, edges);
  const types = {}; // node.id -> type string
  const nodesById = {};
  (nodes || []).forEach(n => nodesById[n.id] = n);

  // seed literal types
  (nodes || []).forEach(n => {
    if (n.type === 'Literal') {
      const v = n.props && n.props.value;
      if (typeof v === 'number') types[n.id] = 'number';
      else if (typeof v === 'string') types[n.id] = 'string';
      else if (typeof v === 'boolean') types[n.id] = 'bool';
      else types[n.id] = 'void';
    }
    if (n.type === 'VarDecl' && n.props && n.props.varType) {
      types[n.id] = 'void'; // declaration node produces no value, var has separate symbol
    }
  });

  let changed = true;
  while (changed) {
    changed = false;
    (nodes || []).forEach(n => {
      if (types[n.id]) return;
      const inIds = incoming[n.id] || [];
      const inTypes = inIds.map(id => types[id]);
      if (inTypes.some(t => t === undefined)) return; // wait until inputs typed

      let outType = undefined;
      if (['Add', 'Sub', 'Mul', 'Div'].includes(n.type)) {
        outType = 'number';
      } else if (n.type === 'LessThan') {
        outType = 'bool';
      } else if (n.type === 'Print') {
        outType = 'void';
      } else if (n.type === 'VarGet') {
        // VarGet output type can be provided in props.varType
        outType = (n.props && n.props.varType) || inTypes[0] || 'void';
      } else if (n.type === 'VarDecl' || n.type === 'VarSet' || n.type === 'If' || n.type === 'While') {
        outType = 'void';
      } else if (n.type === 'Call') {
        if (n.props && n.props.returnType) outType = n.props.returnType;
        else outType = 'void';
      }

      if (outType) {
        types[n.id] = outType;
        changed = true;
      }
    });
  }

  return types;
}

function validate(ir) {
  const errors = [];
  if (!ir.nodes || !Array.isArray(ir.nodes)) errors.push('nodes must be an array');
  if (!ir.edges || !Array.isArray(ir.edges)) errors.push('edges must be an array');

  const ids = new Set();
  (ir.nodes || []).forEach(n => {
    if (!n.id) errors.push('node missing id');
    if (!n.type) errors.push(`node ${n.id || '?'} missing type`);
    if (ids.has(n.id)) errors.push(`duplicate node id ${n.id}`);
    ids.add(n.id);
  });

  (ir.edges || []).forEach(e => {
    const from = e.from || e.fromNode || e.fromId;
    const to = e.to || e.toNode || e.toId;
    if (!from || !to) errors.push('edge must have from and to');
    if (from && !ids.has(from)) errors.push(`edge from unknown node ${from}`);
    if (to && !ids.has(to)) errors.push(`edge to unknown node ${to}`);
  });

  // port-level validation: ensure ports referenced by edges exist on nodes and types match if declared
  const nodesById = {};
  (ir.nodes || []).forEach(n => nodesById[n.id] = n);
  (ir.edges || []).forEach(e => {
    const from = e.from || e.fromNode || e.fromId;
    const to = e.to || e.toNode || e.toId;
    const fromPort = e.fromPort || e.fromPortName || e.outPort;
    const toPort = e.toPort || e.toPortName || e.inPort;
    if (toPort) {
      const toNode = nodesById[to];
      const declared = (Array.isArray(toNode.inputs) ? toNode.inputs : (toNode.props && Array.isArray(toNode.props.inputs) ? toNode.props.inputs : [])).some(p => p.name === toPort);
      if (!declared) errors.push(`edge toPort ${toPort} does not exist on node ${to}`);
    }
    if (fromPort) {
      const fromNode = nodesById[from];
      const declared = (Array.isArray(fromNode.outputs) ? fromNode.outputs : (fromNode.props && Array.isArray(fromNode.props.outputs) ? fromNode.props.outputs : [])).some(p => p.name === fromPort);
      if (!declared) errors.push(`edge fromPort ${fromPort} does not exist on node ${from}`);
    }
  });

  // Detect cycles among data edges using Tarjan SCC
  const sccs = tarjanSCC(ir.nodes || [], ir.edges || []);
  const cycles = sccs.filter(comp => comp.length > 1);
  if (cycles.length) {
    errors.push('cycles detected in data-flow graph (SCCs with >1 node):');
    cycles.forEach(c => errors.push('  scc: ' + c.join(' -> ')));
  }

  const types = inferTypes(ir.nodes || [], ir.edges || []);

  // Validate VarDecl/VarSet/VarGet usage: VarDecl produces a variable symbol
  const varDecls = {};
  (ir.nodes || []).forEach(n => {
    if (n.type === 'VarDecl') {
      const name = (n.props && n.props.varName) || n.id;
      const vtype = (n.props && n.props.varType) || 'double';
      varDecls[name] = { nodeId: n.id, type: vtype };
    }
  });
  (ir.nodes || []).forEach(n => {
    if (n.type === 'VarSet') {
      const name = (n.props && n.props.varName);
      if (!name) errors.push(`VarSet ${n.id} missing props.varName`);
      else if (!varDecls[name]) errors.push(`VarSet ${n.id} references unknown VarDecl ${name}`);
    }
    if (n.type === 'VarGet') {
      const name = (n.props && n.props.varName);
      if (!name) errors.push(`VarGet ${n.id} missing props.varName`);
      else if (!varDecls[name]) errors.push(`VarGet ${n.id} references unknown VarDecl ${name}`);
    }
  });

  // Validate Print nodes: if they have incoming data edges, ensure the producers are typed
  const { incoming } = buildEdgeMaps(ir.nodes || [], ir.edges || []);
  (ir.nodes || []).forEach(n => {
    if (n.type === 'Print') {
      const inputs = incoming[n.id] || [];
      inputs.forEach(inp => {
        if (!types[inp] && !(ir.nodes || []).some(nn => nn.id === inp && nn.type === 'Literal')) {
          errors.push(`Print node ${n.id} references unknown or untyped input ${inp}`);
        }
      });
    }
  });

  return errors;
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node validator.js <ir.json>');
    process.exit(2);
  }
  const ir = JSON.parse(fs.readFileSync(file, 'utf8'));
  const errs = validate(ir);
  if (errs.length) {
    console.error('Validation failed:');
    errs.forEach(e => console.error(' -', e));
    process.exit(1);
  }
  console.log('Validation OK');
}

module.exports = { validate, tarjanSCC, inferTypes };
