#!/usr/bin/env node
// Simple compile-and-run HTTP service (no Docker) for prototyping only.
// POST /compile  with JSON body: { graph: <graph JSON>, emitStyle: "simple"|"functions" }
// Responds with JSON: { success: bool, compileOutput, runOutput, errors }

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
  // emitStyle: 'simple' uses scripts/emit_simple.js, 'functions' uses scripts/emit_with_functions.js
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

function compileCpp(code) {
  const { dir, file } = safeWriteTemp('gcpp-', code);
  const bin = path.join(dir, 'prog');
  const args = ['-std=c++17', file, '-O2', '-o', bin];
  const res = spawnSync('g++', args, { encoding: 'utf8' });
  const compileOutput = { status: res.status, stdout: res.stdout, stderr: res.stderr, bin: bin };
  return compileOutput;
}

function runBinary(binPath, timeoutSec = 3) {
  try {
    const res = spawnSync(binPath, [], { encoding: 'utf8', timeout: timeoutSec * 1000 });
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
  } catch (e) {
    return { status: 1, error: String(e) };
  }
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
        const compileRes = compileCpp(code);
        if (compileRes.status !== 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, compile: compileRes }));
          return;
        }
        const runRes = runBinary(compileRes.bin);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, compile: compileRes, run: runRes }));
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

const port = process.env.PORT || 8080;
server.listen(port, () => console.log(`Compile service listening on http://localhost:${port}/compile`));

// Usage: node scripts/compile_service.js
// POST JSON to http://localhost:8080/compile
// Example payload: { "graph": <graph JSON>, "emitStyle": "functions" }
