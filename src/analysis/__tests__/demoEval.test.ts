// Quality check against the bundled demo clip (known progression, piano-like
// tones with harmonics — much closer to real audio than pure sines).
// Ground truth: | Dm7 | G7 | Cmaj7 | % | Fm7 Bb7 | Ebmaj7 | Am7b5 D7b9 | Gm |

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeChords } from '../chordTrack';

function readWavMono(path: string): { samples: Float32Array; sampleRate: number } {
  const buf = readFileSync(path);
  const sampleRate = buf.readUInt32LE(24);
  const channels = buf.readUInt16LE(22);
  const dataStart = 44;
  const n = Math.floor((buf.length - dataStart) / 2 / channels);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    samples[i] = buf.readInt16LE(dataStart + i * channels * 2) / 32768;
  }
  return { samples, sampleRate };
}

describe('demo clip chord accuracy', () => {
  const { samples, sampleRate } = readWavMono(resolve(__dirname, '../../../public/demo.wav'));
  const track = analyzeChords(samples, sampleRate, { voicings: true });

  /** dominant label in [t0, t1) by coverage */
  const labelAt = (t0: number, t1: number): string => {
    let best = '';
    let bestCov = 0;
    for (const seg of track.segments) {
      const cov = Math.min(seg.end, t1) - Math.max(seg.start, t0);
      if (cov > bestCov) {
        bestCov = cov;
        best = seg.label;
      }
    }
    return best;
  };

  it('logs the detected track for inspection', () => {
    console.log('key:', track.key);
    for (const s of track.segments) {
      console.log(
        `${s.start.toFixed(2)}-${s.end.toFixed(2)}  ${s.label.padEnd(10)} conf=${s.confidence.toFixed(2)}  [${(s.notes ?? []).join(' ')}]`,
      );
    }
    expect(track.segments.length).toBeGreaterThan(0);
  });

  // bar = 2s; check the dominant label of each bar's middle
  const cases: [number, number, string[]][] = [
    [0.2, 1.8, ['Dm7']],
    [2.2, 3.8, ['G7']],
    [4.2, 7.8, ['Cmaj7']],
    [8.1, 8.9, ['Fm7']],
    [9.1, 9.9, ['Bb7']],
    [10.2, 11.8, ['Ebmaj7']],
    [12.1, 12.9, ['Am7b5']],
    [14.2, 15.5, ['Gm', 'Gm7']],
  ];

  for (const [t0, t1, accepted] of cases) {
    it(`detects ${accepted[0]} around ${t0}s`, () => {
      const got = labelAt(t0, t1);
      // strip slash bass for comparison — bass inversions are acceptable
      const base = got.split('/')[0];
      expect(accepted, `got "${got}"`).toContain(base);
    });
  }
}, 60000);
