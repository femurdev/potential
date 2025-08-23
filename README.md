Graph-to-C++ (node-and-graph visual language)

Overview
This project provides a visual node-and-graph-based programming environment that compiles JSON-serialized graphs to C++. It includes:
- An IR JSON schema (in-code)
- A TypeScript CppEmitter that converts the IR to C++
- A Validator for simple checks (cycle detection, type mismatches)
- A JS Runner to execute graphs for quick testing
- A plugin mechanism to wrap external C++ functions (plugins/*.json)
- A minimal frontend skeleton (React) for building graphs and exporting JSON

Quick start
1) Install dev deps:
   npm install
2) Build TypeScript:
   npm run build
3) Emit C++ from example graph:
   npm run emit
   (this generates out.cpp from examples/add.graph.json)
4) Compile & run the generated C++:
   g++ -std=c++17 out.cpp -o out && ./out

Run JS runner (fast preview without C++):
   npm run run-js

Validate graph:
   npm run validate

Extending
- Add node emitters in src/emitter/cppEmitter.ts: add functions to NODE_EMITTERS for new node types.
- Add validator rules in src/validator/graphValidator.ts.
- Add plugins as JSON files in plugins/*.json, they are auto-loaded by the emitter.

Next steps
- Implement richer control-flow translation (loop nodes -> while/for translation)
- Implement function/subgraph -> C++ function generation
- Integrate a full graph editor UI (react-flow) with drag/drop and wiring
- Add a server-side sandbox or Emscripten-based client-side compilation

