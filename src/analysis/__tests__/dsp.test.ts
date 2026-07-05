import { describe, expect, it } from 'vitest';
import { magnitudeSpectrum } from '../fft';
import { chromaFromSpectrum, midiToFreq } from '../chroma';
import { guessNotes } from '../noteGuess';
import { estimateVoicing } from '../voicing';
import { analyzeChords } from '../chordTrack';

const SR = 44100;

/** Synthesize a frame of summed sines at the given frequencies. */
function sines(freqs: number[], size: number, amps?: number[]): Float32Array {
  const out = new Float32Array(size);
  freqs.forEach((f, i) => {
    const a = amps?.[i] ?? 1;
    for (let n = 0; n < size; n++) out[n] += a * Math.sin((2 * Math.PI * f * n) / SR);
  });
  return out;
}

describe('fft + noteGuess', () => {
  it('finds A4 from a 440 Hz sine', () => {
    const size = 8192;
    const mags = magnitudeSpectrum(sines([440], size));
    const notes = guessNotes(mags, SR, size);
    expect(notes.some((n) => n.midi === 69)).toBe(true);
    expect(notes[0].midi).toBe(69);
  });

  it('suppresses harmonics of a rich tone', () => {
    const size = 8192;
    // A2 (110 Hz) with strong overtones
    const mags = magnitudeSpectrum(
      sines([110, 220, 330, 440], size, [1, 0.6, 0.4, 0.3]),
    );
    const notes = guessNotes(mags, SR, size);
    expect(notes.some((n) => n.midi === 45)).toBe(true); // A2 present
    expect(notes.length).toBeLessThanOrEqual(2); // overtones folded away
  });
});

describe('chroma', () => {
  it('concentrates energy in the played pitch classes', () => {
    const size = 8192;
    // C4, E4, G4
    const freqs = [60, 64, 67].map(midiToFreq);
    const mags = magnitudeSpectrum(sines(freqs, size));
    const { chroma } = chromaFromSpectrum(mags, SR, size);
    const top = [...chroma].map((v, pc) => ({ v, pc })).sort((a, b) => b.v - a.v).slice(0, 3);
    expect(new Set(top.map((t) => t.pc))).toEqual(new Set([0, 4, 7]));
  });
});

describe('estimateVoicing', () => {
  it('recovers a spread Dm7 voicing from a synthetic spectrum', () => {
    const size = 8192;
    // D2, A3, C4, F4 — classic rootless-ish spread with the root in the bass
    const midis = [38, 57, 60, 65];
    const mags = magnitudeSpectrum(sines(midis.map(midiToFreq), size, [1, 0.8, 0.7, 0.7]));
    const notes = estimateVoicing(mags, SR, size, 'D', 'm7', null);
    expect(notes).toContain('D2');
    expect(notes).toContain('A3');
    expect(notes).toContain('C4');
    expect(notes).toContain('F4');
  });

  it('puts the slash bass at the bottom when asked', () => {
    const size = 8192;
    // Cmaj7/E: E2 bass + C4 E4 G4 B4
    const midis = [40, 60, 64, 67, 71];
    const mags = magnitudeSpectrum(sines(midis.map(midiToFreq), size, [1, 0.7, 0.7, 0.6, 0.6]));
    const notes = estimateVoicing(mags, SR, size, 'C', 'maj7', 'E');
    expect(notes[0]).toBe('E2');
  });

  it('excludes a tracked melody note from the voicing', () => {
    const size = 8192;
    // Dm7 comp (D2 A3 C4 F4) + a loud melody E5 (a chord-tone octave? no: E is
    // not in Dm7 — but use A5 which IS a chord tone to prove exclusion works
    // even when the melody note shares a chord pitch class)
    const comp = [38, 57, 60, 65]; // D2 A3 C4 F4
    const melodyMidi = 81; // A5 — same pc as A3, would otherwise appear on top
    const mags = magnitudeSpectrum(
      sines([...comp, melodyMidi].map(midiToFreq), size, [1, 0.8, 0.7, 0.7, 1.1]),
    );
    const without = estimateVoicing(mags, SR, size, 'D', 'm7', null);
    const withExcl = estimateVoicing(mags, SR, size, 'D', 'm7', null, new Set([melodyMidi]));
    expect(without).toContain('A5'); // melody would normally be picked
    expect(withExcl).not.toContain('A5'); // excluded
    expect(withExcl).toContain('D2'); // real voicing preserved
    expect(withExcl).toContain('C4');
  });
});

describe('analyzeChords end-to-end on synthetic audio', () => {
  it('segments a ii-V-I progression', () => {
    const secPerChord = 2;
    const chords: number[][] = [
      [38, 50, 53, 57, 60], // Dm7: D2 D3 F3 A3 C4
      [31, 43, 47, 50, 53], // G7: G1 G2 B2 D3 F3
      [36, 48, 52, 55, 59], // Cmaj7: C2 C3 E3 G3 B3
    ];
    const total = Math.floor(SR * secPerChord * chords.length);
    const samples = new Float32Array(total);
    chords.forEach((midis, ci) => {
      const start = Math.floor(ci * secPerChord * SR);
      const end = Math.floor((ci + 1) * secPerChord * SR);
      for (const m of midis) {
        const f = midiToFreq(m);
        for (let n = start; n < end; n++) {
          samples[n] += 0.2 * Math.sin((2 * Math.PI * f * (n - start)) / SR);
        }
      }
    });

    const track = analyzeChords(samples, SR, { voicings: false });
    const labels = track.segments.map((s) => s.label);
    expect(labels).toContain('Dm7');
    expect(labels).toContain('G7');
    expect(labels).toContain('Cmaj7');
    // order preserved
    expect(labels.indexOf('Dm7')).toBeLessThan(labels.indexOf('G7'));
    expect(labels.indexOf('G7')).toBeLessThan(labels.indexOf('Cmaj7'));
  }, 30000);
});
