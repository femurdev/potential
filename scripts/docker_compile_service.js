// Dockerized compile-and-run HTTP service with separate compile and run phases.
// POST /compile  with JSON body: { graph: <graph JSON>, emitStyle: "simple"|"functions" }
// Responds with JSON: { success: bool, compile: { status, stdout, stderr }, run?: { status, stdout, stderr, timedOut } }

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function safeWriteTemp(prefix, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const file = path.join(dir, 'out.cpp');
  fs.writeFileSync(file, content, 'utf8');
  return { dir, file };
}

function emitCppFromGraph(graphObj, emitStyle = 'functions') {
  const tmpGraph = path.join(process.cwd(), 'tmp_graph.json');
  fs.writeFileSync(tmpGraph, JSON.stringify(graphObj, null, 2), 'utf8');
  const outCpp = path.join(process.cwd(), 'tmp_out.cpp');
  const emitter = emitStyle === 'simple' ? 'scripts/emit_simple.js' : 'scripts/emit_with_functions.js';
  const res = spawnSync('node', [emitter, tmpGraph, outCpp], { encoding: 'utf8' });
  if (res.status !== 0) {
    return { success: false, error: 'Emitter failed', stderr: res.stderr, stdout: res.stdout };
  }
  const code = fs.readFileSync(outCpp, 'utf8');
  return { success: true, code };
}

function dockerRun(args, timeoutMs) {
  try {
    return spawnSync('docker', args, { encoding: 'utf8', timeout: timeoutMs });
  } catch (e) {
    return { error: String(e), status: 1, stdout: '', stderr: String(e) };
  }
}

function compileInDocker(code, options = {}) {
  // options: { image, cpus, memoryMb, timeoutSec }
  const image = options.image || 'gcc:12';
  const cpus = options.cpus || '0.5';
  const memoryMb = options.memoryMb || 256; // MB
  const timeoutSec = options.timeoutSec || 3;
  const dockerTimeoutMs = (timeoutSec + 5) * 1000;

  const { dir } = safeWriteTemp('gcpp-', code);
  const workdir = '/work';

  // Common docker base args
  const baseArgs = [
    'run',
    '--rm',
    '--network', 'none',
    '--cpus', String(cpus),
    '--memory', `${memoryMb}m`,
    '--pids-limit', '64',
    '-v', `${dir}:${workdir}`
  ];

  // Compile phase
  const compileCmd = `g++ -std=c++17 -O2 ${path.join(workdir, 'out.cpp')} -o ${path.join(workdir, 'prog')}`;
  const compileArgs = baseArgs.concat([image, 'bash', '-lc', compileCmd]);
  const compileRes = dockerRun(compileArgs, dockerTimeoutMs);

  // Prepare response
  const compile = {
    status: compileRes.status === null ? 1 : compileRes.status,
    stdout: compileRes.stdout || '',
    stderr: compileRes.stderr || (compileRes.error ? compileRes.error : ''),
  };

  if (compile.status !== 0) {
    // Clean up temp dir
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    return { compile, run: null };
  }

  // Run phase (with timeout enforced)
  const runCmd = `timeout ${timeoutSec} ${path.join(workdir, 'prog')}`;
  const runArgs = baseArgs.concat([image, 'bash', '-lc', runCmd]);
  const runRes = dockerRun(runArgs, dockerTimeoutMs);

  const run = {
    status: runRes.status === null ? 1 : runRes.status,
    stdout: runRes.stdout || '',
    stderr: runRes.stderr || (runRes.error ? runRes.error : ''),
    timedOut: false,
  };

  // If Docker process was killed due to timeout it throws Error; spawnSync sets status = null and signal = 'SIGTERM' possibly
  if (runRes.status === null && runRes.signal) {
    run.timedOut = true;
  }

  // Clean up temp dir
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}

  return { compile, run };
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/compile') {
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const graph = payload.graph;
        const emitStyle = payload.emitStyle || 'functions';
        const emitRes = emitCppFromGraph(graph, emitStyle);
        if (!emitRes.success) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(emitRes));
          return;
        }
        const code = emitRes.code;
        // Compile & run in docker (separate phases)
        const result = compileInDocker(code, {
          image: process.env.SANDBOX_IMAGE || 'gcc:12',
          cpus: process.env.SANDBOX_CPUS || '0.5',
          memoryMb: process.env.SANDBOX_MEMORY_MB ? Number(process.env.SANDBOX_MEMORY_MB) : 256,
          timeoutSec: process.env.SANDBOX_TIMEOUT_SEC ? Number(process.env.SANDBOX_TIMEOUT_SEC) : 3
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: (result && result.compile && result.compile.status === 0 && result.run && result.run.status === 0), compile: result.compile, run: result.run }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body', detail: String(e) }));
      }
    });
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

const port = process.env.PORT || 8081;
server.listen(port, () => console.log(`Docker compile service listening on http://localhost:${port}/compile`));

// Usage: node scripts/docker_compile_service.js
// Ensure Docker is installed and running. POST JSON to http://localhost:8081/compile
