Graph-to-C++ — Host & End-User Guide

Overview

This repository implements a visual node-and-graph-based programming system that serializes graphs as JSON IR and emits compilable C++.

There are two audiences for this guide:
- Host / developer: people who run or extend the system (setup, build, add plugins, run compilers or backends).
- End user: people who author graphs with the UI or by hand and want to emit/compile/run C++.

Quick repository layout

- docs/: documentation and the IR schema (IR_SCHEMA.md)
- examples/: example graph JSONs (hello_world.graph.json, add.graph.json, function.graph.json, ...)
- plugins/: JSON manifests that map nodes to external C++ functions (e.g., sin.json)
- scripts/: small JS emitters and helper scripts for prototyping (emit_simple.js, emit_with_functions.js, compile_and_map.js)
- src/emitter/: TypeScript CppEmitter (src/emitter/cppEmitter.ts) — primary emitter implementation
- src/validator/: graph validator (cycle detection, type checks)
- src/runner/: JS runner to execute graphs in JS for quick preview
- frontend/: React UI skeleton (components for NodePalette and GraphEditor)

Requirements

- Node.js (>=14) and npm
- A C++ toolchain (g++ or clang++) for server-side compilation
- Optionally: Emscripten if you want to build a WASM execution pipeline

Host / Developer: Setup & Common Tasks

1) Install dependencies

  npm install

2) Build TypeScript sources

  npm run build

3) Emit C++ using the compiled emitter (dist)

  npm run emit

This runs the emitter on examples/add.graph.json and writes out.cpp. You can override by running the emitter script directly with a graph file.

4) Emit using the prototype scripts (quick)

For quick testing you can use the JS prototype emitter which does not require building the TS sources:

  node scripts/emit_simple.js examples/hello_world.graph.json out_hello.cpp
  node scripts/emit_simple.js examples/add.graph.json out_add.cpp
  node scripts/emit_with_functions.js examples/function.graph.json out_func.cpp

5) Compile the generated C++

  g++ -std=c++17 out_add.cpp -o out_add && ./out_add

There is a helper script that will compile and map compiler errors back to node ids using a JSON map when available (scripts/compile_and_map.js). The TypeScript emitter produces a map for nodes when used; the simple prototype scripts do not.

Using the JS Runner (fast preview)

The JS runner executes graph logic inside Node.js (no C++). This is useful for validating logic and types before emitting C++.

  npm run run-js

This invokes dist/runner/jsRunner.js on examples/add.graph.json. The runner supports a subset of the node types.

End User: Authoring Graphs

1) Use the frontend (React)

The frontend folder contains a minimal GraphEditor and NodePalette components. The UI is a starting point — to run it locally:

  cd frontend
  npm install
  npm start

The editor supports:
- Drag & drop of nodes (palette provided)
- Wiring inputs/outputs
- Exporting the graph to JSON
- Importing example graphs from examples/

2) Graph IR (summary)

Read docs/IR_SCHEMA.md for the full schema. Minimal example (hello world):

{
  "meta": { "name": "hello-world" },
  "nodes": [
    {
      "id": "print1",
      "type": "Print",
      "inputs": [{ "name": "text", "type": "string" }],
      "params": { "text": "Hello World" }
    }
  ],
  "edges": []
}

3) Emitting and running

- Export the graph JSON from the UI or edit by hand (examples/ contains samples).
- Run the emitter (scripts or compiled TS emitter) to produce a .cpp file.
- Compile the .cpp with g++ and run the produced binary.

Plugins / External Libraries

Plugins allow node types to wrap external C++ functions and automatically add includes. Place plugin JSON manifests in plugins/; they are auto-loaded by the TypeScript emitter.

Example plugin (plugins/sin.json):
{
  "name": "sin",
  "nodeType": "Lib_sin",
  "include": "<cmath>",
  "signature": "double sin(double)",
  "params": [ { "name": "x", "type": "double", "kind": "input" } ],
  "returns": { "type": "double" }
}

To use the plugin, add a node of type "Lib_sin" in your graph and connect an input. The emitter will insert #include <cmath> and generate a call sin(arg).

Extending the system (developers)

- Add node emitters: modify src/emitter/cppEmitter.ts and provide an emitter function in NODE_EMITTERS for the new node type. The emitter API provides EmitterContext (includes, bodyLines, symbolTable).
- Add plugins: drop JSON manifests into plugins/. The emitter's plugin loader will auto-register node emitters for those plugins.
- Improve validator: add rules in src/validator/graphValidator.ts (type checks, signatures, cycle detection exceptions for valid loops).
- Implement the backend compiler service (see Execution Backends below).

Execution Backends

Two main options:
1) Server-side sandbox: run g++/clang++ inside a sandbox (Docker container or restricted environment). Expose an API:
   POST /compile -> accepts graph.json, returns compilation result and/or binary (or run output). Use compile_and_map.js for error mapping.
2) Client-side WASM: use Emscripten to compile generated C++ to WebAssembly in the browser. This avoids sending source to the server but requires shipping Emscripten or using a server to compile to WASM and returning the .wasm module.

Security note: compiling arbitrary C++ is dangerous; always sandbox and limit resources (time, memory, filesystem) when exposing compilation.

Debugging & Mapping

- The TypeScript emitter can produce a node->generated-lines mapping (source map like) so compilation errors can be translated back to nodes. Use scripts/compile_and_map.js to demonstrate mapping.
- The JS Runner can be used for step-through debugging: extend src/runner/jsRunner.ts to provide trace logs per-node.

Roadmap / Next Steps

Priority items:
- Integrate ui with emitter for live preview & validation.
- Implement formal JSON Schema for the IR and enforce via validator.
- Implement function/subgraph emission with proper signatures and return mapping in the TypeScript emitter.
- Implement server-side sandbox or Emscripten pipeline for execution.
- Add optimizer passes (constant folding, dead code elimination).

Contributing

- Fork the repo, implement changes, and open PRs.
- Add tests (examples + expected generated C++ behavior) where possible.

Support

If you hit issues using the emitter or runner, check examples/ for working graphs and the scripts/ emitters for small, easy-to-follow implementations.


