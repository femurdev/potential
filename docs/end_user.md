End User Guide — Graph‑Blocks (Visual Graph → C++)

Overview
This guide shows how to use the Graph‑Blocks web editor to create programs by wiring nodes, save/load graphs (IR JSON), preview behavior in the browser, and compile & run using the server sandbox.

What you’ll see in the UI
- Palette: a list of node types you can drag into the canvas (Literal, Add, Sub, Mul, Div, Print, Call, Sin, VarGet/Set, If, While, Param/Return, etc.).
- Canvas: place nodes and connect edges between outputs and inputs.
- Subgraph / Functions: double‑click or open a function node to edit its subgraph as a function definition.
- Diagnostics panel: shows validation errors, compile errors mapped to nodes/ports, and suggested quick‑fixes.
- Snippet viewer: shows the emitted C++ snippet for the selected node (uses emitter source mapping).
- Buttons: `Preview (JS)`, `Compile & Run (sandbox)`, `Export JSON`.

Quickstart — Hello World
1) Create nodes
   - Drag a Literal node (string) and set value: "Hello, World!"
   - Drag a Print node.
   - Connect Literal -> Print input.
2) Preview (JS)
   - Click `Preview (JS)` to run the graph in the in‑browser JS runner. The console/preview pane shows the output (Hello, World!).
3) Compile & Run (sandbox)
   - Click `Compile & Run (sandbox)`. The editor will send the canonicalized IR to the server `/compile` endpoint. The server returns either successful stdout/stderr or compile errors mapped to nodes.
   - If successful, the server response contains stdout/stderr (shown in the UI).
4) Save / Export
   - Click `Export JSON` to download the IR file (graph.json). This file contains nodes, edges, functions and imports and can be re‑imported later.

Understanding IR JSON (short)
- Top‑level: { nodes: [...], edges: [...], functions: [...], imports: [...] }
- Node: { id: 'n1', type: 'Add', properties: { ... }, inputs: [...], outputs: [...] }
- Edge: { from: 'n2', to: 'n1', toPort?: 'a', fromPort?: 'out' }
- Function: { name: 'myFunc', params: [{name,type}], returnType, graph: { nodes, edges } }
- Imports: C++ includes the emitter will insert (e.g., "<iostream>").

Diagnostics & Source Mapping
When the backend compiles the generated C++, g++ errors are parsed and mapped back to nodes/ports using the emitter’s mapping. The Diagnostics panel shows an entry for each error/warning and, when available, the mapped node id and port. Clicking a diagnostic highlights the node on the canvas and the C++ snippet range it corresponds to.

Using named ports
Some nodes have named input ports (e.g., Add has inputs a and b). When creating edges you can specify which named port to connect to; the serializer will include toPort/fromPort in the edge. Using named ports avoids ambiguity and improves diagnostics.

Quick fixes
If the validator returns details (valid_ports / expected types), the diagnostics panel offers quick actions, such as reconnecting an edge to a valid port or inserting a Cast node.

Preview vs Compile
- Preview (JS) runs a JS interpreter in the browser — fast, safe, good for logic checks but limited (no C++ libraries).
- Compile & Run uses the server sandbox (Docker) to emit, compile (g++), and run the produced C++ — can use external C++ libraries (if allowed by operator) and produces more realistic results.

Limitations & safety
- The server compile endpoint may be disabled by the operator or restricted; the editor will indicate availability.
- When using shared/public deployments, be mindful of quotas and rate limits; heavy computations may time out or be rejected.

Troubleshooting
- `Validation failed`: click the diagnostic and read details — the validator usually suggests valid_ports or expected types.
- `Compile error` mapped to [no node mapping]: the error occurred in included headers or generated code region the emitter could not map precisely. Inspect the emitted C++ snippet to find the issue.
- `Sandbox unavailable`: contact the host/operator — Docker or the sandbox image may be missing or misconfigured.

Advanced: calling external C++ functions
- Add a Call node referencing a function from the IR.functions list, or use an external library node (e.g., Sin) from the palette.
- The emitter automatically inserts required #includes for allowed external libs defined in node_defs.json (subject to operator allowlist).

Saving & Sharing
- Export the JSON IR to share with others. Include node_defs.json version information when asking others to run it if your graph uses custom plugin nodes.

End of user guide — if you want a printable quickstart sheet or a video script showing the above steps, ask and I’ll produce it.