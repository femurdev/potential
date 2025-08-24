Graph-Blocks — Visual Node-and-Graph Programming to C++

Overview

Graph-Blocks is a visual programming environment that lets users build programs by connecting nodes in a graph. The graph serializes to a JSON IR, which the compiler core (validator + CppEmitter) translates to compilable C++.

Key features
- Visual graph editor (React/TypeScript) with a node palette and drag-and-drop wiring.
- Graph IR (JSON) with nodes, edges (with optional fromPort/toPort), functions (subgraphs), and imports.
- Compiler core: validator (topological sort, type checks) and CppEmitter (emits C++ with includes and functions).
- Node defs include external library metadata to auto-insert #includes and map node calls to library functions.
- Two execution modes: sandboxed server compile (Docker) and client-side JS preview runner (quick feedback).
- Diagnostics mapping: emitter produces mapping entries that map nodes/ports to emitted C++ line/column ranges so compiler errors can be shown on the visual graph.

Quickstart (developer)

Prereqs
- Python 3.10+ (use python3)
- Node.js & npm (for frontend dev)
- Docker (for sandboxed compilation)

Build the sandbox image
  python3 -m pip install --upgrade pip
  docker build -t graph-compiler-sandbox -f docker/sandbox/Dockerfile .

Run the compile service (dev)
  python3 project/scripts/compile_service.py

Start the frontend (in another terminal)
  cd project/frontend
  npm install
  npm start

Emit & compile a sample IR locally (no Docker required)
  python3 project/scripts/emit_and_compile.py project/examples/sum_ir.json

Run CI-like integration tests (requires Docker)
  python3 project/scripts/ci_run_tests.py

Files & important locations
- project/frontend/src — React editor and GraphSerializer
- project/compiler/node_defs.json — node metadata and external library info
- project/compiler/validator.py — IR validator and type checks
- project/compiler/cpp_emitter.py — C++ emitter and mapping logic
- project/scripts/emit_and_compile.py — helper CLI: normalize IR, emit, compile with g++
- project/scripts/compile_service.py — Flask compile API; prefers Docker sandbox
- docker/sandbox/* — sandbox Dockerfile and seccomp profile
- project/examples/* — sample IRs

Documentation
- docs/host_setup.md — host/operator guide
- docs/end_user.md — quick user guide for the editor
- docs/plugin_author.md — how to add external nodes / plugins

Security note
Do NOT expose the compile service to untrusted networks without authentication, quotas, and a hardened sandbox. See docs/host_setup.md for recommendations.

License & contribution
This project is provided for demo/educational use. Check LICENSE file in the repo root for terms. Contributions welcome—open a PR with tests and documentation updates.
