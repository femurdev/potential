import React from 'react';

const AVAILABLE_NODES = [
  'Literal',
  'Param',
  'Add',
  'Sub',
  'Mul',
  'Div',
  'LessThan',
  'Sin',
  'Cos',
  'Print',
  'VarDecl',
  'VarSet',
  'VarGet',
  'If',
  'While',
  'Call'
];

export function NodePalette({ onAdd }: { onAdd: (type: string) => void }) {
  return (
    <div style={{ width: 180, borderRight: '1px solid #eee', padding: 12 }}>
      <h4 style={{ marginTop: 0 }}>Palette</h4>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {AVAILABLE_NODES.map((t) => (
          <button key={t} onClick={() => onAdd(t)} style={{ padding: '6px 8px', textAlign: 'left' }}>
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}
