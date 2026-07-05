// Scrollable/zoomable waveform with playhead, loop region, bar-grid ticks and
// the chord lane drawn in a strip along the bottom. Click = seek, drag = set
// loop points, wheel = zoom around the cursor.

import { useCallback, useEffect, useRef } from 'react';
import { engine } from '../audio/engine';
import { transport, useStore } from '../state/store';
import { barSec, barStart, numBars } from '../analysis/barGrid';

const WAVE_H = 150;
const CHORD_LANE_H = 26;
const TOTAL_H = WAVE_H + CHORD_LANE_H;
const PEAK_WINDOW = 512; // samples per peak bucket

interface Peaks {
  min: Float32Array;
  max: Float32Array;
  samplesPer: number;
  sampleRate: number;
}

function computePeaks(buffer: AudioBuffer): Peaks {
  const data = buffer.getChannelData(0);
  const n = Math.ceil(data.length / PEAK_WINDOW);
  const min = new Float32Array(n);
  const max = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let lo = 0;
    let hi = 0;
    const end = Math.min(data.length, (i + 1) * PEAK_WINDOW);
    for (let j = i * PEAK_WINDOW; j < end; j++) {
      const v = data[j];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[i] = lo;
    max[i] = hi;
  }
  return { min, max, samplesPer: PEAK_WINDOW, sampleRate: buffer.sampleRate };
}

const CHORD_COLORS = ['#365a7e', '#3e6a52', '#6a4e3e', '#5a3e6a', '#6a3e4a', '#3e5a6a'];

export function Waveform() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const peaksRef = useRef<Peaks | null>(null);
  const viewRef = useRef({ start: 0, dur: 0 }); // seconds
  const dragRef = useRef<{ startX: number; startT: number; moved: boolean } | null>(null);

  const fileName = useStore((s) => s.fileName);
  const duration = useStore((s) => s.duration);
  const analysisProgress = useStore((s) => s.analysisProgress);

  // recompute peaks + reset view when a file is (re)loaded
  useEffect(() => {
    if (engine.buffer) {
      peaksRef.current = computePeaks(engine.buffer);
      viewRef.current = { start: 0, dur: engine.buffer.duration };
    } else {
      peaksRef.current = null;
    }
  }, [fileName, duration]);

  const xToTime = useCallback((x: number, width: number): number => {
    const { start, dur } = viewRef.current;
    return start + (x / width) * dur;
  }, []);

  // main draw loop
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.clientWidth;
      if (cssW === 0) return;
      if (canvas.width !== cssW * dpr || canvas.height !== TOTAL_H * dpr) {
        canvas.width = cssW * dpr;
        canvas.height = TOTAL_H * dpr;
      }
      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, TOTAL_H);

      const peaks = peaksRef.current;
      const state = useStore.getState();
      if (!peaks || state.duration === 0) {
        ctx.fillStyle = '#555a66';
        ctx.font = '13px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText('Open an audio file to begin', cssW / 2, WAVE_H / 2);
        return;
      }

      const view = viewRef.current;
      if (view.dur === 0) view.dur = state.duration;

      // keep playhead in view while playing
      const playhead = engine.getPlayhead();
      if (state.isPlaying) {
        if (playhead > view.start + view.dur * 0.95 || playhead < view.start) {
          view.start = Math.max(0, Math.min(playhead - view.dur * 0.1, state.duration - view.dur));
        }
      }

      const midY = WAVE_H / 2;
      const secPerPx = view.dur / cssW;

      // bar grid ticks
      const grid = state.grid;
      if (state.chordTrack && grid.bpm > 0) {
        ctx.strokeStyle = '#262a33';
        ctx.beginPath();
        const total = numBars(grid, state.duration);
        const bar = barSec(grid);
        if (bar / secPerPx > 4) {
          for (let i = 0; i <= total; i++) {
            const t = barStart(grid, i);
            if (t < view.start || t > view.start + view.dur) continue;
            const x = (t - view.start) / secPerPx;
            ctx.moveTo(x, 0);
            ctx.lineTo(x, WAVE_H);
          }
        }
        ctx.stroke();
      }

      // waveform peaks
      ctx.fillStyle = '#3f7fbf';
      const bucketsPerSec = peaks.sampleRate / peaks.samplesPer;
      for (let x = 0; x < cssW; x++) {
        const t0 = view.start + x * secPerPx;
        const t1 = t0 + secPerPx;
        const b0 = Math.max(0, Math.floor(t0 * bucketsPerSec));
        const b1 = Math.min(peaks.min.length - 1, Math.ceil(t1 * bucketsPerSec));
        if (b0 > b1) continue;
        let lo = 0;
        let hi = 0;
        for (let b = b0; b <= b1; b++) {
          if (peaks.min[b] < lo) lo = peaks.min[b];
          if (peaks.max[b] > hi) hi = peaks.max[b];
        }
        const yTop = midY - hi * (midY - 4);
        const yBot = midY - lo * (midY - 4);
        ctx.fillRect(x, yTop, 1, Math.max(1, yBot - yTop));
      }

      // loop region
      if (state.loopA !== null && state.loopB !== null) {
        const xa = (state.loopA - view.start) / secPerPx;
        const xb = (state.loopB - view.start) / secPerPx;
        ctx.fillStyle = state.loopEnabled ? 'rgba(255,179,71,0.20)' : 'rgba(255,179,71,0.10)';
        ctx.fillRect(xa, 0, xb - xa, WAVE_H);
        ctx.strokeStyle = '#ffb347';
        ctx.beginPath();
        ctx.moveTo(xa, 0);
        ctx.lineTo(xa, WAVE_H);
        ctx.moveTo(xb, 0);
        ctx.lineTo(xb, WAVE_H);
        ctx.stroke();
      }

      // chord lane
      const track = state.chordTrack;
      if (track) {
        ctx.font = 'bold 12px Georgia, serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        let colorIdx = 0;
        for (const seg of track.segments) {
          if (seg.end < view.start || seg.start > view.start + view.dur) {
            colorIdx++;
            continue;
          }
          const x0 = Math.max(0, (seg.start - view.start) / secPerPx);
          const x1 = Math.min(cssW, (seg.end - view.start) / secPerPx);
          if (seg.label !== 'N.C.') {
            ctx.fillStyle = CHORD_COLORS[colorIdx % CHORD_COLORS.length];
            ctx.fillRect(x0, WAVE_H + 1, x1 - x0 - 1, CHORD_LANE_H - 2);
            if (x1 - x0 > 24) {
              ctx.fillStyle = '#e6e8ee';
              ctx.fillText(seg.label, x0 + 4, WAVE_H + CHORD_LANE_H / 2 + 1);
            }
          }
          colorIdx++;
        }
      }

      // playhead
      const px = (playhead - view.start) / secPerPx;
      if (px >= 0 && px <= cssW) {
        ctx.strokeStyle = '#ff5d5d';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(px, 0);
        ctx.lineTo(px, TOTAL_H);
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  // interactions
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const state = useStore.getState();
      if (state.duration === 0) return;
      const view = viewRef.current;
      const rect = canvas.getBoundingClientRect();
      const cursorT = xToTime(e.clientX - rect.left, rect.width);
      if (e.ctrlKey || !e.shiftKey) {
        // zoom around cursor
        const factor = e.deltaY > 0 ? 1.25 : 0.8;
        const newDur = Math.min(state.duration, Math.max(0.5, view.dur * factor));
        const frac = (cursorT - view.start) / view.dur;
        view.start = Math.max(0, Math.min(cursorT - frac * newDur, state.duration - newDur));
        view.dur = newDur;
      } else {
        // shift+wheel: pan
        const delta = view.dur * 0.15 * (e.deltaY > 0 ? 1 : -1);
        view.start = Math.max(0, Math.min(view.start + delta, state.duration - view.dur));
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      if (useStore.getState().duration === 0) return;
      canvas.setPointerCapture(e.pointerId);
      const rect = canvas.getBoundingClientRect();
      dragRef.current = {
        startX: e.clientX - rect.left,
        startT: xToTime(e.clientX - rect.left, rect.width),
        moved: false,
      };
    };

    const onPointerMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (!drag.moved && Math.abs(x - drag.startX) < 5) return;
      drag.moved = true;
      const t = xToTime(x, rect.width);
      const a = Math.min(drag.startT, t);
      const b = Math.max(drag.startT, t);
      useStore.getState().setLoopPoints(a, b);
    };

    const onPointerUp = (e: PointerEvent) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag) return;
      if (!drag.moved) {
        transport.seek(drag.startT);
      } else {
        // finishing a loop drag enables the loop
        useStore.getState().setLoopEnabled(true);
      }
      canvas.releasePointerCapture(e.pointerId);
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    return () => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
    };
  }, [xToTime]);

  return (
    <div className="waveform-wrap">
      <canvas ref={canvasRef} style={{ height: TOTAL_H }} />
      {analysisProgress >= 0 && (
        <div className="analysis-progress">
          Analyzing chords… {Math.round(analysisProgress * 100)}%
        </div>
      )}
    </div>
  );
}
