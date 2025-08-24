NodeGraphCPP — End User Guide

Overview
- NodeGraphCPP is a visual programming environment that lets you construct programs by connecting nodes in a graph and compile them to C++.
- Use the Graph Editor (frontend) to drag nodes (math, logic, control flow, variables, functions, I/O) and connect them with edges. Save as JSON IR and use the compiler (CppEmitter) to generate C++.

Quickstart
1. Open the Web Editor
   - Launch the web app (development: see docs/host_setup.md). The editor shows a Node Palette and a Canvas.
2. Create a simple program
   - Drag a Literal node (string) and a Print node.
   - Connect the Literal output to the Print input.
3. Validate & Export
   - Use the real-time validator to check types and cycles. Fix any warnings.
   - Export the graph to examples/<name>.json via File → Export.
4. Compile locally (CLI)
   - Generate C++: node compiler/cpp_emitter.js examples/<name>.json > out_<name>.cpp
   - Compile: g++ out_<name>.cpp -std=c++17 -O2 -o out_<name>
   - Run: ./out_<name>

Functions / Subgraphs
- Define functions (subgraphs) via the Function palette or "Create Function". Edit the function body as a subgraph and declare parameters and return type in the function header.
- Functions are serialized under the IR "functions" array and emitted as C++ functions.

Plugins & External Libraries
- The system supports plugin manifests that map node types to external C++ functions. See docs/PLUGIN_DEVELOPER.md for details on writing a plugin.

Debugging & Preview
- Use the JS Graph Runner (preview) for fast execution without compiling to C++ — helpful for iteration.
- If the C++ compiler reports errors, use the emitted mapping files (*.cpp.map.json) created by the emitter to map C++ lines back to graph nodes.

Troubleshooting
- If the emitter reports unhandled node types, either add the corresponding plugin or report the node type to the project maintainers.
- For infinite loops in compiled output during testing, check While condition nodes and ensure the condition depends on state that changes inside the loop.

Further reading
- docs/IR_SCHEMA.md — IR JSON schema summary
- docs/PLUGIN_DEVELOPER.md — plugin manifest format and examples
- docs/host_setup.md — how to run the server-side compile sandbox

Feedback
- File issues using the project repository issues page; include the exported IR file and compiler output to help triage.
