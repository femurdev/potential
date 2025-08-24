User Guide — NodeGraphCPP

Overview
NodeGraphCPP is a visual, node-and-graph-based programming environment that compiles visual graphs into C++ and (optionally) runs them in a sandbox or as WebAssembly. This guide helps end users build simple programs, save/load graphs, and run them locally using the included tooling.

Quick Start (Hello World)
1. Open the Graph Editor (frontend) and create nodes:
   - Add a Literal node with value: "Hello, World!"
   - Add a Print node.
   - Connect Literal -> Print with a data edge.
2. Save the graph to JSON (File → Export) as examples/hello_world.json.
3. Validate the IR (requires Node.js):
   node compiler/validator.js examples/hello_world.json

4. Emit C++:
   node compiler/cpp_emitter.js examples/hello_world.json > out_hello.cpp

5. Compile & run (native):
   g++ out_hello.cpp -std=c++17 -O2 -o out_hello && ./out_hello

6. (Optional) Use the test harness (Python 3) to run emit+compile for an example:
   python3 scripts/test_emit_compile.py examples/hello_world.json

IR basics (for authors)
- Top-level object keys:
  - nodes: array of node objects { id, type, props?, inputs?, outputs? }
  - edges: array of edges { from, to, fromPort?, toPort?, kind?: 'data'|'control' }
  - functions: array of function definitions { name, signature?, graph }
  - imports: optional list of C++ includes to inject

- Recommended node fields:
  - id (string): unique node identifier (use short stable ids, e.g. n1)
  - type (string): node type name (Add, Literal, Print, VarDecl, If, While, Call, ...)
  - props (object): node-specific configuration (e.g., for Literal: { value: 42 })
  - inputs/outputs (optional): arrays describing named ports when needed

Edge kinds
- data (default): carries values from producer nodes to consumer nodes.
- control: orders execution and sequences side-effects (Print, VarSet).

Example IR
{
  "nodes": [
    { "id": "n1", "type": "Literal", "props": { "value": "Hello, World!" } },
    { "id": "n2", "type": "Print" }
  ],
  "edges": [
    { "from": "n1", "to": "n2", "kind": "data" }
  ],
  "imports": ["<iostream>"]
}

Using the Graph Runner for quick preview
- scripts/js_graph_runner.js evaluates many graphs directly in Node without generating C++.
- Useful for fast iteration; it supports Literal, Add/Sub/Mul/Div, LessThan, VarDecl, VarSet, VarGet, Print, If, While (best-effort).
- Run:
  node scripts/js_graph_runner.js examples/hello_world.json

Plugins and external libraries
- External C++ functions are represented by plugin manifests in the plugins/ folder.
- Plugins supply: nodeType or name, include (e.g. "<cmath>"), function name and signature.
- The emitter will auto-insert #include lines for used plugins. On hosted systems only admin-approved plugins should be allowed.

Troubleshooting
- Validation fails: run the validator and fix missing node ids, unknown references, or port mismatches.
- Emitter crashes: check emitter stderr (node compiler/cpp_emitter.js ...) and report the node id reported in comments in the generated C++.
- Compilation errors: inspect the generated C++ for missing includes or mismatched types; use the mapping JSON (examples/<ir>.cpp.map.json) to find the source node.

Next steps for users
- Learn to use named ports when working with functions that have multiple parameters.
- Use control edges to sequence Print and other side-effects.
- Explore examples in the examples/ directory: function_simple.json, if_example.json, while_counter.json.

Safety note (when running compiled code)
- If you compile and run user-generated code on a server, always run the compilation and execution inside a sandbox/container with resource limits and no network access. See docs/host_setup.md for guidance on safe hosting.

