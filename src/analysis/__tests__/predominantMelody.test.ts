import { describe, expect, it } from 'vitest';
import {
  MEL_LO,
  MEL_HI,
  subtractMelodyHarmonics,
  trackPredominantMelody,
} from '../predominantMelody';
import { magnitudeSpectrum } from '../fft';
import { midiToFreq } from '../pitchSalience';

const N_GRID = MEL_HI - MEL_LO + 1;
const SR = 44100;
const SIZE = 8192;

/** salience frame with a single unit peak at `midi` (0 elsewhere). */
function peakAt(midi: number | null): Float32Array {
  const s = new Float32Array(N_GRID);
  if (midi !== null) s[midi - MEL_LO] = 1;
  return s;
}

describe('trackPredominantMelody', () => {
  it('follows a moving melodic line', () => {
    // a line that steps 60 -> 62 -> 64 -> 65 (each held 4 frames)
    const line = [60, 60, 60, 60, 62, 62, 62, 62, 64, 64, 64, 64, 65, 65, 65, 65];
    const out = trackPredominantMelody(line.map((m) => peakAt(m)));
    // most frames should be recognised as melody at the right pitch
    let correct = 0;
    out.forEach((p, i) => {
      if (p.midi === line[i]) correct++;
    });
    expect(correct / line.length).toBeGreaterThan(0.7);
  });

  it('treats a STATIC top voice as harmony (not melody)', () => {
    // a single pitch held for the whole clip — a chord tone, not a melody
    const out = trackPredominantMelody(Array.from({ length: 16 }, () => peakAt(67)));
    expect(out.every((p) => p.midi === null)).toBe(true);
  });

  it('marks silent/low-salience frames as unvoiced', () => {
    const out = trackPredominantMelody(Array.from({ length: 10 }, () => peakAt(null)));
    expect(out.every((p) => p.midi === null)).toBe(true);
  });

  it('returns empty for no frames', () => {
    expect(trackPredominantMelody([])).toEqual([]);
  });
});

describe('subtractMelodyHarmonics', () => {
  it('attenuates the melody fundamental and its partials', () => {
    const midi = 69; // A4 = 440 Hz
    const f0 = midiToFreq(midi);
    // a tone with three partials
    const frame = new Float32Array(SIZE);
    for (let n = 0; n < SIZE; n++) {
      frame[n] =
        Math.sin((2 * Math.PI * f0 * n) / SR) +
        0.5 * Math.sin((2 * Math.PI * 2 * f0 * n) / SR) +
        0.3 * Math.sin((2 * Math.PI * 3 * f0 * n) / SR);
    }
    const mags = magnitudeSpectrum(frame);
    const cleaned = subtractMelodyHarmonics(mags, midi, SR, SIZE);

    const binOf = (f: number) => Math.round((f * SIZE) / SR);
    for (const h of [1, 2, 3]) {
      const k = binOf(f0 * h);
      const before = Math.max(mags[k - 1], mags[k], mags[k + 1]);
      const after = Math.max(cleaned[k - 1], cleaned[k], cleaned[k + 1]);
      expect(after, `harmonic ${h}`).toBeLessThan(before * 0.5); // at least halved
    }
    // and the fundamental bin itself is gutted (center attenuation)
    {
      const k = binOf(f0);
      expect(cleaned[k]).toBeLessThan(mags[k] * 0.2);
    }
  });

  it('leaves a non-melody note untouched', () => {
    const melodyMidi = 69; // A4
    const otherMidi = 60; // C4 — a chord tone we keep
    const fMel = midiToFreq(melodyMidi);
    const fOther = midiToFreq(otherMidi);
    const frame = new Float32Array(SIZE);
    for (let n = 0; n < SIZE; n++) {
      frame[n] =
        Math.sin((2 * Math.PI * fMel * n) / SR) + Math.sin((2 * Math.PI * fOther * n) / SR);
    }
    const mags = magnitudeSpectrum(frame);
    const cleaned = subtractMelodyHarmonics(mags, melodyMidi, SR, SIZE);
    const kOther = Math.round((fOther * SIZE) / SR);
    const before = Math.max(mags[kOther - 1], mags[kOther], mags[kOther + 1]);
    const after = Math.max(cleaned[kOther - 1], cleaned[kOther], cleaned[kOther + 1]);
    expect(after).toBeGreaterThan(before * 0.9); // C4 preserved
  });
});
