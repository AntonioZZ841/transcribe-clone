// Central UI/transport state. The AudioEngine holds the AudioBuffer and the
// Web Audio graph; the store holds everything React renders. Engine -> store
// updates flow through the actions below.

import { create } from 'zustand';
import { engine, type MixMode } from '../audio/engine';
import { DEFAULT_GRID } from '../analysis/barGrid';
import type { BarGrid, ChordTrack, SavedLoop } from '../types';

export type ViewTab = 'spectrum' | 'leadsheet' | 'voicing' | 'loops';
export type AnalysisSource = 'mono' | 'center';

const PERSIST_KEY = 'transcribe-clone-session';

interface PersistedSession {
  savedLoops: SavedLoop[];
  grid: BarGrid;
  speed: number;
  pitchSemitones: number;
  tuneCents: number;
}

interface AppState {
  fileName: string | null;
  duration: number;
  numChannels: number;
  isPlaying: boolean;
  playhead: number;

  speed: number;
  pitchSemitones: number;
  tuneCents: number;

  loopA: number | null;
  loopB: number | null;
  loopEnabled: boolean;
  savedLoops: SavedLoop[];

  chordTrack: ChordTrack | null;
  /** -1 idle, 0..1 running */
  analysisProgress: number;
  /** what the chord analysis listens to: full mono mix or center-cut (L-R) */
  analysisSource: AnalysisSource;

  grid: BarGrid;

  eqLow: number;
  eqMid: number;
  eqHigh: number;
  mixMode: MixMode;

  view: ViewTab;
  liveChordMode: boolean;

  // actions
  fileLoaded: (name: string, duration: number, numChannels: number) => void;
  setAnalysisSource: (source: AnalysisSource) => void;
  setPlaying: (playing: boolean) => void;
  setPlayhead: (sec: number) => void;
  setSpeed: (speed: number) => void;
  setPitchSemitones: (st: number) => void;
  setTuneCents: (cents: number) => void;
  setLoopPoints: (a: number | null, b: number | null) => void;
  setLoopEnabled: (enabled: boolean) => void;
  saveLoop: (name: string) => void;
  recallLoop: (loop: SavedLoop) => void;
  deleteLoop: (name: string) => void;
  setChordTrack: (track: ChordTrack | null) => void;
  setAnalysisProgress: (fraction: number) => void;
  setGrid: (grid: Partial<BarGrid>) => void;
  setEq: (low: number, mid: number, high: number) => void;
  setMixMode: (mode: MixMode) => void;
  setView: (view: ViewTab) => void;
  setLiveChordMode: (live: boolean) => void;
}

function loadPersisted(): Partial<PersistedSession> {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    return raw ? (JSON.parse(raw) as PersistedSession) : {};
  } catch {
    return {};
  }
}

function persist(state: AppState): void {
  const session: PersistedSession = {
    savedLoops: state.savedLoops,
    grid: state.grid,
    speed: state.speed,
    pitchSemitones: state.pitchSemitones,
    tuneCents: state.tuneCents,
  };
  try {
    localStorage.setItem(PERSIST_KEY, JSON.stringify(session));
  } catch {
    // storage unavailable — fine, persistence is best-effort
  }
}

const persisted = loadPersisted();

export const useStore = create<AppState>((set, get) => ({
  fileName: null,
  duration: 0,
  numChannels: 0,
  isPlaying: false,
  playhead: 0,

  speed: persisted.speed ?? 1,
  pitchSemitones: persisted.pitchSemitones ?? 0,
  tuneCents: persisted.tuneCents ?? 0,

  loopA: null,
  loopB: null,
  loopEnabled: false,
  savedLoops: persisted.savedLoops ?? [],

  chordTrack: null,
  analysisProgress: -1,
  analysisSource: 'mono',

  grid: persisted.grid ?? DEFAULT_GRID,

  eqLow: 0,
  eqMid: 0,
  eqHigh: 0,
  mixMode: 'stereo',

  view: 'spectrum',
  liveChordMode: false,

  fileLoaded: (fileName, duration, numChannels) =>
    set({
      fileName,
      duration,
      numChannels,
      playhead: 0,
      isPlaying: false,
      chordTrack: null,
      analysisProgress: -1,
    }),

  // the caller (UI) triggers reanalyze() after this — the store stays free of
  // a store -> loadFile -> store import cycle
  setAnalysisSource: (analysisSource) => set({ analysisSource }),

  setPlaying: (isPlaying) => set({ isPlaying }),
  setPlayhead: (playhead) => set({ playhead }),

  setSpeed: (speed) => {
    engine.setRate(speed);
    set({ speed });
    persist({ ...get(), speed });
  },
  setPitchSemitones: (pitchSemitones) => {
    engine.setPitch(pitchSemitones, get().tuneCents);
    set({ pitchSemitones });
    persist({ ...get(), pitchSemitones });
  },
  setTuneCents: (tuneCents) => {
    engine.setPitch(get().pitchSemitones, tuneCents);
    set({ tuneCents });
    persist({ ...get(), tuneCents });
  },

  setLoopPoints: (loopA, loopB) => {
    set({ loopA, loopB });
    const { loopEnabled } = get();
    engine.setLoop(loopEnabled ? loopA : null, loopEnabled ? loopB : null);
  },
  setLoopEnabled: (loopEnabled) => {
    set({ loopEnabled });
    const { loopA, loopB } = get();
    engine.setLoop(loopEnabled ? loopA : null, loopEnabled ? loopB : null);
  },
  saveLoop: (name) => {
    const { loopA, loopB, savedLoops } = get();
    if (loopA === null || loopB === null) return;
    const next = [...savedLoops.filter((l) => l.name !== name), { name, a: loopA, b: loopB }];
    set({ savedLoops: next });
    persist({ ...get(), savedLoops: next });
  },
  recallLoop: (loop) => {
    set({ loopA: loop.a, loopB: loop.b, loopEnabled: true });
    engine.setLoop(loop.a, loop.b);
    engine.seek(loop.a);
  },
  deleteLoop: (name) => {
    const next = get().savedLoops.filter((l) => l.name !== name);
    set({ savedLoops: next });
    persist({ ...get(), savedLoops: next });
  },

  setChordTrack: (chordTrack) => set({ chordTrack }),
  setAnalysisProgress: (analysisProgress) => set({ analysisProgress }),

  setGrid: (partial) => {
    const grid = { ...get().grid, ...partial };
    set({ grid });
    persist({ ...get(), grid });
  },

  setEq: (eqLow, eqMid, eqHigh) => {
    engine.setEq(eqLow, eqMid, eqHigh);
    set({ eqLow, eqMid, eqHigh });
  },
  setMixMode: (mixMode) => {
    engine.setMixMode(mixMode);
    set({ mixMode });
  },

  setView: (view) => set({ view }),
  setLiveChordMode: (liveChordMode) => set({ liveChordMode }),
}));

// Engine -> store wiring (module scope: single engine, single store).
engine.events.onPlayhead = (sec) => {
  useStore.setState({ playhead: sec });
};
engine.events.onEnded = () => {
  useStore.setState({ isPlaying: false });
};

export const transport = {
  async togglePlay(): Promise<void> {
    if (engine.isPlaying) {
      engine.pause();
      useStore.setState({ isPlaying: false });
    } else {
      await engine.play();
      useStore.setState({ isPlaying: true });
    }
  },
  seek(sec: number): void {
    engine.seek(sec);
    useStore.setState({ playhead: Math.max(0, Math.min(engine.duration, sec)) });
  },
  nudge(deltaSec: number): void {
    this.seek(engine.getPlayhead() + deltaSec);
  },
};
