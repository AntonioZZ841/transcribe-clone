// Predominant-f0 (melody) tracking + harmonic subtraction — the rigorous
// upgrade over the pick-exclusion heuristic in the old melodyTrack.ts.
//
// Melodia-style pipeline:
//   1. harmonic-summation salience over the melody register, per frame
//      (reusing SaliencePicker.evidence, which already sums 1/h-weighted
//      partial peaks — exactly a salience function);
//   2. Viterbi contour tracking for a smooth, continuity-favoured melody line;
//   3. a voicing threshold (is there melodic energy at all) and a *mobility*
//      gate (a static top voice is a held chord tone, NOT a melody — leaving
//      it alone is what stops us from gutting block-chord voicings);
//   4. subtraction of the tracked melody's partials (f0, 2f0, 3f0, …) from the
//      magnitude spectrum, so the melody — and the overtones it sprays across
//      other pitch classes — is gone before the harmony is analysed.
//
// Interface: spectra in -> per-frame melody midi out, and (mags, midi) ->
// cleaned mags. Drops straight into chordTrack's per-frame loop.

import { SaliencePicker, midiToFreq } from './pitchSalience';
import { freqToBin } from './fft';

export const MEL_LO = 55; // G3 — melody register floor (above the comping bass)
export const MEL_HI = 88; // E6 — melody register ceiling
const N_GRID = MEL_HI - MEL_LO + 1;

const JUMP_PENALTY = 0.15; // Viterbi transition cost per semitone (× global max)
const TRANSITION_SPAN = 12; // only consider jumps up to an octave (speed)
const VOICED_FRAC = 0.12; // frame is voiced if salience ≥ frac × global max
const MOBILITY_WINDOW = 5; // ± frames: the line must move to count as melody
const SUB_HARMONICS = 8; // partials removed during subtraction
const SUB_DEPTH = 0.85; // fraction of each harmonic's magnitude removed

export interface MelodyPoint {
  /** tracked melody note (rounded to a semitone), or null if none / static */
  midi: number | null;
}

/** Harmonic-summation salience over the melody grid for one frame's picker. */
export function frameSalience(picker: SaliencePicker): Float32Array {
  const s = new Float32Array(N_GRID);
  for (let g = 0; g < N_GRID; g++) s[g] = picker.evidence(MEL_LO + g);
  return s;
}

/**
 * Viterbi over the per-frame salience → smooth predominant pitch path, then
 * voicing + mobility gating → per-frame melody midi (or null).
 */
export function trackPredominantMelody(saliences: Float32Array[]): MelodyPoint[] {
  const n = saliences.length;
  if (n === 0) return [];

  let globalMax = 0;
  for (const s of saliences) for (const v of s) if (v > globalMax) globalMax = v;
  if (globalMax <= 0) return saliences.map(() => ({ midi: null }));

  const jump = JUMP_PENALTY * globalMax;

  // forward pass
  const dp: Float32Array[] = [Float32Array.from(saliences[0])];
  const back: Int16Array[] = [new Int16Array(N_GRID)];
  for (let i = 1; i < n; i++) {
    const prev = dp[i - 1];
    const cur = new Float32Array(N_GRID);
    const bk = new Int16Array(N_GRID);
    for (let g = 0; g < N_GRID; g++) {
      let best = -Infinity;
      let bestJ = g;
      const jLo = Math.max(0, g - TRANSITION_SPAN);
      const jHi = Math.min(N_GRID - 1, g + TRANSITION_SPAN);
      for (let j = jLo; j <= jHi; j++) {
        const score = prev[j] - jump * Math.abs(g - j);
        if (score > best) {
          best = score;
          bestJ = j;
        }
      }
      cur[g] = best + saliences[i][g];
      bk[g] = bestJ;
    }
    dp.push(cur);
    back.push(bk);
  }

  // backtrack
  let last = 0;
  for (let g = 1; g < N_GRID; g++) if (dp[n - 1][g] > dp[n - 1][last]) last = g;
  const path = new Int16Array(n);
  path[n - 1] = last;
  for (let i = n - 1; i > 0; i--) path[i - 1] = back[i][path[i]];

  // voicing gate
  const voiced: (number | null)[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const g = path[i];
    voiced[i] = saliences[i][g] >= VOICED_FRAC * globalMax ? MEL_LO + g : null;
  }

  // mobility gate: keep only the *moving* line as melody
  return voiced.map((m, i) => {
    if (m === null) return { midi: null };
    const lo = Math.max(0, i - MOBILITY_WINDOW);
    const hi = Math.min(n - 1, i + MOBILITY_WINDOW);
    for (let j = lo; j <= hi; j++) {
      if (voiced[j] !== null && voiced[j] !== m) return { midi: m };
    }
    return { midi: null };
  });
}

/**
 * Subtract the melody's harmonic series from a magnitude spectrum. f0 is
 * refined to the strongest spectral bin within ±½ semitone of the tracked
 * note; each harmonic bin (± a bin of spread) is attenuated by SUB_DEPTH.
 * Returns a modified COPY (the raw spectrum is preserved for other uses).
 */
export function subtractMelodyHarmonics(
  mags: Float32Array,
  midi: number,
  sampleRate: number,
  fftSize: number,
): Float32Array {
  const out = Float32Array.from(mags);
  const nominal = midiToFreq(midi);
  const loBin = freqToBin(nominal * Math.pow(2, -0.5 / 12), sampleRate, fftSize);
  const hiBin = freqToBin(nominal * Math.pow(2, 0.5 / 12), sampleRate, fftSize);
  let peakBin = -1;
  let peakMag = 0;
  for (let k = Math.max(1, Math.floor(loBin)); k <= Math.min(out.length - 1, Math.ceil(hiBin)); k++) {
    if (out[k] > peakMag) {
      peakMag = out[k];
      peakBin = k;
    }
  }
  if (peakBin < 0) return out;
  const f0 = (peakBin * sampleRate) / fftSize;

  // attenuate ±2 bins around each partial (a windowed sine's main lobe spans
  // several bins when its frequency falls between them), tapering with distance
  const taper = [1, 0.7, 0.35];
  for (let h = 1; h <= SUB_HARMONICS; h++) {
    const bin = Math.round(freqToBin(f0 * h, sampleRate, fftSize));
    for (let d = -2; d <= 2; d++) {
      const k = bin + d;
      if (k >= 0 && k < out.length) out[k] *= 1 - SUB_DEPTH * taper[Math.abs(d)];
    }
  }
  return out;
}
