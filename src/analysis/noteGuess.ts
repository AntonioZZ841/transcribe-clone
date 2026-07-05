// Spectral peak picking -> most likely sounding notes (for the piano-key
// highlight in the spectrum view).

import { binToFreq } from './fft';
import { freqToMidi } from './chroma';
import type { NoteGuess } from '../types';

const FMIN = 55;
const FMAX = 4200; // ~C8

/**
 * Pick prominent spectral peaks, suppress obvious overtones, return notes.
 * `mags` is a linear magnitude spectrum.
 */
export function guessNotes(
  mags: Float32Array,
  sampleRate: number,
  fftSize: number,
  maxNotes = 8,
): NoteGuess[] {
  const startBin = Math.max(2, Math.floor((FMIN * fftSize) / sampleRate));
  const endBin = Math.min(mags.length - 2, Math.ceil((FMAX * fftSize) / sampleRate));

  // collect local maxima with parabolic interpolation
  interface Peak { freq: number; mag: number }
  const peaks: Peak[] = [];
  let globalMax = 0;
  for (let k = startBin; k <= endBin; k++) if (mags[k] > globalMax) globalMax = mags[k];
  if (globalMax <= 0) return [];
  const threshold = globalMax * 0.05;

  for (let k = startBin; k <= endBin; k++) {
    const m = mags[k];
    if (m > threshold && m > mags[k - 1] && m >= mags[k + 1]) {
      // parabolic interpolation for sub-bin frequency
      const alpha = mags[k - 1];
      const beta = m;
      const gamma = mags[k + 1];
      const denom = alpha - 2 * beta + gamma;
      const delta = denom !== 0 ? (0.5 * (alpha - gamma)) / denom : 0;
      peaks.push({ freq: binToFreq(k + delta, sampleRate, fftSize), mag: m });
    }
  }
  peaks.sort((a, b) => b.mag - a.mag);

  // greedy accept, suppressing peaks that sit on harmonics of accepted notes
  const accepted: Peak[] = [];
  for (const p of peaks) {
    if (accepted.length >= maxNotes) break;
    let isHarmonic = false;
    for (const a of accepted) {
      const ratio = p.freq / a.freq;
      const nearest = Math.round(ratio);
      if (nearest >= 2 && Math.abs(ratio - nearest) < 0.035 && p.mag < a.mag * 0.9) {
        isHarmonic = true;
        break;
      }
    }
    if (!isHarmonic) accepted.push(p);
  }

  const notes = new Map<number, number>();
  for (const p of accepted) {
    const midi = Math.round(freqToMidi(p.freq));
    if (midi < 21 || midi > 108) continue;
    const strength = p.mag / globalMax;
    notes.set(midi, Math.max(notes.get(midi) ?? 0, strength));
  }
  return [...notes.entries()]
    .map(([midi, strength]) => ({ midi, strength }))
    .sort((a, b) => a.midi - b.midi);
}
