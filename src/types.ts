// Shared data model for the whole app.

/** Pitch class 0..11 where 0 = C */
export type PitchClass = number;

export const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

export interface ChordSegment {
  /** seconds */
  start: number;
  /** seconds */
  end: number;
  /** full jazz label, e.g. "Dm7", "G7b9", "Cmaj7/E", "N.C." */
  label: string;
  /** root note name, or null for N.C. */
  root: string | null;
  /** quality key into CHORD_QUALITIES, or null for N.C. */
  quality: string | null;
  /** bass note name when different from root (slash chord), else null */
  bass: string | null;
  /** 0..1 */
  confidence: number;
  /** estimated sounding notes with octaves, e.g. ["D2","A3","C4","F4"] */
  notes?: string[];
}

export interface ChordTrack {
  /** estimated key, e.g. "F" or "Dm" */
  key: string | null;
  segments: ChordSegment[];
}

export interface BarGrid {
  bpm: number;
  /** time in seconds of the first downbeat (bar 1, beat 1) */
  downbeatSec: number;
  timeSignature: [number, number];
}

export interface BarChord {
  label: string;
  /** 0-based beat within the bar where this chord starts */
  beat: number;
  /** original segment, for seeking / voicings */
  segment: ChordSegment;
}

export interface Bar {
  index: number;
  startSec: number;
  endSec: number;
  chords: BarChord[];
  /** true when identical to the previous bar (render as %) */
  repeatOfPrev: boolean;
}

export interface SavedLoop {
  name: string;
  a: number;
  b: number;
}

export interface NoteGuess {
  midi: number;
  /** relative strength 0..1 */
  strength: number;
}

export const midiToName = (midi: number): string =>
  `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;

export const nameToPc = (name: string): PitchClass => {
  const flatMap: Record<string, number> = {
    C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6,
    G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
  };
  return flatMap[name] ?? 0;
};
