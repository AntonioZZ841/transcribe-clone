// Spectrum -> 12-bin pitch-class chroma, with a separate low-register "bass
// chroma" used as bass-note evidence for slash chords / C6-vs-Am7 tie-breaks.

import { binToFreq } from './fft';
import { SaliencePicker, freqToMidi, midiToFreq, type PickedPitch } from './pitchSalience';

export { freqToMidi, midiToFreq };

export interface ChromaFrame {
  /** normalized 12-vector, index 0 = C */
  chroma: Float32Array;
  /** normalized 12-vector from the bass register only */
  bassChroma: Float32Array;
  /** total energy in the analysed band (pre-normalization) */
  energy: number;
}

const FMIN = 45; // ~F#1 — below this is rumble
const FMAX = 5000; // above this, mostly overtones/noise
const BASS_FMAX = 262; // ~C4; bass evidence register
// Below this, the FFT bin spacing plus the Hann main-lobe spread (~±2 bins)
// is a large fraction of a semitone, so the tuning penalty would throw away
// real energy that merely fell between bins. Only penalize where resolution
// is fine enough for "off-pitch" to be meaningful.
const TUNE_WEIGHT_FMIN = 600;
const BASS_MIDI_MAX = 59; // below C4 counts as bass evidence

/**
 * Fold a magnitude spectrum into pitch classes.
 * Uses power (mag^2) weighting and a soft cosine ramp within each semitone so
 * energy between bins lands mostly on the nearest pitch class.
 */
export function chromaFromSpectrum(
  mags: Float32Array,
  sampleRate: number,
  fftSize: number,
): ChromaFrame {
  const chroma = new Float32Array(12);
  const bassChroma = new Float32Array(12);
  let energy = 0;

  const startBin = Math.max(1, Math.floor((FMIN * fftSize) / sampleRate));
  const endBin = Math.min(mags.length - 1, Math.ceil((FMAX * fftSize) / sampleRate));

  for (let k = startBin; k <= endBin; k++) {
    const f = binToFreq(k, sampleRate, fftSize);
    const midi = freqToMidi(f);
    const nearest = Math.round(midi);
    const dist = Math.abs(midi - nearest); // 0..0.5 semitones
    if (dist > 0.5) continue;
    // soft assignment: full weight on-pitch, tapering to 0 halfway between;
    // below TUNE_WEIGHT_FMIN bins are coarser than semitones — assign fully
    const tuneWeight = f < TUNE_WEIGHT_FMIN ? 1 : Math.cos(dist * Math.PI) ** 2;
    const power = mags[k] * mags[k] * tuneWeight;
    const pc = ((nearest % 12) + 12) % 12;
    chroma[pc] += power;
    energy += power;
    if (f <= BASS_FMAX) bassChroma[pc] += power;
  }

  normalize(chroma);
  normalize(bassChroma);
  return { chroma, bassChroma, energy };
}

/**
 * Harmonic-aware chroma for offline analysis: greedy pitch picking with
 * harmonic suppression, then fold the picked fundamentals into pitch classes.
 * Far more robust than bin-folding on harmonic-rich material — a note's 3rd
 * harmonic (a perfect 12th up) otherwise pollutes the chroma with a false
 * fifth-of-the-fifth and drowns out real 7ths/extensions.
 */
export function chromaFromSalience(
  mags: Float32Array,
  sampleRate: number,
  fftSize: number,
): ChromaFrame {
  const chroma = new Float32Array(12);
  const bassChroma = new Float32Array(12);

  // energy gate uses the raw band energy (cheap, independent of picking)
  const energy = bandEnergy(mags, sampleRate, fftSize);

  const picker = new SaliencePicker(mags, sampleRate, fftSize);
  const picks = picker.pick({ midiLo: 28, midiHi: 96, maxNotes: 10 });
  foldPicks(picks, null, chroma, bassChroma);
  return { chroma, bassChroma, energy };
}

/**
 * Fold picked fundamentals into (normalized) chroma + bass chroma, optionally
 * excluding one midi note — used to subtract a tracked melody note.
 * sqrt compression: a chord's weakest tone (often the 7th, voiced on top with
 * less energy) still needs to register against the loud root/3rd.
 */
export function foldPicks(
  picks: PickedPitch[],
  excludeMidi: number | null,
  chroma: Float32Array,
  bassChroma: Float32Array,
): void {
  chroma.fill(0);
  bassChroma.fill(0);
  for (const p of picks) {
    if (excludeMidi !== null && p.midi === excludeMidi) continue;
    const pc = ((p.midi % 12) + 12) % 12;
    const ev = Math.sqrt(p.evidence);
    chroma[pc] += ev;
    if (p.midi <= BASS_MIDI_MAX) bassChroma[pc] += ev;
  }
  normalize(chroma);
  normalize(bassChroma);
}

/** Total band energy of a magnitude spectrum (for silence gating). */
export function bandEnergy(mags: Float32Array, sampleRate: number, fftSize: number): number {
  let energy = 0;
  const startBin = Math.max(1, Math.floor((FMIN * fftSize) / sampleRate));
  const endBin = Math.min(mags.length - 1, Math.ceil((FMAX * fftSize) / sampleRate));
  for (let k = startBin; k <= endBin; k++) energy += mags[k] * mags[k];
  return energy;
}

export function normalize(v: Float32Array): void {
  let max = 0;
  for (let i = 0; i < v.length; i++) if (v[i] > max) max = v[i];
  if (max > 0) for (let i = 0; i < v.length; i++) v[i] /= max;
}

/** Average several chroma vectors (already normalized) into `out`. */
export function averageChroma(frames: Float32Array[], out: Float32Array): void {
  out.fill(0);
  if (frames.length === 0) return;
  for (const f of frames) for (let i = 0; i < 12; i++) out[i] += f[i];
  normalize(out);
}
