import React from 'react';

export function NodePalette({ onAdd }: { onAdd: (type: string) => void }) {
  const palette = ['Const', 'Add', 'Print', 'VarSet', 'VarGet', 'If', 'Return'];
  return (
    <div style={{ width: 220, borderRight: '1px solid #ccc', padding: 8 }}>
      <h4>Palette</h4>
      {palette.map((p) => (
        <div key={p} style={{ marginBottom: 8 }}>
          <button onClick={() => onAdd(p)}>{p}</button>
        </div>
      ))}
    </div>
  );
}
