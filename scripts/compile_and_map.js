const { spawnSync } = require('child_process');
const fs = require('fs');

function compileAndMap(sourceFile, mapFile, outBinary, compileArgs=[]) {
  // compile
  const args = ['-std=c++17', sourceFile, '-O2', '-o', outBinary].concat(compileArgs);
  const res = spawnSync('g++', args, { encoding: 'utf8' });

  const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));

  if (res.status === 0) {
    console.log('Compilation succeeded. Binary:', outBinary);
    if (res.stderr) console.error(res.stderr);
    return 0;
  }

  // parse stderr for lines matching: file:line:col: error: message
  const stderr = res.stderr || '';
  const lines = stderr.split('\n');
  const re = /^(.*?):(\d+):(\d+):\s*(warning|error):\s*(.*)$/;
  for (const l of lines) {
    const m = re.exec(l);
    if (m) {
      const file = m[1];
      const lineNum = parseInt(m[2], 10);
      const col = parseInt(m[3], 10);
      const kind = m[4];
      const msg = m[5];
      // map lineNum to nodeId via map
      let found = null;
      for (const [nodeId, rng] of Object.entries(map)) {
        if (lineNum >= rng.startLine && lineNum <= rng.endLine) {
          found = { nodeId, rng };
          break;
        }
      }
      if (found) {
        console.error(`${kind.toUpperCase()}: ${msg}`);
        console.error(`  at generated ${file}:${lineNum}:${col} -> node ${found.nodeId} (generated lines ${found.rng.startLine}-${found.rng.endLine})`);
      } else {
        console.error(`${kind.toUpperCase()}: ${msg}`);
        console.error(`  at ${file}:${lineNum}:${col} (no mapping to node)`);
      }
    } else if (l.trim().length>0) {
      console.error(l);
    }
  }
  return res.status || 1;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.error('Usage: node compile_and_map.js <source.cpp> <map.json> <outBinary> [extra g++ args...]');
    process.exit(2);
  }
  const source = args[0];
  const map = args[1];
  const out = args[2];
  const extra = args.slice(3);
  const code = compileAndMap(source, map, out, extra);
  process.exit(code);
}
