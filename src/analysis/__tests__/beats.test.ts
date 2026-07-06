import { describe, expect, it } from 'vitest';
import { estimateBeats, estimateTempo, onsetEnvelope, detectMeterDownbeat } from '../beats';

const SR = 22050;

/** Click track: short decaying noise bursts at `bpm`, accented every `meter`. */
function clickTrack(bpm: number, seconds: number, meter = 4, seed = 7): Float32Array {
  const n = Math.floor(seconds * SR);
  const buf = new Float32Array(n);
  const beatSec = 60 / bpm;
  let rng = seed;
  const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  let beat = 0;
  for (let t = 0; t < seconds; t += beatSec, beat++) {
    const start = Math.floor(t * SR);
    const amp = beat % meter === 0 ? 1 : 0.6; // accent downbeats
    for (let i = 0; i < 800 && start + i < n; i++) {
      buf[start + i] += amp * rand() * Math.exp(-i / 120);
    }
  }
  return buf;
}

describe('tempo estimation', () => {
  for (const bpm of [90, 120, 140]) {
    it(`recovers ${bpm} BPM from a click track`, () => {
      const { odf, fps } = onsetEnvelope(clickTrack(bpm, 12), SR);
      const est = estimateTempo(odf, fps);
      // allow octave-neutral tolerance of ~3%
      expect(Math.abs(est - bpm) / bpm).toBeLessThan(0.05);
    });
  }
});

describe('beat tracking', () => {
  it('places beats at the right spacing', () => {
    const bpm = 120;
    const { beatTimes } = estimateBeats(clickTrack(bpm, 12), SR);
    expect(beatTimes.length).toBeGreaterThan(15);
    const iois: number[] = [];
    for (let i = 1; i < beatTimes.length; i++) iois.push(beatTimes[i] - beatTimes[i - 1]);
    iois.sort((a, b) => a - b);
    const medianIoi = iois[Math.floor(iois.length / 2)];
    expect(medianIoi).toBeCloseTo(0.5, 1); // 120 BPM -> 0.5 s
  });
});

describe('meter + downbeat', () => {
  // synthetic per-beat chroma: chord changes every `bar` beats at a given phase
  function beatChromaSeq(nBeats: number, bar: number, phase: number): Float32Array[] {
    const chords = [
      [0, 4, 7], // C
      [5, 9, 0], // F
      [7, 11, 2], // G
      [9, 0, 4], // Am
    ];
    const out: Float32Array[] = [];
    for (let i = 0; i < nBeats; i++) {
      const barIdx = Math.floor((i - phase + bar * 100) / bar);
      const pcs = chords[barIdx % chords.length];
      const v = new Float32Array(12);
      for (const pc of pcs) v[pc] = 1;
      out.push(v);
    }
    return out;
  }

  it('detects 4/4 with the right downbeat', () => {
    const r = detectMeterDownbeat(beatChromaSeq(48, 4, 0));
    expect(r.beatsPerBar).toBe(4);
    expect(r.downbeatIndex % 4).toBe(0);
  });

  it('detects a 3/4 waltz', () => {
    const r = detectMeterDownbeat(beatChromaSeq(48, 3, 0));
    expect(r.beatsPerBar).toBe(3);
  });

  it('finds a shifted downbeat phase', () => {
    const r = detectMeterDownbeat(beatChromaSeq(48, 4, 2));
    expect(r.beatsPerBar).toBe(4);
    expect(r.downbeatIndex % 4).toBe(2);
  });
});
