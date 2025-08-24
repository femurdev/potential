Host / Operator Guide — Graph-Blocks

Purpose
This guide explains how to deploy and operate the Graph-Blocks compile service safely in a production environment. The service compiles user-supplied graph IR into C++ and (by default) runs g++ inside a sandboxed container. Compiling arbitrary C++ is a high-risk operation — follow the checklist and recommendations below.

Prereqs
- Host OS: recent Linux distribution (Ubuntu/CentOS). Docker Engine (20.x+) installed and usable by the service account.
- Python 3.10+ (python3)
- Optional: GitHub Actions / CI runner for smoke tests

Repository layout (important files)
- project/scripts/compile_service.py — Flask HTTP endpoint that accepts IR and schedules sandboxed compile jobs (prefers Docker sandbox)
- project/scripts/docker_runner.py — wrapper used by the service to run a job in Docker with resource limits
- docker/sandbox/Dockerfile — sandbox image (must be built for host)
- docker/sandbox/seccomp.json — example seccomp profile (operator can customize)
- project/scripts/emit_and_compile.py — local developer CLI (IR -> .cpp -> compile -> run)
- project/compiler/allowed_includes.json — optional list of allowed #includes for plugins/external nodes
- project/examples — sample IRs to exercise the system

Building the sandbox image (operator)
1. From the repository root run:
   python3 -m pip install --upgrade pip
   docker build -t graph-compiler-sandbox -f docker/sandbox/Dockerfile .
2. Verify the image is present:
   docker images | grep graph-compiler-sandbox

Secure runtime defaults (recommended)
The docker_runner is designed to pass flags to the runtime. Ensure these defaults are enforced in your deployment:
- --cap-drop=ALL
- --security-opt=no-new-privileges
- --network=none
- --pids-limit (e.g., 128)
- --memory (e.g., 256m or configurable per job)
- --read-only rootfs and a writable bind only for the job workspace
- SANDBOX_SECCOMP should point to a conservative seccomp.json (see docker/sandbox/seccomp.json)

If you run Docker behind an orchestration layer (Kubernetes), map these flags to equivalent PodSecurityConstraints or runtimeClass (gVisor) settings and use an isolated namespace.

Non-root image and workspace
- The sandbox image must run processes as a non-root user. The provided Dockerfile already creates a non-root 'sandbox' user and sets workspace ownership.
- The runner mounts a per-job temporary workspace; never mount host sensitive directories (e.g., /home, /etc) into the container.

Environment variables and operator configuration
- SANDBOX_IMAGE (default: graph-compiler-sandbox) — name of the built image.
- SANDBOX_SECCOMP — path to seccomp profile to pass to docker run (optional but recommended).
- DOCKER_TIMEOUT — runner timeout (seconds) for docker run operations.
- DEV_ALLOW_FALLBACK — if set to '1', allows in-process compilation fallback (DEV only). Do NOT enable in production.
- DEV_FALLBACK_TOKEN — when using DEV_ALLOW_FALLBACK, set a strong token and require the X-DEV-FALLBACK-TOKEN header in requests.

Start the compile service (dev)
  python3 project/scripts/compile_service.py
By default the service binds to 127.0.0.1:5001. Do not expose this endpoint publicly without adding authentication and rate limits.

Startup safety check
- The service will refuse to permit in-process fallback when bound to non-local addresses unless DEV_FALLBACK_FORCE and a token are present. This prevents accidental RCE on hosts that are reachable by untrusted clients.

Operational checklist (before exposing publicly)
1. Build the sandbox image and verify docker_runner runs a job and returns workspace/output.json.
2. Configure SANDBOX_SECCOMP to an operator-reviewed seccomp.json.
3. Ensure the runner uses --cap-drop=ALL and --security-opt=no-new-privileges.
4. Confirm the sandbox image runs as non-root and workspace directories are isolated per-job.
5. Enable authentication and rate limiting in front of compile_service (API key, OAuth, or reverse-proxy with access controls).
6. Configure per-user quotas (max jobs / minute) and aggregate system quotas (max concurrent jobs).
7. Add monitoring/alerting for long-running or failed jobs; keep logs and artifact retention configured.

CI smoke tests (recommended)
- Add a job that builds the sandbox image and runs project/scripts/ci_run_tests.py which runs a set of sample IRs through the docker_runner. The CI job should upload emitted artifacts (C++ source, mapping, stderr) when tests fail.

Security smoke tests (examples)
- Forbidden-syscall test: compile and run a small C program inside the sandbox that tries to open a raw socket or call ptrace — the program should fail or be killed.
- Timeout test: submit a job that sleeps for a long time and confirm the runner enforces the timeout and removes the container.

Handling includes and external libraries
- By default, compile_service will inspect the IR and any node_defs the graph references and only permit includes present in project/compiler/allowed_includes.json if that file exists. Update this file cautiously; prefer explicit allowlists for the operator.

Logging & audit
- The compile_service and docker_runner should log: job id, client IP, time, image used, container id, resource limits, and whether fallback was used. Store logs centrally and retain them per compliance requirements.

Troubleshooting tips
- If containers remain running after failures: check docker_runner logs and restart the service; inspect systemd or service manager for orphaned processes.
- If compile_service fails with 'sandbox_unavailable': ensure Docker is installed and the image exists; check permissions of the service user to run Docker.
- If g++ inside container reports missing headers: ensure the sandbox image contains needed development packages or allow the include via allowed_includes only after review.

Operator TL;DR (minimum safe posture)
1. Build sandbox image.
2. Configure runner defaults: cap-drop, no-new-privs, network=none, memory/pids limits, read-only rootfs with writable workspace.
3. Set SANDBOX_SECCOMP to a conservative profile.
4. Do not enable DEV in-process fallback on public hosts.
5. Put the compile service behind an authenticated, rate-limited gateway.

For more details on CI integration and developer commands, see docs/developer.md and docs/end_user.md.
