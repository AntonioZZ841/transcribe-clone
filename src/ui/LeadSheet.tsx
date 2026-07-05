// Real Book style chart: bar-grid controls (tap tempo / downbeat anchor),
// 4 bars per line with % repeats, click a bar to seek, copy-as-text export.

import { useMemo, useRef, useState } from 'react';
import { transport, useStore } from '../state/store';
import { TapTempo, barAtTime } from '../analysis/barGrid';
import { buildBars, toTextChart } from '../analysis/leadSheet';
import { prettyLabel } from './format';

export function LeadSheet() {
  const chordTrack = useStore((s) => s.chordTrack);
  const duration = useStore((s) => s.duration);
  const grid = useStore((s) => s.grid);
  const setGrid = useStore((s) => s.setGrid);
  const playhead = useStore((s) => s.playhead);
  const tapRef = useRef(new TapTempo());
  const [copied, setCopied] = useState(false);

  const bars = useMemo(
    () => (chordTrack ? buildBars(chordTrack, grid, duration) : []),
    [chordTrack, grid, duration],
  );

  if (!chordTrack) {
    return <div className="hint">Open a file and wait for chord analysis to finish.</div>;
  }

  const currentBar = barAtTime(grid, playhead);

  return (
    <div className="lead-sheet">
      <div className="grid-controls">
        <label>Tempo</label>
        <input
          type="number"
          min={30}
          max={300}
          step={0.1}
          value={grid.bpm}
          onChange={(e) => setGrid({ bpm: Number(e.target.value) || 120 })}
          style={{ width: 70 }}
        />
        <button
          onClick={() => {
            const bpm = tapRef.current.tap(performance.now());
            if (bpm) setGrid({ bpm });
          }}
        >
          Tap tempo
        </button>
        <label>Time sig</label>
        <select
          value={grid.timeSignature.join('/')}
          onChange={(e) => {
            const [num, den] = e.target.value.split('/').map(Number);
            setGrid({ timeSignature: [num, den] });
          }}
        >
          <option value="4/4">4/4</option>
          <option value="3/4">3/4</option>
          <option value="6/8">6/8</option>
          <option value="5/4">5/4</option>
        </select>
        <button onClick={() => setGrid({ downbeatSec: playhead })}>
          Downbeat = playhead ({playhead.toFixed(2)}s)
        </button>
        <button
          onClick={() => {
            void navigator.clipboard.writeText(toTextChart(bars)).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? 'Copied ✓' : 'Copy as text'}
        </button>
        <button
          onClick={() => {
            const blob = new Blob([JSON.stringify(chordTrack, null, 2)], {
              type: 'application/json',
            });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'chords.json';
            a.click();
            URL.revokeObjectURL(a.href);
          }}
        >
          Download JSON
        </button>
      </div>

      {chordTrack.key && <div className="key-line">Estimated key: {prettyLabel(chordTrack.key)}</div>}

      <div className="sheet">
        {bars.map((bar) => (
          <div
            key={bar.index}
            className={`bar${bar.index === currentBar ? ' current' : ''}`}
            onClick={() => transport.seek(bar.startSec)}
            title={`Bar ${bar.index + 1}`}
          >
            <span className="bar-num">{bar.index + 1}</span>
            {bar.repeatOfPrev ? (
              <span className="repeat">𝄎</span>
            ) : (
              bar.chords.map((c, i) => (
                <span key={i} className="chord">
                  {prettyLabel(c.label)}
                </span>
              ))
            )}
          </div>
        ))}
      </div>
      <div className="hint">
        Set the tempo (tap along with playback) and anchor the downbeat, then the chart lines up
        with the bars. Click any bar to jump there.
      </div>
    </div>
  );
}
