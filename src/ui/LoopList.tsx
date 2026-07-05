// Named A-B loops: save the current region, recall or delete saved ones.

import { useState } from 'react';
import { useStore } from '../state/store';

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  return `${m}:${(sec - m * 60).toFixed(1).padStart(4, '0')}`;
}

export function LoopList() {
  const { loopA, loopB, savedLoops, saveLoop, recallLoop, deleteLoop } = useStore();
  const [name, setName] = useState('');

  const canSave = loopA !== null && loopB !== null;

  return (
    <div className="loop-list">
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <input
          type="text"
          placeholder="Loop name (e.g. Bridge, Solo bars 1-4)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canSave && name.trim()) {
              saveLoop(name.trim());
              setName('');
            }
            e.stopPropagation();
          }}
          style={{ flex: 1 }}
        />
        <button
          disabled={!canSave || !name.trim()}
          onClick={() => {
            saveLoop(name.trim());
            setName('');
          }}
        >
          Save current loop
        </button>
      </div>
      {!canSave && (
        <div className="hint">Drag on the waveform (or use the A / B buttons) to set a loop first.</div>
      )}
      {savedLoops.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>From</th>
              <th>To</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {savedLoops.map((loop) => (
              <tr key={loop.name}>
                <td>{loop.name}</td>
                <td>{fmt(loop.a)}</td>
                <td>{fmt(loop.b)}</td>
                <td style={{ textAlign: 'right' }}>
                  <button onClick={() => recallLoop(loop)}>Recall</button>{' '}
                  <button onClick={() => deleteLoop(loop.name)}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
