// Live spectrum (log-frequency) + piano keyboard with note-guess highlights.
// Clicking a piano key plays a reference tone.

import { useEffect, useRef } from 'react';
import { engine } from '../audio/engine';
import { guessNotes } from '../analysis/noteGuess';
import type { NoteGuess } from '../types';

const SPEC_H = 130;
const PIANO_H = 64;
const MIDI_LO = 21; // A0
const MIDI_HI = 108; // C8
const FMIN = 50;
const FMAX = 5000;

const isBlack = (midi: number) => [1, 3, 6, 8, 10].includes(midi % 12);

/** x position 0..1 for a midi note across the 88-key range (white-key layout). */
function whiteIndex(midi: number): number {
  let count = 0;
  for (let m = MIDI_LO; m < midi; m++) if (!isBlack(m)) count++;
  return count;
}
const N_WHITE = whiteIndex(MIDI_HI) + 1;

export function SpectrumView() {
  const specRef = useRef<HTMLCanvasElement>(null);
  const pianoRef = useRef<HTMLCanvasElement>(null);
  const notesRef = useRef<NoteGuess[]>([]);

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      drawSpectrum();
      drawPiano();
    };

    const drawSpectrum = () => {
      const canvas = specRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.clientWidth;
      if (cssW === 0) return;
      if (canvas.width !== cssW * dpr) {
        canvas.width = cssW * dpr;
        canvas.height = SPEC_H * dpr;
      }
      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, SPEC_H);

      const live = engine.getLiveSpectrum();
      if (!live) return;
      const { mags, fftSize } = live;
      const sr = engine.sampleRate;

      // note guesses for the piano (only meaningful while audio flows)
      notesRef.current = engine.isPlaying ? guessNotes(mags, sr, fftSize) : [];

      let maxMag = 0;
      for (let i = 1; i < mags.length; i++) if (mags[i] > maxMag) maxMag = mags[i];
      if (maxMag <= 0) return;

      const logMin = Math.log2(FMIN);
      const logMax = Math.log2(FMAX);
      ctx.fillStyle = '#4fa3ff';
      for (let x = 0; x < cssW; x++) {
        const f0 = Math.pow(2, logMin + ((logMax - logMin) * x) / cssW);
        const f1 = Math.pow(2, logMin + ((logMax - logMin) * (x + 1)) / cssW);
        const b0 = Math.max(1, Math.floor((f0 * fftSize) / sr));
        const b1 = Math.min(mags.length - 1, Math.max(b0, Math.ceil((f1 * fftSize) / sr)));
        let m = 0;
        for (let b = b0; b <= b1; b++) if (mags[b] > m) m = mags[b];
        // soft dB-ish scaling
        const h = Math.pow(m / maxMag, 0.4) * (SPEC_H - 6);
        if (h > 0.5) ctx.fillRect(x, SPEC_H - h, 1, h);
      }
    };

    const drawPiano = () => {
      const canvas = pianoRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.clientWidth;
      if (cssW === 0) return;
      if (canvas.width !== cssW * dpr) {
        canvas.width = cssW * dpr;
        canvas.height = PIANO_H * dpr;
      }
      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, PIANO_H);

      const keyW = cssW / N_WHITE;
      const active = new Map(notesRef.current.map((n) => [n.midi, n.strength]));

      // white keys
      for (let m = MIDI_LO; m <= MIDI_HI; m++) {
        if (isBlack(m)) continue;
        const x = whiteIndex(m) * keyW;
        const strength = active.get(m);
        ctx.fillStyle = strength ? `rgba(255,140,60,${0.5 + strength * 0.5})` : '#e9e9e9';
        ctx.fillRect(x + 0.5, 0, keyW - 1, PIANO_H);
        ctx.strokeStyle = '#999';
        ctx.strokeRect(x + 0.5, 0, keyW - 1, PIANO_H);
        if (m % 12 === 0) {
          // label Cs
          ctx.fillStyle = '#666';
          ctx.font = '8px system-ui';
          ctx.textAlign = 'center';
          ctx.fillText(`C${m / 12 - 1}`, x + keyW / 2, PIANO_H - 3);
        }
      }
      // black keys
      for (let m = MIDI_LO; m <= MIDI_HI; m++) {
        if (!isBlack(m)) continue;
        const x = whiteIndex(m) * keyW; // index of next white key
        const strength = active.get(m);
        ctx.fillStyle = strength ? `rgba(255,120,40,${0.6 + strength * 0.4})` : '#1a1a1a';
        ctx.fillRect(x - keyW * 0.3, 0, keyW * 0.6, PIANO_H * 0.62);
      }
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  const onPianoClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = pianoRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const keyW = rect.width / N_WHITE;

    // black keys sit on top — check them first when in their vertical zone
    if (y < PIANO_H * 0.62) {
      for (let m = MIDI_LO; m <= MIDI_HI; m++) {
        if (!isBlack(m)) continue;
        const bx = whiteIndex(m) * keyW;
        if (x >= bx - keyW * 0.3 && x <= bx + keyW * 0.3) {
          engine.playReferenceNote(m);
          return;
        }
      }
    }
    for (let m = MIDI_LO; m <= MIDI_HI; m++) {
      if (isBlack(m)) continue;
      const wx = whiteIndex(m) * keyW;
      if (x >= wx && x < wx + keyW) {
        engine.playReferenceNote(m);
        return;
      }
    }
  };

  return (
    <div>
      <canvas ref={specRef} className="spectrum-canvas" style={{ height: SPEC_H }} />
      <canvas
        ref={pianoRef}
        className="piano-canvas"
        style={{ height: PIANO_H }}
        onClick={onPianoClick}
      />
      <div className="hint">
        Orange keys = detected notes (while playing). Click a key for a reference tone.
      </div>
    </div>
  );
}
