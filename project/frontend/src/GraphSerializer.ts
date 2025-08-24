export type NodeProperty = { name: string; type: string; value?: any };

export type Node = {
  id: string;
  type: string;
  label?: string;
  inputs?: string[]; // IDs of nodes providing inputs (positional legacy)
  outputs?: string[]; // IDs of nodes consuming outputs (positional legacy)
  properties?: { [key: string]: any };
};

export type Edge = { from: string; to: string; fromPort?: string; toPort?: string };

export type FunctionIR = { name: string; params?: { name: string; type: string }[]; returnType?: string; graph: GraphIR };

export type GraphIR = {
  nodes: Node[];
  edges?: Edge[];
  functions?: FunctionIR[];
  imports?: string[];
  metadata?: { [k: string]: any };
};

export function serializeGraph(ir: GraphIR): string {
  return JSON.stringify(ir, null, 2);
}

export function deserializeGraph(json: string): GraphIR {
  return JSON.parse(json) as GraphIR;
}

export function createLiteralNode(id: string, value: any): Node {
  return { id, type: 'Literal', properties: { value } };
}

export function createNode(id: string, type: string, inputs?: string[], properties?: { [k: string]: any }): Node {
  return { id, type, inputs: inputs || [], properties: properties || {} };
}

// Basic validation helpers
export function findNode(ir: GraphIR, id: string): Node | undefined {
  return ir.nodes.find(n => n.id === id);
}

export function addEdge(ir: GraphIR, from: string, to: string, fromPort?: string, toPort?: string) {
  ir.edges = ir.edges || [];
  ir.edges.push({ from, to, fromPort, toPort });
  // maintain legacy node.inputs/outputs arrays for compatibility
  const fromNode = findNode(ir, from);
  const toNode = findNode(ir, to);
  if (fromNode) fromNode.outputs = Array.from(new Set([...(fromNode.outputs || []), to]));
  if (toNode) toNode.inputs = Array.from(new Set([...(toNode.inputs || []), from]));
}

// New helper: addEdgeToPort for clarity
export function addEdgeToPort(ir: GraphIR, from: string, to: string, fromPort?: string, toPort?: string) {
  addEdge(ir, from, to, fromPort, toPort);
}

export function getIncomingEdges(ir: GraphIR, nodeId: string): Edge[] {
  return (ir.edges || []).filter(e => e.to === nodeId);
}

export function getOutgoingEdges(ir: GraphIR, nodeId: string): Edge[] {
  return (ir.edges || []).filter(e => e.from === nodeId);
}

// Normalize edges -> populate node.inputs/outputs (called before save or send to backend)
export function normalizeEdges(ir: GraphIR) {
  ir.edges = ir.edges || [];
  const nodeMap: { [id: string]: Node } = {};
  ir.nodes.forEach(n => { n.inputs = []; n.outputs = []; nodeMap[n.id] = n; });
  for (const e of ir.edges) {
    if (!nodeMap[e.from] || !nodeMap[e.to]) continue;
    if (!nodeMap[e.to].inputs) nodeMap[e.to].inputs = [];
    if (!nodeMap[e.from].outputs) nodeMap[e.from].outputs = [];
    if (!nodeMap[e.to].inputs!.includes(e.from)) nodeMap[e.to].inputs!.push(e.from);
    if (!nodeMap[e.from].outputs!.includes(e.to)) nodeMap[e.from].outputs!.push(e.to);
  }
}

// Helper to remove an edge
export function removeEdge(ir: GraphIR, from: string, to: string, fromPort?: string, toPort?: string) {
  ir.edges = (ir.edges || []).filter(e => !(e.from === from && e.to === to && e.fromPort === fromPort && e.toPort === toPort));
  // rebuild legacy inputs/outputs
  normalizeEdges(ir);
}

// Validate basic consistency: all edges reference existing nodes
export function validateEdges(ir: GraphIR): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const ids = new Set(ir.nodes.map(n => n.id));
  for (const e of ir.edges || []) {
    if (!ids.has(e.from)) errors.push(`Edge from unknown node ${e.from}`);
    if (!ids.has(e.to)) errors.push(`Edge to unknown node ${e.to}`);
  }
  return { ok: errors.length === 0, errors };
}

// Convenience: connect by port names (frontend can use this to attach to named ports)
export function connectToPort(ir: GraphIR, from: string, to: string, fromPort?: string, toPort?: string) {
  addEdgeToPort(ir, from, to, fromPort, toPort);
}

// Get port mappings for a node (incoming by port name)
export function incomingByPort(ir: GraphIR, nodeId: string): { [port: string]: string } {
  const map: { [port: string]: string } = {};
  for (const e of ir.edges || []) {
    if (e.to === nodeId && e.toPort) map[e.toPort] = e.from;
  }
  return map;
}

// Backward-compatible export: produce canonical IR with edges and populated inputs/outputs
export function canonicalizeGraph(ir: GraphIR): GraphIR {
  const copy: GraphIR = JSON.parse(JSON.stringify(ir));
  normalizeEdges(copy);
  return copy;
}
