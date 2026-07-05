// Web Worker: full-file chord analysis off the main thread.

import { analyzeChords } from './chordTrack';
import type { ChordTrack } from '../types';

export interface AnalyzeRequest {
  samples: Float32Array;
  sampleRate: number;
}

export type AnalyzeResponse =
  | { type: 'progress'; fraction: number }
  | { type: 'result'; track: ChordTrack };

self.onmessage = (e: MessageEvent<AnalyzeRequest>) => {
  const { samples, sampleRate } = e.data;
  const track = analyzeChords(samples, sampleRate, {
    onProgress: (fraction) => {
      (self as unknown as Worker).postMessage({ type: 'progress', fraction });
    },
  });
  (self as unknown as Worker).postMessage({ type: 'result', track });
};
