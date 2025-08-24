import React, { useState } from 'react';
import { NodePalette } from './NodePalette';

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
    // Posts to the prototype compile service at http://localhost:8080/compile
    const graph = { meta: { name: 'from-ui' }, nodes, edges, imports: [] };
    setRunning(true);
    setOutput('');
    try {
      const res = await fetch('http://localhost:8080/compile', {
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
        <pre style={{ maxHeight: '40vh', overflow: 'auto', background: '#f7f7f7', padding: 8 }}>{JSON.stringify({ nodes, edges }, null, 2)}</pre>
        <h4>Server output</h4>
        <pre style={{ maxHeight: '30vh', overflow: 'auto', background: '#111', color: '#bada55', padding: 8 }}>{output}</pre>
      </div>
    </div>
  );
}
