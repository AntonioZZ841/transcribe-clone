// Melody-robustness gate: same progression as demo.wav but with a loud
// eighth-note lead melody (incl. chromatic passing tones) mixed dead center,
// while the comping is panned L/R.
//   - mono path: melody present — relies on stability weighting + melody
//     tracking/subtraction + wildcard forgiveness
//   - center-cut path: (L-R)/2 cancels the centered melody entirely
// Ground truth: | Dm7 | G7 | Cmaj7 | % | Fm7 Bb7 | Ebmaj7 | Am7b5 D7b9 | Gm |

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeChords } from '../chordTrack';
import type { ChordTrack } from '../../types';

function readWavStereo(path: string): {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
} {
  const buf = readFileSync(path);
  const sampleRate = buf.readUInt32LE(24);
  const channels = buf.readUInt16LE(22);
  const dataStart = 44;
  const n = Math.floor((buf.length - dataStart) / 2 / channels);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    left[i] = buf.readInt16LE(dataStart + i * channels * 2) / 32768;
    right[i] = channels > 1 ? buf.readInt16LE(dataStart + i * channels * 2 + 2) / 32768 : left[i];
  }
  return { left, right, sampleRate };
}

const { left, right, sampleRate } = readWavStereo(
  resolve(__dirname, '../../../public/demo-melody.wav'),
);
const n = left.length;
const mono = new Float32Array(n);
const centerCut = new Float32Array(n);
for (let i = 0; i < n; i++) {
  mono[i] = (left[i] + right[i]) / 2;
  centerCut[i] = (left[i] - right[i]) / 2;
}

// accepted label families: extensions of the true chord are musically fine
// (a 9th in the melody legitimately colors Dm7 toward Dm9)
const CASES: [number, number, string[]][] = [
  [0.2, 1.8, ['Dm7', 'Dm9']],
  [2.2, 3.8, ['G7', 'G9', 'G13', 'G7b9']],
  [4.2, 7.8, ['Cmaj7', 'Cmaj9']],
  [8.1, 8.9, ['Fm7', 'Fm9']],
  [9.1, 9.9, ['Bb7', 'Bb9', 'Bb13']],
  [10.2, 11.8, ['Ebmaj7', 'Ebmaj9']],
  [12.1, 12.9, ['Am7b5']],
  [14.2, 15.5, ['Gm', 'Gm7', 'Gm9']],
];

function labelAt(track: ChordTrack, t0: number, t1: number): string {
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
}

function runCases(name: string, samples: Float32Array): void {
  describe(`${name} path`, () => {
    const track = analyzeChords(samples, sampleRate, { voicings: false });

    it('logs the detected track for inspection', () => {
      console.log(`--- ${name} ---`);
      for (const s of track.segments) {
        console.log(`${s.start.toFixed(2)}-${s.end.toFixed(2)}  ${s.label}`);
      }
      expect(track.segments.length).toBeGreaterThan(0);
    });

    for (const [t0, t1, accepted] of CASES) {
      it(`detects ${accepted[0]} around ${t0}s`, () => {
        const got = labelAt(track, t0, t1).split('/')[0];
        expect(accepted, `got "${got}"`).toContain(got);
      });
    }
  });
}

describe('demo clip with lead melody', () => {
  runCases('mono (melody present)', mono);
  runCases('center-cut (melody cancelled)', centerCut);
}, 120000);
