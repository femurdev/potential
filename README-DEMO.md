Demo: how to run the compile service locally and POST an example IR

This project includes a sandboxed compile service that emits C++ from a graph IR, compiles it inside a Docker sandbox image, runs the binary, and returns structured results including mappings from emitted source back to graph nodes/ports.

Quick local demo (recommended for dev)

1) Build the sandbox Docker image

   From project root:

     docker build -t graph-compiler-sandbox -f docker/sandbox/Dockerfile .

2) Start the compile service (it will use the docker_runner wrapper)

     python3 project/scripts/compile_service.py

   By default the service listens on http://127.0.0.1:5001

   Note: For local convenience you can enable the unsafe in-process fallback when Docker is not available (dev only):

     export DEV_ALLOW_FALLBACK=1
     python3 project/scripts/compile_service.py

   Do NOT enable DEV_ALLOW_FALLBACK in production.

3) Use the provided example POST file to submit an IR

   A sample POST body is available at project/examples/post_sum.json. It wraps the sum example IR into the expected { "ir": ... } payload.

   Send it with curl:

     curl -s -X POST http://127.0.0.1:5001/compile \
       -H "Content-Type: application/json" \
       --data-binary @project/examples/post_sum.json | jq .

   Expected successful output shape (sample):

   {
     "success": true,
     "stdout": "7\n",
     "stderr": "",
     "mapping": [
       { "node_id": "n1", "start_line": 5, "end_line": 5, "start_col": 1, "end_col": 10, "port": null },
       ...
     ],
     "cpp": "// emitted C++ source..."
   }

Troubleshooting
- If you receive {"success": false, "error": "sandbox_unavailable"}, confirm Docker is running and the image graph-compiler-sandbox exists.
- If output.json is missing in the container, check the returned _container_stdout/_container_stderr fields for details.

CI Notes
- A GitHub Actions workflow (.github/workflows/compile-integration.yml) builds the sandbox image and runs the test script project/scripts/ci_run_tests.py. The CI runner must support Docker (GitHub-hosted ubuntu runners do).

Security reminder
- The compile service executes user-generated C++; run it only behind authentication, rate limits and quotas in production. Use the included seccomp example and consider gVisor/Firecracker for stronger isolation.
