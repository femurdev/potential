import React, { useState } from 'react';
import { NodePalette } from './NodePalette';

// Compile endpoint can be overridden by injecting window.__COMPILE_ENDPOINT at runtime (useful for dev).
const DEFAULT_COMPILE_ENDPOINT = (window as any).__COMPILE_ENDPOINT || 'http://localhost:8081/compile';

export function GraphEditor() {
  const [nodes, setNodes] = useState<any[]>([]);
  const [edges, setEdges] = useState<any[]>([]);
  const [output, setOutput] = useState<string>('');
  const [running, setRunning] = useState(false);

  function addNode(type: string) {
    const id = `${type.toLowerCase()}_${Date.now()}`;
    const node = { id, type, params: {}, inputs: [], outputs: [] };
    setNodes((n) => [...n, node]);
  }

  function exportJson() {
    const graph = { meta: { name: 'untitled' }, nodes, edges, imports: [] };
    const json = JSON.stringify(graph, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'graph.json';
    a.click();
  }

  async function compileAndRun() {
    const graph = { meta: { name: 'from-ui' }, nodes, edges, imports: [] };
    setRunning(true);
    setOutput('');
    try {
      const res = await fetch(DEFAULT_COMPILE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ graph, emitStyle: 'functions' }),
      });
      const data = await res.json();
      setOutput(JSON.stringify(data, null, 2));
    } catch (e) {
      setOutput(String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div style={{ display: 'flex' }}>
      <NodePalette onAdd={(t) => addNode(t)} />
      <div style={{ flex: 1, padding: 12 }}>
        <h3>Canvas (placeholder)</h3>
        <div style={{ marginBottom: 8 }}>
          <button onClick={exportJson}>Export JSON</button>
          <button onClick={compileAndRun} style={{ marginLeft: 8 }} disabled={running}>
            {running ? 'Running...' : 'Compile & Run (server)'}
          </button>
        </div>
        <p style={{ color: '#666', fontSize: 12 }}>
          Using compile endpoint: {DEFAULT_COMPILE_ENDPOINT}
        </p>
        <pre style={{ maxHeight: '40vh', overflow: 'auto', background: '#f7f7f7', padding: 8 }}>{JSON.stringify({ nodes, edges }, null, 2)}</pre>
        <h4>Server output</h4>
        <pre style={{ maxHeight: '30vh', overflow: 'auto', background: '#111', color: '#bada55', padding: 8 }}>{output}</pre>
      </div>
    </div>
  );
}
