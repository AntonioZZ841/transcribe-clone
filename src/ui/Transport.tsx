// Playback, speed/pitch, loop, EQ and mix controls.

import type { MixMode } from '../audio/engine';
import { transport, useStore, type AnalysisSource } from '../state/store';
import { reanalyze } from '../audio/loadFile';


function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

export function Transport() {
  const s = useStore();
  const hasFile = s.fileName !== null;

  return (
    <div className="panel transport">
      <div className="group">
        <button className="primary" disabled={!hasFile} onClick={() => void transport.togglePlay()}>
          {s.isPlaying ? '❚❚ Pause' : '▶ Play'}
        </button>
        <button
          disabled={!hasFile}
          onClick={() => {
            transport.seek(s.loopEnabled && s.loopA !== null ? s.loopA : 0);
          }}
        >
          ⏮
        </button>
        <span className="time-display">
          {fmtTime(s.playhead)} / {fmtTime(s.duration)}
        </span>
      </div>

      <div className="group">
        <label>Speed</label>
        <input
          type="range"
          min={0.25}
          max={2}
          step={0.05}
          value={s.speed}
          disabled={!hasFile}
          onChange={(e) => s.setSpeed(Number(e.target.value))}
          onDoubleClick={() => s.setSpeed(1)}
        />
        <span className="value">{Math.round(s.speed * 100)}%</span>
      </div>

      <div className="group">
        <label>Pitch</label>
        <button
          disabled={!hasFile}
          onClick={() => {
            const cur = useStore.getState();
            cur.setPitchSemitones(cur.pitchSemitones - 1);
          }}
        >
          −
        </button>
        <span className="value" style={{ textAlign: 'center' }}>
          {s.pitchSemitones > 0 ? `+${s.pitchSemitones}` : s.pitchSemitones} st
        </span>
        <button
          disabled={!hasFile}
          onClick={() => {
            const cur = useStore.getState();
            cur.setPitchSemitones(cur.pitchSemitones + 1);
          }}
        >
          +
        </button>
      </div>

      <div className="group">
        <label>Tune</label>
        <input
          type="range"
          min={-50}
          max={50}
          step={1}
          value={s.tuneCents}
          disabled={!hasFile}
          onChange={(e) => s.setTuneCents(Number(e.target.value))}
          onDoubleClick={() => s.setTuneCents(0)}
          style={{ width: 80 }}
        />
        <span className="value">{s.tuneCents}¢</span>
      </div>

      <div className="group">
        <label>Loop</label>
        <button disabled={!hasFile} onClick={() => s.setLoopPoints(s.playhead, s.loopB ?? s.duration)}>
          A
        </button>
        <button disabled={!hasFile} onClick={() => s.setLoopPoints(s.loopA ?? 0, s.playhead)}>
          B
        </button>
        <button
          className={s.loopEnabled ? 'active' : ''}
          disabled={!hasFile || s.loopA === null}
          onClick={() => s.setLoopEnabled(!s.loopEnabled)}
        >
          {s.loopEnabled ? 'On' : 'Off'}
        </button>
      </div>

      <div className="group">
        <label>EQ</label>
        {(['Lo', 'Mid', 'Hi'] as const).map((band, i) => {
          const value = [s.eqLow, s.eqMid, s.eqHigh][i];
          return (
            <span key={band} className="group" style={{ gap: 3 }}>
              <label>{band}</label>
              <input
                type="range"
                min={-18}
                max={18}
                step={1}
                value={value}
                disabled={!hasFile}
                style={{ width: 56 }}
                onDoubleClick={() => {
                  const next: [number, number, number] = [s.eqLow, s.eqMid, s.eqHigh];
                  next[i] = 0;
                  s.setEq(...next);
                }}
                onChange={(e) => {
                  const next: [number, number, number] = [s.eqLow, s.eqMid, s.eqHigh];
                  next[i] = Number(e.target.value);
                  s.setEq(...next);
                }}
              />
            </span>
          );
        })}
      </div>

      <div className="group">
        <label>Mix</label>
        <select
          value={s.mixMode}
          disabled={!hasFile}
          onChange={(e) => s.setMixMode(e.target.value as MixMode)}
        >
          <option value="stereo">Stereo</option>
          <option value="mono">Mono</option>
          <option value="left">Left</option>
          <option value="right">Right</option>
          <option value="karaoke">Karaoke (L−R)</option>
        </select>
      </div>

      <div className="group">
        <label title="What the chord analysis listens to. Center-cut (L−R) removes anything mixed dead center — typically the lead vocal/melody — before detecting chords.">
          Chords from
        </label>
        <select
          value={s.analysisSource}
          disabled={!hasFile || s.analysisProgress >= 0}
          onChange={(e) => {
            s.setAnalysisSource(e.target.value as AnalysisSource);
            reanalyze();
          }}
        >
          <option value="mono">Full mix</option>
          <option value="center" disabled={s.numChannels < 2}>
            Center-cut (L−R)
          </option>
        </select>
      </div>
    </div>
  );
}
