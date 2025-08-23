import React, { useState } from 'react';
import { NodePalette } from './NodePalette';

export function GraphEditor() {
  const [nodes, setNodes] = useState<any[]>([]);
  const [edges, setEdges] = useState<any[]>([]);

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

  return (
    <div style={{ display: 'flex' }}>
      <NodePalette onAdd={(t) => addNode(t)} />
      <div style={{ flex: 1, padding: 12 }}>
        <h3>Canvas (placeholder)</h3>
        <button onClick={exportJson}>Export JSON</button>
        <pre>{JSON.stringify({ nodes, edges }, null, 2)}</pre>
      </div>
    </div>
  );
}
