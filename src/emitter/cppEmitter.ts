import * as fs from "fs";
import * as fs from "fs";
import * as path from "path";
import { validatePluginWithAjv } from "./pluginValidator";
import { validateGraph } from "../validator/graphValidator";

// Minimal types for graph IR
type Port = { name: string; type: string };
type Node = {
  id: string;
  type: string;
  label?: string;
  inputs?: Port[];
  outputs?: Port[];
  params?: any;
  function?: string;
};

type Edge = { fromNode: string; fromPort: string; toNode: string; toPort: string };

type FunctionParam = { name: string; type?: string };
type FunctionReturn = { type?: string };

type FunctionIR = { name: string; signature?: string; params?: FunctionParam[]; returns?: FunctionReturn; graph: GraphIR };

type GraphIR = {
  meta?: any;
  imports?: string[];
  nodes: Node[];
  edges: Edge[];
  functions?: FunctionIR[];
  libraryNodes?: any[];
};

// Emitter context and helpers
class EmitterContext {
  includes = new Set<string>();
  bodyLines: string[] = [];
  symbolTable: Map<string, string> = new Map(); // key: nodeId:port -> varName
  tmpCount = 0;
  // mapping from nodeId -> { startLine: number, endLine: number } (1-based within this context body)
  nodeLineMap: Map<string, { startLine: number; endLine: number }> = new Map();

  addInclude(inc: string) {
    this.includes.add(inc);
  }
  emit(line: string) {
    this.bodyLines.push(line);
  }
  newTmp(prefix = "tmp") {
    this.tmpCount += 1;
    return `${prefix}_${this.tmpCount}`;
  }
  assignSymbol(nodeId: string, port: string, varName: string) {
    this.symbolTable.set(`${nodeId}:${port}`, varName);
  }
  lookupSymbol(nodeId: string, port: string) {
    return this.symbolTable.get(`${nodeId}:${port}`);
  }
  // helpers to record node emission range. Also emits a comment line marking the node so mapping is robust.
  markNodeStart(nodeId: string) {
    // emit a comment that tags following lines with the node id
    this.bodyLines.push(`// node:${nodeId}`);
    const start = this.bodyLines.length; // comment line index (1-based)
    this.nodeLineMap.set(nodeId, { startLine: start, endLine: start });
  }
  markNodeEnd(nodeId: string) {
    const info = this.nodeLineMap.get(nodeId);
    if (!info) return;
    info.endLine = this.bodyLines.length; // inclusive
    this.nodeLineMap.set(nodeId, info);
  }
}

// Helper to sanitize user-provided identifiers so generated C++ identifiers are valid and avoid collisions.
function sanitizeIdentifier(name: string): string {
  if (!name || typeof name !== 'string') return '__g2c_unnamed';
  // Basic replacement: keep letters, digits, underscore
  let t = name.replace(/[^a-zA-Z0-9_]/g, '_');
  // Ensure doesn't start with a digit
  if (/^[0-9]/.test(t)) t = '_' + t;
  // Avoid reserved words (small list)
  const keywords = new Set([
    'alignas','alignof','and','and_eq','asm','auto','bitand','bitor','bool','break','case','catch','char','char16_t','char32_t','class','compl','const','constexpr','const_cast','continue','decltype','default','delete','do','double','dynamic_cast','else','enum','explicit','export','extern','false','float','for','friend','goto','if','inline','int','long','mutable','namespace','new','noexcept','not','not_eq','nullptr','operator','or','or_eq','private','protected','public','register','reinterpret_cast','return','short','signed','sizeof','static','static_assert','static_cast','struct','switch','template','this','thread_local','throw','true','try','typedef','typeid','typename','union','unsigned','using','virtual','void','volatile','wchar_t','while','xor','xor_eq'
  ]);
  if (keywords.has(t)) t = '_' + t;
  // Prefix to avoid collisions with tmp_ variables
  return `__g2c_${t}`;
}

// Node emitter registry
const NODE_EMITTERS: { [nodeType: string]: (node: Node, ctx: EmitterContext, graph: GraphIR, edgesByDest: Map<string, Edge[]>) => void } = {};

// Helper to resolve input expression for a given input port (nodeId, portName)
function resolveInputExpression(node: Node, inputName: string, graph: GraphIR, edgesByDest: Map<string, Edge[]>, ctx: EmitterContext): string {
  const key = `${node.id}:${inputName}`;
  const incoming = edgesByDest.get(key) || [];
  if (incoming.length > 0) {
    // take first incoming edge
    const e = incoming[0];
    // find var emitted by fromNode:fromPort
    const varName = ctx.lookupSymbol(e.fromNode, e.fromPort);
    if (varName) return varName;
    // if not found, maybe the fromNode is a Const
    const fromNode = graph.nodes.find((n) => n.id === e.fromNode);
    if (fromNode && fromNode.params && fromNode.params.value !== undefined) {
      return JSON.stringify(fromNode.params.value);
    }
    throw new Error(`Unresolved input ${e.fromNode}:${e.fromPort} -> ${node.id}:${inputName}`);
  }
  // fallback to param on node
  if (node.params && node.params[inputName] !== undefined) {
    const v = node.params[inputName];
    if (typeof v === 'string') return JSON.stringify(v);
    return JSON.stringify(v);
  }
  throw new Error(`Unconnected required input ${inputName} on node ${node.id}`);
}

// Register core node emitters
NODE_EMITTERS['Const'] = (node, ctx) => {
  ctx.markNodeStart(node.id);
  const outPort = (node.outputs && node.outputs[0] && node.outputs[0].name) || 'out';
  const v = node.params?.value ?? 0;
  const varName = ctx.newTmp('const');
  if (typeof v === 'string') {
    ctx.addInclude('<string>');
    ctx.emit(`auto ${varName} = std::string(${JSON.stringify(v)});`);
  } else {
    ctx.emit(`auto ${varName} = ${JSON.stringify(v)};`);
  }
  ctx.assignSymbol(node.id, outPort, varName);
  ctx.markNodeEnd(node.id);
};

NODE_EMITTERS['Add'] = (node, ctx, graph, edgesByDest) => {
  ctx.markNodeStart(node.id);
  const a = resolveInputExpression(node, 'a', graph, edgesByDest, ctx);
  const b = resolveInputExpression(node, 'b', graph, edgesByDest, ctx);
  const outPort = (node.outputs && node.outputs[0] && node.outputs[0].name) || 'out';
  const varName = ctx.newTmp('add');
  ctx.emit(`auto ${varName} = (${a}) + (${b});`);
  ctx.assignSymbol(node.id, outPort, varName);
  ctx.markNodeEnd(node.id);
};

NODE_EMITTERS['Sub'] = (node, ctx, graph, edgesByDest) => {
  ctx.markNodeStart(node.id);
  const a = resolveInputExpression(node, 'a', graph, edgesByDest, ctx);
  const b = resolveInputExpression(node, 'b', graph, edgesByDest, ctx);
  const varName = ctx.newTmp('sub');
  ctx.emit(`auto ${varName} = (${a}) - (${b});`);
  const outPort = (node.outputs && node.outputs[0] && node.outputs[0].name) || 'out';
  ctx.assignSymbol(node.id, outPort, varName);
  ctx.markNodeEnd(node.id);
};

NODE_EMITTERS['Mul'] = (node, ctx, graph, edgesByDest) => {
  ctx.markNodeStart(node.id);
  const a = resolveInputExpression(node, 'a', graph, edgesByDest, ctx);
  const b = resolveInputExpression(node, 'b', graph, edgesByDest, ctx);
  const varName = ctx.newTmp('mul');
  ctx.emit(`auto ${varName} = (${a}) * (${b});`);
  const outPort = (node.outputs && node.outputs[0] && node.outputs[0].name) || 'out';
  ctx.assignSymbol(node.id, outPort, varName);
  ctx.markNodeEnd(node.id);
};

NODE_EMITTERS['Div'] = (node, ctx, graph, edgesByDest) => {
  ctx.markNodeStart(node.id);
  const a = resolveInputExpression(node, 'a', graph, edgesByDest, ctx);
  const b = resolveInputExpression(node, 'b', graph, edgesByDest, ctx);
  const varName = ctx.newTmp('div');
  ctx.emit(`auto ${varName} = (${a}) / (${b});`);
  const outPort = (node.outputs && node.outputs[0] && node.outputs[0].name) || 'out';
  ctx.assignSymbol(node.id, outPort, varName);
  ctx.markNodeEnd(node.id);
};

NODE_EMITTERS['Mod'] = (node, ctx, graph, edgesByDest) => {
  ctx.markNodeStart(node.id);
  const a = resolveInputExpression(node, 'a', graph, edgesByDest, ctx);
  const b = resolveInputExpression(node, 'b', graph, edgesByDest, ctx);
  const varName = ctx.newTmp('mod');
  ctx.emit(`auto ${varName} = (${a}) % (${b});`);
  const outPort = (node.outputs && node.outputs[0] && node.outputs[0].name) || 'out';
  ctx.assignSymbol(node.id, outPort, varName);
  ctx.markNodeEnd(node.id);
};

// Comparisons
NODE_EMITTERS['Eq'] = (node, ctx, graph, edgesByDest) => {
  ctx.markNodeStart(node.id);
  const a = resolveInputExpression(node, 'a', graph, edgesByDest, ctx);
  const b = resolveInputExpression(node, 'b', graph, edgesByDest, ctx);
  const varName = ctx.newTmp('eq');
  ctx.emit(`auto ${varName} = (${a}) == (${b});`);
  const outPort = (node.outputs && node.outputs[0] && node.outputs[0].name) || 'out';
  ctx.assignSymbol(node.id, outPort, varName);
  ctx.markNodeEnd(node.id);
};

NODE_EMITTERS['Neq'] = (node, ctx, graph, edgesByDest) => {
  ctx.markNodeStart(node.id);
  const a = resolveInputExpression(node, 'a', graph, edgesByDest, ctx);
  const b = resolveInputExpression(node, 'b', graph, edgesByDest, ctx);
  const varName = ctx.newTmp('neq');
  ctx.emit(`auto ${varName} = (${a}) != (${b});`);
  const outPort = (node.outputs && node.outputs[0] && node.outputs[0].name) || 'out';
  ctx.assignSymbol(node.id, outPort, varName);
  ctx.markNodeEnd(node.id);
};

NODE_EMITTERS['Lt'] = (node, ctx, graph, edgesByDest) => {
  ctx.markNodeStart(node.id);
  const a = resolveInputExpression(node, 'a', graph, edgesByDest, ctx);
  const b = resolveInputExpression(node, 'b', graph, edgesByDest, ctx);
  const varName = ctx.newTmp('lt');
  ctx.emit(`auto ${varName} = (${a}) < (${b});`);
  const outPort = (node.outputs && node.outputs[0] && node.outputs[0].name) || 'out';
  ctx.assignSymbol(node.id, outPort, varName);
  ctx.markNodeEnd(node.id);
};

NODE_EMITTERS['Gt'] = (node, ctx, graph, edgesByDest) => {
  ctx.markNodeStart(node.id);
  const a = resolveInputExpression(node, 'a', graph, edgesByDest, ctx);
  const b = resolveInputExpression(node, 'b', graph, edgesByDest, ctx);
  const varName = ctx.newTmp('gt');
  ctx.emit(`auto ${varName} = (${a}) > (${b});`);
  const outPort = (node.outputs && node.outputs[0] && node.outputs[0].name) || 'out';
  ctx.assignSymbol(node.id, outPort, varName);
  ctx.markNodeEnd(node.id);
};

NODE_EMITTERS['Lte'] = (node, ctx, graph, edgesByDest) => {
  ctx.markNodeStart(node.id);
  const a = resolveInputExpression(node, 'a', graph, edgesByDest, ctx);
  const b = resolveInputExpression(node, 'b', graph, edgesByDest, ctx);
  const varName = ctx.newTmp('lte');
  ctx.emit(`auto ${varName} = (${a}) <= (${b});`);
  const outPort = (node.outputs && node.outputs[0] && node.outputs[0].name) || 'out';
  ctx.assignSymbol(node.id, outPort, varName);
  ctx.markNodeEnd(node.id);
};

NODE_EMITTERS['Gte'] = (node, ctx, graph, edgesByDest) => {
  ctx.markNodeStart(node.id);
  const a = resolveInputExpression(node, 'a', graph, edgesByDest, ctx);
  const b = resolveInputExpression(node, 'b', graph, edgesByDest, ctx);
  const varName = ctx.newTmp('gte');
  ctx.emit(`auto ${varName} = (${a}) >= (${b});`);
  const outPort = (node.outputs && node.outputs[0] && node.outputs[0].name) || 'out';
  ctx.assignSymbol(node.id, outPort, varName);
  ctx.markNodeEnd(node.id);
};

NODE_EMITTERS['Print'] = (node, ctx, graph, edgesByDest) => {
  ctx.markNodeStart(node.id);
  ctx.addInclude('<iostream>');
  const textExpr = resolveInputExpression(node, 'text', graph, edgesByDest, ctx);
  ctx.emit(`std::cout << ${textExpr} << std::endl;`);
  ctx.markNodeEnd(node.id);
};

NODE_EMITTERS['VarSet'] = (node, ctx, graph, edgesByDest) => {
  ctx.markNodeStart(node.id);
  const rawName = node.params?.name || node.params?.var || 'v';
  const name = sanitizeIdentifier(rawName);
  const expr = resolveInputExpression(node, 'value', graph, edgesByDest, ctx);
  ctx.emit(`auto ${name} = ${expr};`);
  // assign as output if present
  if (node.outputs && node.outputs[0]) ctx.assignSymbol(node.id, node.outputs[0].name, name);
  ctx.markNodeEnd(node.id);
};

NODE_EMITTERS['VarGet'] = (node, ctx) => {
  ctx.markNodeStart(node.id);
  const rawName = node.params?.name || node.params?.var || 'v';
  const name = sanitizeIdentifier(rawName);
  const outPort = (node.outputs && node.outputs[0] && node.outputs[0].name) || 'out';
  const varName = ctx.newTmp('get');
  ctx.emit(`auto ${varName} = ${name};`);
  ctx.assignSymbol(node.id, outPort, varName);
  ctx.markNodeEnd(node.id);
};

NODE_EMITTERS['Return'] = (node, ctx, graph, edgesByDest) => {
  ctx.markNodeStart(node.id);
  const v = resolveInputExpression(node, 'value', graph, edgesByDest, ctx);
  ctx.emit(`return ${v};`);
  ctx.markNodeEnd(node.id);
};

// Arg node: represents a function argument inside a function graph. It maps to a parameter name and produces that symbol.
NODE_EMITTERS['Arg'] = (node, ctx) => {
  ctx.markNodeStart(node.id);
  const rawName = node.params?.name || node.params?.var || 'arg';
  const name = sanitizeIdentifier(rawName);
  const outPort = (node.outputs && node.outputs[0] && node.outputs[0].name) || 'out';
  // Don't emit code; just map this node's output port to the parameter variable name.
  ctx.assignSymbol(node.id, outPort, name);
  ctx.markNodeEnd(node.id);
};

// If node supports inline then/else via params listing node ids
NODE_EMITTERS['If'] = (node, ctx, graph, edgesByDest) => {
  ctx.markNodeStart(node.id);
  const cond = resolveInputExpression(node, 'cond', graph, edgesByDest, ctx);
  ctx.emit(`if (${cond}) {`);
  const thenIds: string[] = node.params?.then || [];
  for (const nid of thenIds) {
    const n = graph.nodes.find((x) => x.id === nid);
    if (n) {
      const emitter = NODE_EMITTERS[n.type];
      if (emitter) emitter(n, ctx, graph, edgesByDest);
      else ctx.emit(`// Unknown node in then: ${n.type}`);
    }
  }
  ctx.emit('} else {');
  const elseIds: string[] = node.params?.else || [];
  for (const nid of elseIds) {
    const n = graph.nodes.find((x) => x.id === nid);
    if (n) {
      const emitter = NODE_EMITTERS[n.type];
      if (emitter) emitter(n, ctx, graph, edgesByDest);
      else ctx.emit(`// Unknown node in else: ${n.type}`);
    }
  }
  ctx.emit('}');
  ctx.markNodeEnd(node.id);
};

NODE_EMITTERS['CallFunction'] = (node, ctx, graph, edgesByDest) => {
  ctx.markNodeStart(node.id);
  const fnameOrig = node.params?.functionName;
  if (!fnameOrig) {
    ctx.emit('// CallFunction node missing functionName');
    ctx.markNodeEnd(node.id);
    return;
  }
  // If this is a user-defined function present in graph.functions, call the sanitized name
  let fname = fnameOrig;
  if (Array.isArray(graph.functions) && graph.functions.some((f) => f.name === fnameOrig)) {
    fname = sanitizeIdentifier(fnameOrig);
  }
  const args: string[] = [];
  for (const inp of node.inputs || []) {
    const expr = resolveInputExpression(node, inp.name, graph, edgesByDest, ctx);
    args.push(expr);
  }
  const call = `${fname}(${args.join(', ')})`;
  if (node.outputs && node.outputs[0]) {
    const varName = ctx.newTmp('call');
    ctx.emit(`auto ${varName} = ${call};`);
    ctx.assignSymbol(node.id, node.outputs[0].name, varName);
  } else {
    ctx.emit(`${call};`);
  }
  ctx.markNodeEnd(node.id);
};

// Plugin loader: reads plugins from plugins/ directory and registers emitters that wrap C++ functions
function validatePluginManifest(p: any): { ok: boolean; message?: string } {
  if (!p || typeof p !== 'object') return { ok: false, message: 'Plugin must be an object' };
  if (!p.name || typeof p.name !== 'string') return { ok: false, message: 'Plugin missing name string' };
  if (p.nodeType && typeof p.nodeType !== 'string') return { ok: false, message: 'nodeType must be string' };
  if (p.include && typeof p.include !== 'string') return { ok: false, message: 'include must be string' };
  if (p.signature && typeof p.signature !== 'string') return { ok: false, message: 'signature must be string' };
  if (p.params) {
    if (!Array.isArray(p.params)) return { ok: false, message: 'params must be array' };
    for (const param of p.params) {
      if (!param.name || typeof param.name !== 'string') return { ok: false, message: 'each param must have a name' };
      if (!param.kind || (param.kind !== 'input' && param.kind !== 'const' && param.kind !== 'output')) return { ok: false, message: 'param.kind must be input|const|output' };
    }
  }
  if (p.returns && typeof p.returns !== 'object') return { ok: false, message: 'returns must be object' };
  return { ok: true };
}

function loadPlugins(pluginDir: string) {
  const plugins: any[] = [];
  if (!fs.existsSync(pluginDir)) return plugins;
  const files = fs.readdirSync(pluginDir).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(pluginDir, f), 'utf8');
      const p = JSON.parse(raw);
      const valid = validatePluginManifest(p);
      if (!valid.ok) {
        console.error(`Skipping invalid plugin ${f}: ${valid.message}`);
        continue;
      }
      plugins.push(p);
      const nodeType = p.nodeType || p.name;
      NODE_EMITTERS[nodeType] = (node: Node, ctx: EmitterContext, graph: GraphIR, edgesByDest: Map<string, Edge[]>) => {
        ctx.markNodeStart(node.id);
        if (p.include) ctx.addInclude(p.include);
        const args: string[] = [];
        for (const param of p.params || []) {
          if (param.kind === 'input') {
            const expr = resolveInputExpression(node, param.name, graph, edgesByDest, ctx);
            args.push(expr);
          } else if (param.kind === 'const') {
            args.push(JSON.stringify(param.value));
          }
        }
        const call = `${p.name}(${args.join(', ')})`;
        if (p.returns && p.returns.type) {
          const varName = ctx.newTmp(nodeType.replace(/[^a-zA-Z0-9]/g, '_'));
          ctx.emit(`auto ${varName} = ${call};`);
          const outPort = (node.outputs && node.outputs[0] && node.outputs[0].name) || 'out';
          ctx.assignSymbol(node.id, outPort, varName);
        } else {
          ctx.emit(`${call};`);
        }
        ctx.markNodeEnd(node.id);
      };
    } catch (e) {
      console.error('Failed to load plugin', f, e);
    }
  }
  return plugins;
}

// Topological sort helper (Kahn). Excludes nodes in skipSet. Throws if cycle detected or if a node depends on a skipped node.
function topoSortNodes(nodes: Node[], edges: Edge[], skipSet: Set<string> = new Set()): Node[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n] as [string, Node]));
  const indegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  // initialize
  for (const n of nodes) {
    if (skipSet.has(n.id)) continue;
    indegree.set(n.id, 0);
    adj.set(n.id, []);
  }

  for (const e of edges || []) {
    // only consider edges where destination is not in skipSet
    if (skipSet.has(e.toNode)) continue;
    if (skipSet.has(e.fromNode)) {
      // dependency on a skipped node: cannot resolve in topological order
      throw new Error(`Node ${e.toNode} depends on inlined/skipped node ${e.fromNode}. Refactor graph so inlined nodes don't feed external nodes.`);
    }
    if (!indegree.has(e.toNode)) continue; // toNode might be skipped
    // register adjacency
    if (!adj.has(e.fromNode)) adj.set(e.fromNode, []);
    adj.get(e.fromNode)!.push(e.toNode);
    indegree.set(e.toNode, (indegree.get(e.toNode) || 0) + 1);
  }

  const q: string[] = [];
  for (const [id, deg] of indegree.entries()) if (deg === 0) q.push(id);

  const result: Node[] = [];
  while (q.length > 0) {
    const u = q.shift()!;
    const nu = nodeMap.get(u);
    if (nu) result.push(nu);
    for (const v of adj.get(u) || []) {
      indegree.set(v, indegree.get(v)! - 1);
      if (indegree.get(v) === 0) q.push(v);
    }
  }

  // If result does not contain all non-skipped nodes, there is a cycle
  const expected = Array.from(nodeMap.keys()).filter((id) => !skipSet.has(id)).length;
  if (result.length !== expected) {
    // find remaining nodes
    const remaining = [];
    for (const id of nodeMap.keys()) {
      if (!result.find((n) => n.id === id)) remaining.push(id);
    }
    throw new Error(`Cycle detected among nodes: ${remaining.join(', ')}`);
  }
  return result;
}

function emitGraphIntoContext(graph: GraphIR, ctx: EmitterContext, pluginDir: string) {
  if (Array.isArray(graph.imports)) for (const imp of graph.imports) ctx.addInclude(imp);
  loadPlugins(pluginDir);

  const edgesByDest = new Map<string, Edge[]>();
  for (const e of graph.edges || []) {
    const key = `${e.toNode}:${e.toPort}`;
    if (!edgesByDest.has(key)) edgesByDest.set(key, []);
    edgesByDest.get(key)!.push(e);
  }

  // Detect nodes that are inlined by control-flow nodes (e.g., If.then/else lists). These should not be emitted
  // at top-level because they'll be emitted inline by their container node.
  const inlinedNodeIds = new Set<string>();
  for (const node of graph.nodes || []) {
    if (node.type === 'If') {
      const thenIds: string[] = node.params?.then || [];
      const elseIds: string[] = node.params?.else || [];
      for (const t of thenIds) inlinedNodeIds.add(t);
      for (const e of elseIds) inlinedNodeIds.add(e);
    }
  }

  // perform topological sort of nodes excluding inlined nodes
  let orderedNodes: Node[];
  try {
    orderedNodes = topoSortNodes(graph.nodes || [], graph.edges || [], inlinedNodeIds);
  } catch (e) {
    // fallback: emit in original order but warn (keeps behavior stable)
    console.warn('Topological sort failed:', (e as Error).message, '\nFalling back to original node order. This may cause unresolved input errors.');
    orderedNodes = [...(graph.nodes || [])].filter((n) => !inlinedNodeIds.has(n.id));
  }

  const emitted = new Set<string>();
  for (const node of orderedNodes) {
    const emitter = NODE_EMITTERS[node.type];
    if (emitter) {
      emitter(node, ctx, graph, edgesByDest);
      emitted.add(node.id);
    } else {
      ctx.markNodeStart(node.id);
      ctx.emit(`// Unknown node type: ${node.type}`);
      ctx.markNodeEnd(node.id);
      emitted.add(node.id);
    }
  }

  // Emit any remaining nodes (control-flow containers etc.) that weren't emitted
  for (const node of graph.nodes || []) {
    if (inlinedNodeIds.has(node.id)) continue; // skip inlined nodes
    if (emitted.has(node.id)) continue; // already emitted
    const emitter = NODE_EMITTERS[node.type];
    if (emitter) emitter(node, ctx, graph, edgesByDest);
    else {
      ctx.markNodeStart(node.id);
      ctx.emit(`// Unknown node type: ${node.type}`);
      ctx.markNodeEnd(node.id);
    }
  }

  return ctx;
}

export function emitCppForGraph(graph: GraphIR, pluginDir = 'plugins'): { code: string; map: Record<string, { startLine: number; endLine: number }> } {
  // Validate first — fail fast if graph is invalid
  const validation = validateGraph(graph as any);
  if (!validation.ok) {
    console.error('Validation failed:');
    for (const d of validation.diagnostics) {
      console.error(`${d.severity.toUpperCase()}: ${d.message}${d.nodeId ? ' (node: ' + d.nodeId + (d.port ? ', port: ' + d.port : '') + ')' : ''}`);
    }
    throw new Error('Graph validation failed — aborting emit');
  }

  const globalIncludes = new Set<string>();
  // We'll collect function contexts so we can emit prototypes first then bodies and compute absolute line mapping robustly
  const functionsData: { f: FunctionIR; ctx: EmitterContext; signature: string }[] = [];

  for (const f of graph.functions || []) {
    const fctx = new EmitterContext();
    // emit the function body into its own context; Arg nodes will map parameter names to symbols
    emitGraphIntoContext(f.graph, fctx, pluginDir);
    for (const inc of fctx.includes) globalIncludes.add(inc);

    // Build function signature from function IR if signature wasn't provided
    let signature = f.signature;
    if (!signature) {
      // Prefer declared params, otherwise infer from Arg nodes inside function graph
      let paramsArr: string[] = [];
      if (Array.isArray(f.params) && f.params.length > 0) {
        paramsArr = (f.params || []).map((p) => `${p.type || 'int'} ${sanitizeIdentifier(p.name)}`);
      } else {
        const argNodes = (f.graph.nodes || []).filter((n: Node) => n.type === 'Arg');
        paramsArr = argNodes.map((n: Node) => {
          const pnameRaw = n.params?.name || n.params?.var || 'arg';
          const pname = sanitizeIdentifier(pnameRaw);
          const ptype = (n.params && n.params.type) || 'int';
          return `${ptype} ${pname}`;
        });
      }
      const paramList = paramsArr.join(', ');
      const retType = (f.returns && f.returns.type) || 'int';
      signature = `${retType} ${sanitizeIdentifier(f.name)}(${paramList})`;
    } else {
      // If signature provided, sanitize the function name and parameter names where possible
      // attempt a simple replacement: replace function name token before '('
      signature = signature.replace(/^(\s*\w+)/, (m) => sanitizeIdentifier(m));
    }

    // Ensure return exists or append later when composing
    functionsData.push({ f, ctx: fctx, signature });
  }

  // Collect includes from main graph as well
  const mainCtx = new EmitterContext();
  emitGraphIntoContext(graph, mainCtx, pluginDir);
  for (const inc of mainCtx.includes) globalIncludes.add(inc);

  // Build final lines array with includes, prototypes, function bodies, then main
  const finalLines: string[] = [];
  for (const inc of Array.from(globalIncludes)) finalLines.push(`#include ${inc}`);
  finalLines.push('');

  // Emit prototypes
  for (const fd of functionsData) {
    finalLines.push(`${fd.signature};`);
  }
  if (functionsData.length > 0) finalLines.push('');

  // Emit function bodies and record mapping using fd.ctx.nodeLineMap which is relative to fd.ctx.bodyLines
  const map: Record<string, { startLine: number; endLine: number }> = {};
  for (const fd of functionsData) {
    // signature line
    finalLines.push(`${fd.signature} {`);
    const bodyStartLine = finalLines.length + 1; // first body line will be this index (1-based)
    // add body lines (with indentation)
    for (const bl of fd.ctx.bodyLines) {
      finalLines.push('  ' + bl);
    }
    // ensure return if no return found and function non-void
    if (!fd.ctx.bodyLines.some((l) => l.trim().startsWith('return'))) {
      if (!/^void\b/.test(fd.signature)) finalLines.push('  return 0;');
    }
    finalLines.push('}');
    finalLines.push('');

    // map nodes
    for (const [nodeId, rng] of fd.ctx.nodeLineMap.entries()) {
      // rng.startLine is 1-based within fd.ctx.bodyLines; map to finalLines absolute numbering
      const absStart = bodyStartLine + (rng.startLine - 1);
      const absEnd = bodyStartLine + (rng.endLine - 1);
      map[nodeId] = { startLine: absStart, endLine: absEnd };
    }
  }

  // Emit main function
  finalLines.push('int main() {');
  const mainBodyStart = finalLines.length + 1;
  for (const l of mainCtx.bodyLines) finalLines.push('  ' + l);
  if (!mainCtx.bodyLines.some((l) => l.trim().startsWith('return'))) finalLines.push('  return 0;');
  finalLines.push('}');

  // Map main nodes
  for (const [nodeId, rng] of mainCtx.nodeLineMap.entries()) {
    const absStart = mainBodyStart + (rng.startLine - 1);
    const absEnd = mainBodyStart + (rng.endLine - 1);
    map[nodeId] = { startLine: absStart, endLine: absEnd };
  }

  const code = finalLines.join('\n');
  return { code, map };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: node cppEmitter.js <graph.json> [output.cpp] [pluginDir]');
    process.exit(2);
  }
  const graphFile = args[0];
  const outFile = args[1] || 'out.cpp';
  const pluginDir = args[2] || 'plugins';
  const raw = fs.readFileSync(graphFile, 'utf8');
  const graph = JSON.parse(raw);

  // Validate before emitting and print diagnostics if present
  const validation = validateGraph(graph as any);
  if (!validation.ok) {
    console.error('Validation failed:');
    for (const d of validation.diagnostics) {
      console.error(`${d.severity.toUpperCase()}: ${d.message}${d.nodeId ? ' (node: ' + d.nodeId + (d.port ? ', port: ' + d.port : '') + ')' : ''}`);
    }
    process.exit(1);
  }

  const res = emitCppForGraph(graph, pluginDir);
  fs.writeFileSync(outFile, res.code, 'utf8');
  fs.writeFileSync(outFile + '.map.json', JSON.stringify(res.map, null, 2), 'utf8');
  console.log(`Generated ${outFile} and ${outFile}.map.json`);
}
