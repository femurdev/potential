import * as fs from "fs";
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
    if (typeof v === "string") return JSON.stringify(v);
    return JSON.stringify(v);
  }
  throw new Error(`Unconnected required input ${inputName} on node ${node.id}`);
}

// Register core node emitters
NODE_EMITTERS["Const"] = (node, ctx) => {
  ctx.markNodeStart(node.id);
  const outPort = (node.outputs && node.outputs[0] && node.outputs[0].name) || "out";
  const v = node.params?.value ?? 0;
  const varName = ctx.newTmp("const");
  if (typeof v === "string") {
    ctx.addInclude("<string>");
    ctx.emit(`auto ${varName} = std::string(${JSON.stringify(v)});`);
  } else {
    ctx.emit(`auto ${varName} = ${JSON.stringify(v)};`);
  }
  ctx.assignSymbol(node.id, outPort, varName);
  ctx.markNodeEnd(node.id);
};

NODE_EMITTERS["Add"] = (node, ctx, graph, edgesByDest) => {
  ctx.markNodeStart(node.id);
  const a = resolveInputExpression(node, "a", graph, edgesByDest, ctx);
  const b = resolveInputExpression(node, "b", graph, edgesByDest, ctx);
  const outPort = (node.outputs && node.outputs[0] && node.outputs[0].name) || "out";
  const varName = ctx.newTmp("add");
  ctx.emit(`auto ${varName} = (${a}) + (${b});`);
  ctx.assignSymbol(node.id, outPort, varName);
  ctx.markNodeEnd(node.id);
};

NODE_EMITTERS["Sub"] = (node, ctx, graph, edgesByDest) => {
  ctx.markNodeStart(node.id);
  const a = resolveInputExpression(node, "a", graph, edgesByDest, ctx);
  const b = resolveInputExpression(node, "b", graph, edgesByDest, ctx);
  const varName = ctx.newTmp("sub");
  ctx.emit(`auto ${varName} = (${a}) - (${b});`);
  const outPort = (node.outputs && node.outputs[0] && node.outputs[0].name) || "out";
  ctx.assignSymbol(node.id, outPort, varName);
  ctx.markNodeEnd(node.id);
};

NODE_EMITTERS["Mul"] = (node, ctx, graph, edgesByDest) => {
  ctx.markNodeStart(node.id);
  const a = resolveInputExpression(node, "a", graph, edgesByDest, ctx);
  const b = resolveInputExpression(node, "b", graph, edgesByDest, ctx);
  const varName = ctx.newTmp("mul");
  ctx.emit(`auto ${varName} = (${a}) * (${b});`);
  const outPort = (node.outputs && node.outputs[0] && node.outputs[0].name) || "out";
  ctx.assignSymbol(node.id, outPort, varName);
  ctx.markNodeEnd(node.id);
};

NODE_EMITTERS["Div"] = (node, ctx, graph, edgesByDest) => {
  ctx.markNodeStart(node.id);
  const a = resolveInputExpression(node, "a", graph, edgesByDest, ctx);
  const b = resolveInputExpression(node, "b", graph, edgesByDest, ctx);
  const varName = ctx.newTmp("div");
  ctx.emit(`auto ${varName} = (${a}) / (${b});`);
  const outPort = (node.outputs && node.outputs[0] && node.outputs[0].name) || "out";
  ctx.assignSymbol(node.id, outPort, varName);
  ctx.markNodeEnd(node.id);
};

NODE_EMITTERS["Mod"] = (node, ctx, graph, edgesByDest) => {
  ctx.markNodeStart(node.id);
  const a = resolveInputExpression(node, "a", graph, edgesByDest, ctx);
  const b = resolveInputExpression(node, "b", graph, edgesByDest, ctx);
  const varName = ctx.newTmp("mod");
  ctx.emit(`auto ${varName} = (${a}) % (${b});`);
  const outPort = (node.outputs && node.outputs[0] && node.outputs[0].name) || "out";
  ctx.assignSymbol(node.id, outPort, varName);
  ctx.markNodeEnd(node.id);
};

// Comparisons
NODE_EMITTERS["Eq"] = (node, ctx, graph, edgesByDest) => {
  ctx.markNodeStart(node.id);
  const a = resolveInputExpression(node, "a", graph, edgesByDest, ctx);
  const b = resolveInputExpression(node, "b", graph, edgesByDest, ctx);
  const varName = ctx.newTmp("eq");
  ctx.emit(`auto ${varName} = (${a}) == (${b});`);
  const outPort = (node.outputs && node.outputs[0] && node.outputs[0].name) || "out";
  ctx.assignSymbol(node.id, outPort, varName);
  ctx.markNodeEnd(node.id);
};

NODE_EMITTERS["Neq"] = (node, ctx, graph, edgesByDest) => {
  ctx.markNodeStart(node.id);
  const a = resolveInputExpression(node, "a", graph, edgesByDest, ctx);
  const b = resolveInputExpression(node, "b", graph, edgesByDest, ctx);
  const varName = ctx.newTmp("neq");
  ctx.emit(`auto ${varName} = (${a}) != (${b});`);
  const outPort = (node.outputs && node.outputs[0] && node.outputs[0].name) || "out";
  ctx.assignSymbol(node.id, outPort, varName);
  ctx.markNodeEnd(node.id);
};

NODE_EMITTERS["Lt"] = (node, ctx, graph, edgesByDest) => {
  ctx.markNodeStart(node.id);
  const a = resolveInputExpression(node, "a", graph, edgesByDest, ctx);
  const b = resolveInputExpression(node, "b", graph, edgesByDest, ctx);
  const varName = ctx.newTmp("lt");
  ctx.emit(`auto ${varName} = (${a}) < (${b});`);
  const outPort = (node.outputs && node.outputs[0] && node.outputs[0].name) || "out";
  ctx.assignSymbol(node.id, outPort, varName);
  ctx.markNodeEnd(node.id);
};

NODE_EMITTERS["Gt"] = (node, ctx, graph, edgesByDest) => {
  ctx.markNodeStart(node.id);
  const a = resolveInputExpression(node, "a", graph, edgesByDest, ctx);
  const b = resolveInputExpression(node, "b", graph, edgesByDest, ctx);
  const varName = ctx.newTmp("gt");
  ctx.emit(`auto ${varName} = (${a}) > (${b});`);
  const outPort = (node.outputs && node.outputs[0] && node.outputs[0].name) || "out";
  ctx.assignSymbol(node.id, outPort, varName);
  ctx.markNodeEnd(node.id);
};

NODE_EMITTERS["Lte"] = (node, ctx, graph, edgesByDest) => {
  ctx.markNodeStart(node.id);
  const a = resolveInputExpression(node, "a", graph, edgesByDest, ctx);
  const b = resolveInputExpression(node, "b", graph, edgesByDest, ctx);
  const varName = ctx.newTmp("lte");
  ctx.emit(`auto ${varName} = (${a}) <= (${b});`);
  const outPort = (node.outputs && node.outputs[0] && node.outputs[0].name) || "out";
  ctx.assignSymbol(node.id, outPort, varName);
  ctx.markNodeEnd(node.id);
};

NODE_EMITTERS["Gte"] = (node, ctx, graph, edgesByDest) => {
  ctx.markNodeStart(node.id);
  const a = resolveInputExpression(node, "a", graph, edgesByDest, ctx);
  const b = resolveInputExpression(node, "b", graph, edgesByDest, ctx);
  const varName = ctx.newTmp("gte");
  ctx.emit(`auto ${varName} = (${a}) >= (${b});`);
  const outPort = (node.outputs && node.outputs[0] && node.outputs[0].name) || "out";
  ctx.assignSymbol(node.id, outPort, varName);
  ctx.markNodeEnd(node.id);
};

NODE_EMITTERS["Print"] = (node, ctx, graph, edgesByDest) => {
  ctx.markNodeStart(node.id);
  ctx.addInclude("<iostream>");
  const textExpr = resolveInputExpression(node, "text", graph, edgesByDest, ctx);
  ctx.emit(`std::cout << ${textExpr} << std::endl;`);
  ctx.markNodeEnd(node.id);
};

NODE_EMITTERS["VarSet"] = (node, ctx, graph, edgesByDest) => {
  ctx.markNodeStart(node.id);
  const name = node.params?.name || node.params?.var || "v";
  const expr = resolveInputExpression(node, "value", graph, edgesByDest, ctx);
  ctx.emit(`auto ${name} = ${expr};`);
  // assign as output if present
  if (node.outputs && node.outputs[0]) ctx.assignSymbol(node.id, node.outputs[0].name, name);
  ctx.markNodeEnd(node.id);
};

NODE_EMITTERS["VarGet"] = (node, ctx) => {
  ctx.markNodeStart(node.id);
  const name = node.params?.name || node.params?.var || "v";
  const outPort = (node.outputs && node.outputs[0] && node.outputs[0].name) || "out";
  const varName = ctx.newTmp("get");
  ctx.emit(`auto ${varName} = ${name};`);
  ctx.assignSymbol(node.id, outPort, varName);
  ctx.markNodeEnd(node.id);
};

NODE_EMITTERS["Return"] = (node, ctx, graph, edgesByDest) => {
  ctx.markNodeStart(node.id);
  const v = resolveInputExpression(node, "value", graph, edgesByDest, ctx);
  ctx.emit(`return ${v};`);
  ctx.markNodeEnd(node.id);
};

// Arg node: represents a function argument inside a function graph. It maps to a parameter name and produces that symbol.
NODE_EMITTERS["Arg"] = (node, ctx) => {
  ctx.markNodeStart(node.id);
  const outPort = (node.outputs && node.outputs[0] && node.outputs[0].name) || "out";
  const name = node.params?.name || node.params?.var || "arg";
  // Don't emit code; just map this node's output port to the parameter variable name.
  ctx.assignSymbol(node.id, outPort, name);
  ctx.markNodeEnd(node.id);
};

// If node supports inline then/else via params listing node ids
NODE_EMITTERS["If"] = (node, ctx, graph, edgesByDest) => {
  ctx.markNodeStart(node.id);
  const cond = resolveInputExpression(node, "cond", graph, edgesByDest, ctx);
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
  ctx.emit(`} else {`);
  const elseIds: string[] = node.params?.else || [];
  for (const nid of elseIds) {
    const n = graph.nodes.find((x) => x.id === nid);
    if (n) {
      const emitter = NODE_EMITTERS[n.type];
      if (emitter) emitter(n, ctx, graph, edgesByDest);
      else ctx.emit(`// Unknown node in else: ${n.type}`);
    }
  }
  ctx.emit(`}`);
  ctx.markNodeEnd(node.id);
};

NODE_EMITTERS["CallFunction"] = (node, ctx, graph, edgesByDest) => {
  ctx.markNodeStart(node.id);
  const fname = node.params?.functionName;
  if (!fname) {
    ctx.emit(`// CallFunction node missing functionName`);
    ctx.markNodeEnd(node.id);
    return;
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
function loadPlugins(pluginDir: string) {
  const plugins: any[] = [];
  if (!fs.existsSync(pluginDir)) return plugins;
  const files = fs.readdirSync(pluginDir).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(pluginDir, f), 'utf8'));
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

function emitGraphIntoContext(graph: GraphIR, ctx: EmitterContext, pluginDir: string) {
  if (Array.isArray(graph.imports)) for (const imp of graph.imports) ctx.addInclude(imp);
  loadPlugins(pluginDir);
  const edgesByDest = new Map<string, Edge[]>();
  for (const e of graph.edges || []) {
    const key = `${e.toNode}:${e.toPort}`;
    if (!edgesByDest.has(key)) edgesByDest.set(key, []);
    edgesByDest.get(key)!.push(e);
  }
  for (const node of graph.nodes || []) {
    const emitter = NODE_EMITTERS[node.type];
    if (emitter) {
      emitter(node, ctx, graph, edgesByDest);
    } else {
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
  const functionStrings: string[] = [];
  const functionMaps: { name: string; map: Record<string, { startLine: number; endLine: number }> }[] = [];

  for (const f of graph.functions || []) {
    const fctx = new EmitterContext();
    // emit the function body into its own context; Arg nodes will map parameter names to symbols
    emitGraphIntoContext(f.graph, fctx, pluginDir);
    for (const inc of fctx.includes) globalIncludes.add(inc);
    const body = fctx.bodyLines.map((l) => '  ' + l).join('\n');
    let funcBody = body;
    // Build function signature from function IR if signature wasn't provided
    let signature = f.signature || (() => {
      const paramList = (f.params || []).map((p) => `${p.type || 'int'} ${p.name}`).join(', ');
      const retType = (f.returns && f.returns.type) || 'int';
      return `${retType} ${f.name}(${paramList})`;
    })();

    if (!fctx.bodyLines.some((l) => l.trim().startsWith('return'))) {
      if (!/^void\b/.test(signature)) funcBody += '\n  return 0;';
    }

    functionStrings.push(`${signature} {\n${funcBody}\n}`);
    const mapObj: Record<string, { startLine: number; endLine: number }> = {};
    for (const [k, v] of fctx.nodeLineMap.entries()) mapObj[k] = { startLine: v.startLine, endLine: v.endLine };
    functionMaps.push({ name: f.name, map: mapObj });
  }

  const mainCtx = new EmitterContext();
  emitGraphIntoContext(graph, mainCtx, pluginDir);
  for (const inc of mainCtx.includes) globalIncludes.add(inc);

  const includes = Array.from(globalIncludes).map((i) => `#include ${i}`).join('\n');
  const functionsPart = functionStrings.join('\n\n');
  const mainBody = mainCtx.bodyLines.map((l) => '  ' + l).join('\n');
  let mainFinalBody = mainBody;
  if (!mainCtx.bodyLines.some((l) => l.trim().startsWith('return'))) mainFinalBody += '\n  return 0;';

  const full = `${includes}\n\n${functionsPart}\n\nint main() {\n${mainFinalBody}\n}\n`;

  const map: Record<string, { startLine: number; endLine: number }> = {};
  const includeLines = includes.split('\n').filter((l) => l.trim().length > 0).length;
  let currentLine = includeLines + 2;

  for (const fstr of functionStrings) {
    const fLines = fstr.split('\n').length;
    const fm = functionMaps.shift();
    if (fm) {
      for (const [nodeId, rng] of Object.entries(fm.map)) {
        map[nodeId] = { startLine: currentLine + rng.startLine - 1, endLine: currentLine + rng.endLine - 1 };
      }
    }
    currentLine += fLines + 2;
  }

  currentLine += 1;
  for (const [nodeId, rng] of mainCtx.nodeLineMap.entries()) {
    map[nodeId] = { startLine: currentLine + rng.startLine - 1, endLine: currentLine + rng.endLine - 1 };
  }

  return { code: full, map };
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
