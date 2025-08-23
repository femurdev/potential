Graph IR Schema — Reference

Overview
This document describes the JSON Intermediate Representation (IR) used by the Graph-to-C++ project. The IR is the canonical, serializable form of a visual program created in the graph editor. The emitter (CppEmitter) consumes the IR and emits C++.

Top-level structure
{
  "meta": { "name": "...", "version": "..." },
  "imports": ["<iostream>", "<cmath>"],
  "nodes": [ ... ],
  "edges": [ ... ],
  "functions": [ ... ],
  "libraryNodes": [ ... ]
}

Fields
- meta (optional): metadata about the graph. Common keys: name, description, version, author.
- imports (optional): array of strings; each string should be a C++ include (e.g., "<iostream>") that the emitter will insert at the top of generated C++.
- nodes (required): array of node objects (see Node object below).
- edges (required): array of edge objects (see Edge object below).
- functions (optional): array of function definitions (subgraphs). Each element includes name, optional signature, and graph (a Graph IR object) for the function body.
- libraryNodes (optional): array of plugin descriptors (usually read from plugin JSON files). Not required in the graph file; plugins typically live in plugins/ and are auto-loaded by the emitter.

Node object
A node represents an operation, constant, variable, or control-flow construct.
Required properties:
- id: string — unique identifier for the node (e.g., "n1").
- type: string — node type name (e.g., "Add", "Print", "Lib_sin").

Optional properties:
- label: string — UI label or human-readable name.
- inputs: array of Port objects — describes input ports and their types.
- outputs: array of Port objects — describes output ports and their types.
- params: object — node-specific parameters, such as constant values, functionName for CallFunction nodes, or UI-specific settings.
- function: string — function name if the node belongs to a subgraph function.
- position: { x: number, y: number } — optional UI position information.

Port object
- name: string — port name used in edges and emitter mapping (e.g., "a", "b", "text").
- type: string — type string such as "int", "double", "string", "bool". You can extend with custom types.

Edge object
Represents a connection from an output port of one node to an input port of another node.
- fromNode: string — id of source node.
- fromPort: string — name of the output port on the source node.
- toNode: string — id of destination node.
- toPort: string — name of the input port on the destination node.

Functions (subgraphs)
Each function entry allows you to define a named function as a nested Graph IR. Example:
{
  "name": "myFunc",
  "signature": "int myFunc(int a, int b)",
  "graph": { ... }  // full Graph IR
}
The emitter compiles these functions before main(), collects includes required by their bodies, and inserts them in final C++ output.

Plugins / Library node descriptors
Plugins are typically stored in plugins/*.json and describe how to wrap external C++ functions into nodes. Example manifest:
{
  "name": "sin",
  "nodeType": "Lib_sin",
  "include": "<cmath>",
  "signature": "double sin(double)",
  "params": [ { "name": "x", "type": "double", "kind": "input" } ],
  "returns": { "type": "double" }
}
When a node in the graph has type "Lib_sin", the emitter inserts #include <cmath> and emits a call sin(arg).

Conventions and recommendations
- Node ids should be stable and unique. When serializing from the UI, try to preserve ids to enable better diffs and versioning.
- Ports should be explicitly typed whenever possible. The validator performs basic type checks.
- For control-flow nodes (If, While), the node.params may contain lists of node ids for then/else subpaths. Alternatively, dedicated subgraph nodes can be used for more complex control flow.

Example (hello world)
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

Notes
This schema is intentionally flexible to enable rapid iteration. For production use, consider creating a strict JSON Schema file (e.g., schema/graph-ir.schema.json) and running validation as part of CI.
