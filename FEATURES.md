Feature Brainstorm for Graph-to-C++ Project

Objective
Provide prioritized features, implementation notes, and short action items to evolve the node-and-graph visual language system into a production-ready toolchain that emits C++ and supports external libraries, WASM execution, and a usable web-based editor.

Priority: P0 (Must have)
- Rich node set
  - Arithmetic: Add, Sub, Mul, Div, Mod with type promotion rules
  - Logic: And, Or, Not, Equal, NotEqual, Lt, Gt, Lte, Gte
  - Data: Const, String, Array (vector), Struct (user type)
  - Variables: VarSet, VarGet, Declaration nodes
  - I/O: Print, Read (stdin), FileRead/FileWrite (plugin)
  - Control flow: If, While, For, Break, Continue
  - Functions: CallFunction node and FunctionDefinition subgraph
  - Notes: implement emitters and corresponding JS runner semantics
- IR Validation
  - Port-level type checking and coercion rules
  - Cycle detection (with exceptions for legitimate control loops)
  - Function signature verification
- Basic CppEmitter
  - Emit includes, functions, main
  - Map outputs to unique variable names
  - Support plugin loading for external functions
- JS Runner
  - Deterministic execution for preview + unit tests

Priority: P1 (High value)
- Frontend: Graph editor integration
  - Use react-flow or Rete.js for visual node editing and wiring
  - Subgraph/Function editing modal or nested canvas
  - Drag connection creation and deletion; port types visible
  - Real-time validation badges and tooltips
- Plugins / Library Integration
  - Plugin manifest schema with include, signature, nodeType, params, returns
  - Plugin loader in emitter and runtime
  - UI for installing/enabling plugins
- Function/subgraph compilation
  - Arguments/returns mapping
  - Name mangling and overload support
  - Capture local variable scopes
- Execution Backends
  - Server-side sandbox with Docker-based compile-run service (g++, clang++)
  - Client-side: Emscripten pipeline to compile emitted C++ to WASM (optional initial support via prebuilt toolchain)

Priority: P2 (Nice-to-have)
- IR Optimizer
  - Constant folding
  - Dead node elimination
  - Inline trivial functions
- Type inference + polymorphism
  - Infer concrete types where unspecified
  - Generic nodes/templates (e.g., Add works for ints/doubles)
- Debugging/Ux
  - Step-through execution (JS Runner + instrumentation)
  - Runtime visualization: color nodes as executed, show values on edges
  - Breakpoints and inspect variable values
- Testing + CI
  - Unit tests for validator, emitter, runner
  - Snapshot tests for emitted C++ code
  - GitHub Actions: run validator and ts build on PR

Stretch / Long-term (P3)
- Parallel graph execution for independent nodes (multithreading/WASM threads)
- Visual dataflow profiling (execution time per node)
- Live-edit compiled WASM: hot-reload code in browser
- Marketplace for plugins and example graphs

Implementation notes / constraints
- Emitters should ideally target an internal simple AST or templating system, not string concatenation only. This reduces bugs around scoping and formatting.
- Maintain symbol table: nodeId:port -> varName. For functions, a separate scope table.
- Control flow translation requires mapping graph structure to structured code (blocks) or using labels/goto as a fallback if necessary. Prefer structured constructs where possible.
- Plugin security: when using server-side compilation, sandbox plugin-provided includes/headers and disallow arbitrary system calls in sandbox.

Low-effort starter tasks (best-first)
1. Implement Add/Sub/Mul/Div emitters and corresponding nodes in examples and JS runner (done for Add, extend rest).
2. Improve validator: strengthen type checking, report port names and edges for errors. Add unit tests.
3. Integrate react-flow in frontend and wire add/export/import of graph JSON.
4. Implement CallFunction and FunctionDefinition emitters: generate function signature from subgraph params and return value.
5. Add plugin UI and a small set of plugins (math: sin, cos; string: stoi; time: chrono now wrapper).
6. Create Docker-based server-side compile runner with restricted time/memory and compile flags -O2 -std=c++17 -static (configurable).

Estimated effort (rough)
- Core emitter and runner improvements: 1-2 weeks
- Validator and tests: 3-5 days
- Frontend (react-flow integration): 1-2 weeks
- Plugins system + UI: 3-5 days
- Server-side sandbox: 1-2 weeks (depends on infra and security)

Actionables (next commits)
- Add more node emitters: Sub, Mul, Div, Mod, Comparison nodes
- Add better validation messages and sample unit tests
- Add react-flow based frontend scaffold and connect export/import
- Build a Docker-based sandbox example for server-side compilation

