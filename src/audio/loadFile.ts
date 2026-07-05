// File open flow: decode -> engine -> store -> background chord analysis.

import { engine } from './engine';
import { useStore, type AnalysisSource } from '../state/store';
import type { AnalyzeResponse } from '../analysis/worker';

let worker: Worker | null = null;

export async function openAudioFile(file: File): Promise<void> {
  const arrayBuf = await file.arrayBuffer();
  // decode with a scratch context so we don't have to resume the engine ctx first
  const scratch = new AudioContext();
  const buffer = await scratch.decodeAudioData(arrayBuf);
  void scratch.close();

  await engine.load(buffer);
  useStore.getState().fileLoaded(file.name, buffer.duration, buffer.numberOfChannels);
  reanalyze();
}

/**
 * (Re)run chord analysis on the loaded buffer with the store's current
 * analysis source. 'center' analyses (L-R)/2 — a centered lead vocal/melody
 * cancels out while panned accompaniment survives; falls back to mono for
 * single-channel files.
 */
export function reanalyze(): void {
  const buffer = engine.buffer;
  if (!buffer) return;
  const source = useStore.getState().analysisSource;
  startAnalysis(buffer, buffer.numberOfChannels >= 2 ? source : 'mono');
}

function downmix(buffer: AudioBuffer, source: AnalysisSource): Float32Array {
  const n = buffer.length;
  const out = new Float32Array(n);
  if (buffer.numberOfChannels < 2) {
    out.set(buffer.getChannelData(0));
    return out;
  }
  const l = buffer.getChannelData(0);
  const r = buffer.getChannelData(1);
  if (source === 'center') {
    for (let i = 0; i < n; i++) out[i] = (l[i] - r[i]) / 2;
  } else {
    for (let i = 0; i < n; i++) out[i] = (l[i] + r[i]) / 2;
  }
  return out;
}

function startAnalysis(buffer: AudioBuffer, source: AnalysisSource): void {
  worker?.terminate();
  worker = new Worker(new URL('../analysis/worker.ts', import.meta.url), { type: 'module' });

  const samples = downmix(buffer, source);
  const { setAnalysisProgress, setChordTrack } = useStore.getState();
  setAnalysisProgress(0);

  worker.onmessage = (e: MessageEvent<AnalyzeResponse>) => {
    if (e.data.type === 'progress') {
      setAnalysisProgress(e.data.fraction);
    } else {
      setChordTrack(e.data.track);
      setAnalysisProgress(-1);
    }
  };
  worker.postMessage({ samples, sampleRate: buffer.sampleRate }, [samples.buffer]);
}
