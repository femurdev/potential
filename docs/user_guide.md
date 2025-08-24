NodeGraphCPP — User Guide

Overview

NodeGraphCPP is a visual graph-to-C++ system: users build programs by wiring nodes in a graph, the graph is serialized to a JSON IR, and the compiler emits compilable C++ (native or WASM). The project supports math/logic nodes, variables, control-flow, functions (subgraphs), and external C++ libraries via plugins.

This guide explains how to use the repo locally, the IR format, available examples, how to emit & compile code, and how to author simple plugins.

Quick Start (developer / end-user)

Prerequisites
- Node.js (v16+ recommended; Node 18 used in CI)
- Python 3 (for test harness)
- g++ (or clang++) for native compile tests
- Optional: Docker if you want sandboxed compile

Run the example (hello world)
1. Validate the IR:
   node compiler/validator.js examples/hello_world.json

2. Emit C++:
   node compiler/cpp_emitter.js examples/hello_world.json > out_hello.cpp

3. Compile & run (native):
   g++ out_hello.cpp -std=c++17 -O2 -o out_hello && ./out_hello

4. Run the automated smoke test (validator -> emitter -> compile -> run):
   python3 scripts/test_emit_compile.py examples/hello_world.json

IR (Intermediate Representation)

Top-level JSON structure
{
  "nodes": [ ... ],
  "edges": [ ... ],
  "functions": [ ... ],
  "imports": ["<iostream>"]
}

Node object (minimal)
{
  "id": "n1",
  "type": "Add",
  "props": { ... },
  "inputs": [{"name":"a","type":"double"}],
  "outputs": [{"name":"out","type":"double"}]
}

Edge object
{
  "from": "n2",
  "fromPort": "out",     // optional for single-port nodes, required when node has multiple ports
  "to": "n1",
  "toPort": "a",
  "kind": "data"         // "data" (default) or "control"
}

Notes
- Use kind:"control" for execution-order edges (control-flow, body boundaries, side-effect ordering).
- Use fromPort/toPort to disambiguate multi-input nodes and to map function parameters reliably.

Core node types (built-in)
- Literal: props.value
- Print: displays input(s) or props.text
- Add/Sub/Mul/Div: binary numeric ops
- LessThan: binary comparison -> bool
- VarDecl: props.varName, props.varType (int/double/bool/string), optional initialValue
- VarSet: props.varName (assignment)
- VarGet: props.varName (read variable value)
- If: 1 data input condition; control outputs for then/else (toPort 'then'/'else')
- While: 1 data input condition; control outgoing to body
- Call: props.functionName or top-level function mapping
- Return: for function subgraphs

Functions / Subgraphs
Functions are stored in the IR functions array:
{
  "name": "myFunc",
  "signature": "int myFunc(int a)",
  "graph": { "nodes": [...], "edges": [...] }
}
The emitter emits function definitions before main() (naive signature parsing is used currently).

Plugins (external C++ libraries)
Plugins are JSON manifests in plugins/*.json that describe mapping from node types to C++ functions. A structured manifest includes:
{
  "name": "sin",
  "nodeType": "Lib_sin",
  "include": "<cmath>",
  "function": "sin",
  "returnType": "double",
  "params": [{ "name": "x", "type": "double", "kind": "input" }],
  "supportedTargets": ["native","wasm"],
  "linkerFlags": "",
  "externC": false
}

Use the plugin validator to check a manifest:
node -e "console.log(require('./compiler/plugin_validator').validatePluginFile('plugins/sin.json'))"

Examples
- examples/hello_world.json — print a literal string
- examples/function_simple.json — shows a function subgraph and call
- examples/if_example.json — If node with control edges for then/else
- examples/while_counter.json — VarDecl, While, VarGet/VarSet, Add and Print (loop counter)

Test harness
- scripts/test_emit_compile.py automates validate->emit->compile->run for an example IR. Use python3.

Emitter & Validator overview
- Validator (compiler/validator.js): checks nodes/edges, port usage, type inference (basic), and data-cycle detection (excludes control edges). Use it to validate IR before emitting.
- Emitter (compiler/cpp_emitter.js): loads plugins, collects includes, topologically emits data nodes, emits functions and main(), maps plugins to calls, and supports control nodes (If/While) and variables. It produces C++17 source.

Limitations (current)
- Control-flow: While emission requires correct recomputation of condition subgraph (the emitter is being improved to recompute condition inside loop). Validate examples show OK but ensure your IR puts the condition producer and loop body dependencies correctly.
- Frontend: the React/TS GraphEditor is a skeleton; it must be wired to serialize ports and set edge.kind correctly.
- Plugin security: manifests are validated but admin approval is recommended for hosted deployments.
- Compilation sandboxing: server-side compilation must be run in a sandbox (Docker); see host guide.

Authoring a simple plugin
1. Copy plugins/sin.json as a template and edit fields.
2. Validate with compiler/plugin_validator.js.
3. Place it in plugins/ and the emitter will load it (skips invalid plugins with a warning).
4. Use the nodeType name as a node type in your IR and connect inputs by port names matching params[].

Frontend integration notes
- The GraphEditor should serialize nodes with inputs/outputs port descriptors and edges with kind and fromPort/toPort fields.
- For realtime validation, call the validator endpoint or embed the validator logic in the frontend.

Getting help / contributing
- Add new nodes by updating validator & emitter semantics and providing frontend renderers.
- Write IR examples under examples/ and add them to CI for regression tests.
- Open an issue or PR describing node semantics and include example IR demonstrating behavior.

Next steps (suggested for end-users)
- Use the hello_world example to confirm the toolchain works locally.
- Build small graphs in the editor UI and export IR; validate on the command line before compiling.
- If you need external libraries, author a plugin manifest; test locally with the emitter and compile with g++.

Contact
- For hosting or integration questions, see docs/host_setup.md


