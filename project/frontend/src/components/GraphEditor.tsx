import React, { useState, useMemo } from 'react';
import { canonicalizeGraph, GraphIR } from '../../frontend/src/GraphSerializer';

// Compile endpoint can be overridden by injecting window.__COMPILE_ENDPOINT at runtime (useful for dev).
const DEFAULT_COMPILE_ENDPOINT = (window as any).__COMPILE_ENDPOINT || 'http://localhost:5001/compile';

export function GraphEditor() {
  const [nodes, setNodes] = useState<any[]>([]);
  const [edges, setEdges] = useState<any[]>([]);
  const [output, setOutput] = useState<string>('');
  const [running, setRunning] = useState(false);
  const [errors, setErrors] = useState<any[]>([]);
  const [emittedCpp, setEmittedCpp] = useState<string>('');
  const [mappings, setMappings] = useState<any[]>([]);

  // selection state for clickable diagnostics
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedPort, setSelectedPort] = useState<string | null>(null);
  const [selectedMapping, setSelectedMapping] = useState<any | null>(null);

  function addNode(type: string) {
    const id = `${type.toLowerCase()}_${Date.now()}`;
    const node = { id, type, params: {}, inputs: [], outputs: [] };
    setNodes((n) => [...n, node]);
  }

  function exportJson() {
    const graph = { nodes, edges, imports: [] };
    const json = JSON.stringify(graph, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'graph.json';
    a.click();
  }

  // Helper: reconnect the first edge that targets nodeId to a new toPort
  function reconnectEdgeToPort(nodeId: string | null, newPort: string) {
    if (!nodeId) return;
    // find an edge that goes to this node
    const idx = edges.findIndex((e: any) => e.to === nodeId);
    if (idx === -1) {
      // no existing edge to update; nothing to do
      window.alert('No incoming edge found to reconnect');
      return;
    }
    const newEdges = edges.slice();
    newEdges[idx] = { ...newEdges[idx], toPort: newPort };
    setEdges(newEdges);
    // re-run validation/compile for immediate feedback
    // debounce could be used in a fuller implementation
    compileAndRun();
  }

  // Helper: insert a Cast node between the first edge found from fromNode -> toNode
  function insertCastBetween(fromNodeId: string, toNodeId: string, fromPort?: string | null, toPort?: string | null, targetType?: string | null) {
    // create cast node
    const castId = `cast_${Date.now()}`;
    const castNode = { id: castId, type: 'Cast', properties: {}, inputs: [], outputs: [] };
    // find edge(s) connecting fromNodeId -> toNodeId
    const edgeIdx = edges.findIndex((e: any) => e.from === fromNodeId && e.to === toNodeId && (toPort ? e.toPort === toPort : true));
    if (edgeIdx === -1) {
      window.alert('No matching edge found to insert Cast between these nodes');
      return;
    }
    const targetEdge = edges[edgeIdx];
    // Replace with: from -> cast, cast -> originalTo
    const newEdges = edges.slice();
    // remove original edge
    newEdges.splice(edgeIdx, 1);
    // edge from source to cast
    newEdges.push({ from: fromNodeId, to: castId, toPort: 'in' });
    // edge from cast to original target (preserve toPort)
    newEdges.push({ from: castId, to: toNodeId, toPort: targetEdge.toPort || toPort });
    setNodes((ns) => [...ns, castNode]);
    setEdges(newEdges);
    // re-run validation/compile for immediate feedback
    compileAndRun();
  }

  async function compileAndRun() {
    // Build canonical IR using serializer helper if available
    let ir: GraphIR = { nodes, edges, imports: [] } as any;
    try {
      // canonicalizeGraph expects full GraphIR; use dynamic import of serializer to avoid bundling issues
      // @ts-ignore
      const serializer = await import('../../frontend/src/GraphSerializer');
      if (serializer && serializer.canonicalizeGraph) {
        // @ts-ignore
        ir = serializer.canonicalizeGraph({ nodes, edges, imports: [] });
      }
    } catch (e) {
      // fallback
      ir = { nodes, edges, imports: [] } as any;
    }

    setRunning(true);
    setOutput('');
    setErrors([]);
    setSelectedNodeId(null);
    setSelectedPort(null);
    setSelectedMapping(null);
    setEmittedCpp('');
    setMappings([]);
    try {
      const res = await fetch(DEFAULT_COMPILE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ir }),
      });
      const data = await res.json();
      // Success path
      if (data.success) {
        setOutput(JSON.stringify({ stdout: data.stdout, stderr: data.stderr }, null, 2));
        setErrors([]);
      } else {
        // handle various error shapes: validation, compile, docker
        let msg = '';
        if (data.error === 'validation') {
          // include structured details if present
          msg = `Validation error: ${data.message}` + (data.details ? '\n' + JSON.stringify(data.details, null, 2) : '');
          const mapping = data.mapping || data.mappings || [];
          setMappings(mapping || []);
          if (data.cpp) setEmittedCpp(data.cpp);
          // create a synthetic diagnostic entry so UI can show mapped node/port
          const details = data.details || {};
          const verrors: any[] = [];
          // common keys: missing_input_port, missing_output_port, valid_ports, expected, actual, node
          if (details.missing_input_port || details.missing_output_port || details.valid_ports || details.expected) {
            verrors.push({ nodeId: details.node || null, port: details.missing_input_port || details.missing_output_port || null, diag: { kind: 'validation', file: null, line: null, col: null, msg: data.message }, details });
          } else {
            verrors.push({ nodeId: null, port: null, diag: { kind: 'validation', file: null, line: null, col: null, msg: data.message }, details });
          }
          setErrors(verrors);
          setOutput(msg);
        } else if (data.error === 'compile') {
          msg = `Compile error: ${data.stderr || data.message || ''}`;
          setOutput(msg);
          // try to map diagnostics if mapping present
          const mapping = data.mapping || data.mappings || [];
          setMappings(mapping || []);
          // store emitted cpp if present
          if (data.cpp) setEmittedCpp(data.cpp);
          // if compile error contains stderr with g++ diagnostics, try to parse and match to mapping
          const stderr = data.stderr || data.message || '';
          const parsed = parseGccDiagnostics(stderr);
          const mappedDiagnostics = mapDiagnosticsToNodes(parsed, mapping);
          setErrors(mappedDiagnostics);
        } else if (data.error) {
          msg = `${data.error}: ${data.message || ''}`;
          setOutput(msg);
        } else {
          msg = JSON.stringify(data);
          setOutput(msg);
        }
      }
    } catch (e) {
      setOutput(String(e));
    } finally {
      setRunning(false);
    }
  }

  async function previewJS() {
    // Use the in-browser JS runner for quick preview
    let ir: GraphIR = { nodes, edges, imports: [] } as any;
    try {
      // @ts-ignore
      const serializer = await import('../../frontend/src/GraphSerializer');
      if (serializer && serializer.canonicalizeGraph) {
        // @ts-ignore
        ir = serializer.canonicalizeGraph({ nodes, edges, imports: [] });
      }
    } catch (e) {
      ir = { nodes, edges, imports: [] } as any;
    }

    setRunning(true);
    setOutput('');
    setErrors([]);
    setSelectedNodeId(null);
    setSelectedPort(null);
    try {
      // dynamic import of the TS runner (compiled by bundler)
      const runner = await import('../run/jsRunner');
      if (runner && runner.evaluateGraph) {
        try {
          const res = runner.evaluateGraph(ir, { iterationLimit: 100000 });
          setOutput(res.stdout || '');
          setErrors([]);
        } catch (e: any) {
          setOutput(`JS Preview error: ${String(e.message || e)}`);
        }
      } else {
        setOutput('JS preview runner unavailable');
      }
    } catch (e) {
      setOutput(String(e));
    } finally {
      setRunning(false);
    }
  }

  // compute a set of highlighted node IDs from diagnostics
  const highlightedNodes = useMemo(() => {
    const s = new Set<string>();
    for (const e of errors) {
      if (e.nodeId) s.add(e.nodeId);
    }
    return s;
  }, [errors]);

  // parse g++ lines like: file:line:col: error: message
  function parseGccDiagnostics(stderrText: string) {
    const lines = (stderrText || '').split('\n');
    const pattern = /^(.*):(\d+):(\d+): (warning|error): (.*)$/;
    const results: any[] = [];
    for (const l of lines) {
      const m = l.match(pattern);
      if (m) {
        results.push({ file: m[1], line: parseInt(m[2], 10), col: parseInt(m[3], 10), kind: m[4], msg: m[5] });
      }
    }
    return results;
  }

  function mapDiagnosticsToNodes(diagnostics: any[], mapping: any[]) {
    if (!mapping || mapping.length === 0) return [];
    const mapped: any[] = [];
    for (const d of diagnostics) {
      const line = d.line;
      const col = d.col;
      // prefer exact column matches when available
      const colMatches = mapping.filter((m: any) => m.start_line && m.end_line && m.start_col && m.end_col && m.start_line <= line && m.end_line >= line && m.start_col <= col && m.end_col >= col);
      if (colMatches.length > 0) {
        colMatches.sort((a: any, b: any) => (a.end_line - a.start_line) - (b.end_line - b.start_line));
        const m = colMatches[0];
        mapped.push({ nodeId: m.node_id, function: m.function, port: m.port, diag: d });
        continue;
      }
      // fallback to line-only matches
      const lineMatches = mapping.filter((m: any) => m.start_line && m.end_line && m.start_line <= line && m.end_line >= line);
      if (lineMatches.length > 0) {
        lineMatches.sort((a: any, b: any) => (a.end_line - a.start_line) - (b.end_line - b.start_line));
        const m = lineMatches[0];
        mapped.push({ nodeId: m.node_id, function: m.function, port: m.port, diag: d });
      } else {
        mapped.push({ nodeId: null, function: null, port: null, diag: d });
      }
    }
    return mapped;
  }

  function onDiagnosticClick(d: any) {
    if (d.nodeId) {
      setSelectedNodeId(d.nodeId);
      setSelectedPort(d.port || null);
      // find mapping entry for this node and prefer matching port
      const m = pickMappingForNode(d.nodeId, d.port || null);
      setSelectedMapping(m);
      // in a full canvas we would center/focus the node; here we just ensure list highlight
    }
  }

  function pickMappingForNode(nodeId: string, port: string | null) {
    if (!mappings || mappings.length === 0) return null;
    const candidates = mappings.filter((m: any) => m.node_id === nodeId);
    if (candidates.length === 0) return null;
    // prefer port match
    if (port) {
      const pMatched = candidates.find((c: any) => c.port === port);
      if (pMatched) return pMatched;
    }
    // otherwise choose smallest range
    candidates.sort((a: any, b: any) => ((a.end_line - a.start_line) - (b.end_line - b.start_line)));
    return candidates[0];
  }

  function onNodeClick(n: any) {
    setSelectedNodeId(n.id);
    setSelectedPort(null);
    setSelectedMapping(pickMappingForNode(n.id, null));
  }

  function renderCppSnippet(mappingEntry: any) {
    if (!emittedCpp) return <div style={{ color: '#666' }}>No emitted C++ available</div>;
    if (!mappingEntry) return <div style={{ color: '#666' }}>No mapping selected</div>;
    const lines = emittedCpp.split('\n');
    const start = Math.max(1, (mappingEntry.start_line || 1) - 3);
    const end = Math.min(lines.length, (mappingEntry.end_line || 1) + 3);
    const snippetLines = lines.slice(start - 1, end);
    // highlight portion
    const sLine = mappingEntry.start_line || 1;
    const eLine = mappingEntry.end_line || sLine;
    const sCol = mappingEntry.start_col || 1;
    const eCol = mappingEntry.end_col || (lines[eLine - 1] ? lines[eLine - 1].length : sCol);

    return (
      <pre style={{ background: '#f0f0f0', padding: 8, overflow: 'auto' }}>
        {snippetLines.map((ln, idx) => {
          const realLine = start + idx;
          if (realLine < sLine || realLine > eLine) {
            return <div key={idx}><code>{ln}</code></div>;
          }
          // same line highlight
          let before = '';
          let middle = '';
          let after = '';
          if (sLine === eLine) {
            before = ln.substring(0, sCol - 1);
            middle = ln.substring(sCol - 1, eCol);
            after = ln.substring(eCol);
          } else if (realLine === sLine) {
            before = ln.substring(0, sCol - 1);
            middle = ln.substring(sCol - 1);
            after = '';
          } else if (realLine === eLine) {
            before = '';
            middle = ln.substring(0, eCol);
            after = ln.substring(eCol);
          } else {
            before = '';
            middle = ln;
            after = '';
          }
          return (
            <div key={idx} style={{ fontFamily: 'monospace' }}>
              <code>{before}</code>
              <code style={{ background: '#ffeeba', color: '#000' }}>{middle}</code>
              <code>{after}</code>
            </div>
          );
        })}
      </pre>
    );
  }

  return (
    <div style={{ display: 'flex' }}>
      <NodePalette onAdd={(t) => addNode(t)} />
      <div style={{ flex: 1, padding: 12 }}>
        <h3>Canvas (placeholder)</h3>
        <div style={{ marginBottom: 8 }}>
          <button onClick={exportJson}>Export JSON</button>
          <button onClick={compileAndRun} style={{ marginLeft: 8 }} disabled={running}>
            {running ? 'Running...' : 'Compile & Run (sandbox)'}
          </button>
          <button onClick={previewJS} style={{ marginLeft: 8 }} disabled={running}>
            Preview (JS)
          </button>
        </div>
        <p style={{ color: '#666', fontSize: 12 }}>
          Using compile endpoint: {DEFAULT_COMPILE_ENDPOINT}
        </p>
        <div style={{ display: 'flex', gap: 12 }}>
          <div style={{ flex: 2 }}>
            <h4>Graph (nodes & edges)</h4>
            {/* Simple node list to visualize highlights until a full canvas is present */}
            <div style={{ marginBottom: 8 }}>
              {nodes.length === 0 && <div style={{ color: '#666' }}>No nodes. Use the palette to add nodes.</div>}
              {nodes.map((n) => (
                <div key={n.id} onClick={() => onNodeClick(n)} style={{
                  padding: 6,
                  marginBottom: 4,
                  borderRadius: 4,
                  background: selectedNodeId === n.id ? '#e6f7ff' : highlightedNodes.has(n.id) ? '#fff3cd' : '#fff',
                  border: selectedNodeId === n.id ? '2px solid #1890ff' : '1px solid #ddd',
                  cursor: 'pointer',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ fontWeight: 600 }}>{n.type}</div>
                    {selectedNodeId === n.id && selectedPort && (
                      <div style={{ background: '#1890ff', color: '#fff', padding: '2px 6px', borderRadius: 4, fontSize: 12 }}>
                        {selectedPort}
                      </div>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: '#333' }}>{n.id}</div>
                </div>
              ))}
            </div>
            <pre style={{ maxHeight: '40vh', overflow: 'auto', background: '#f7f7f7', padding: 8 }}>{JSON.stringify({ nodes, edges }, null, 2)}</pre>
          </div>
          <div style={{ flex: 1 }}>
            <h4>Server output / Preview</h4>
            <pre style={{ maxHeight: '14vh', overflow: 'auto', background: '#111', color: '#bada55', padding: 8 }}>{output}</pre>
            <h4>Mapped diagnostics</h4>
            <div style={{ maxHeight: '18vh', overflow: 'auto', background: '#fff', padding: 8 }}>
              {errors.length === 0 && <div style={{ color: '#666' }}>No diagnostics</div>}
              {errors.map((e, idx) => (
                <div key={idx} onClick={() => onDiagnosticClick(e)} style={{ marginBottom: 6, borderBottom: '1px solid #eee', paddingBottom: 6, cursor: e.nodeId ? 'pointer' : 'default' }}>
                  <div><strong>{e.diag.kind}</strong>{e.diag.file ? ` in ${e.diag.file}:${e.diag.line}:${e.diag.col}` : e.nodeId ? ` for node ${e.nodeId}` : ''}</div>
                  <div style={{ color: '#c44' }}>{e.diag.msg}</div>
                  <div style={{ marginTop: 4 }}>
                    {e.nodeId ? (
                      <div>Mapped to node: <code>{e.nodeId}</code>{e.function ? ` (function ${e.function})` : ''}{e.port ? <span> — port: <code>{e.port}</code></span> : null}</div>
                    ) : (
                      <div style={{ color: '#666' }}>No node mapping available</div>
                    )}
                    {e.details && (
                      <div style={{ marginTop: 6, fontSize: 12, color: '#444' }}>
                        <pre style={{ background: '#f4f4f4', padding: 6 }}>{JSON.stringify(e.details, null, 2)}</pre>
                      </div>
                    )}

                    {/* Quick-fix actions when validator provides valid_ports or expected type info */}
                    {e.details && e.details.valid_ports && e.nodeId && (
                      <div style={{ marginTop: 8 }}>
                        <div style={{ fontSize: 12, color: '#333', marginBottom: 6 }}>Quick fixes:</div>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {e.details.valid_ports.map((vp: string) => (
                            <button key={vp} onClick={() => reconnectEdgeToPort(e.nodeId, vp)} style={{ padding: '4px 8px' }}>{`Reconnect to ${vp}`}</button>
                          ))}
                          <button onClick={() => {
                            // try to derive a fromNode for insertion: pick first incoming edge source
                            const incoming = edges.find((ed: any) => ed.to === e.nodeId);
                            if (!incoming) {
                              window.alert('No incoming edge found to insert a Cast between.');
                              return;
                            }
                            const suggested = e.details && (e.details.suggested_cast || e.details.expected) ? (e.details.suggested_cast || e.details.expected) : null;
                            insertCastBetween(incoming.from, e.nodeId, incoming.fromPort || null, incoming.toPort || null, suggested);
                          }} style={{ padding: '4px 8px' }}>Insert Cast</button>
                        </div>
                      </div>
                    )}

                  </div>
                </div>
              ))}
            </div>
            <h4 style={{ marginTop: 12 }}>Emitted C++ snippet</h4>
            <div style={{ maxHeight: '30vh', overflow: 'auto', padding: 8, background: '#fafafa' }}>
              {renderCppSnippet(selectedMapping)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
