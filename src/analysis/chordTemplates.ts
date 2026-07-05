// Jazz chord vocabulary: interval structures with per-tone weights.
// Weights encode what defines the chord aurally: root/3rd/7th matter most,
// 5th is often omitted in jazz voicings, extensions need real evidence.

export interface ChordQuality {
  /** suffix used in labels, e.g. "m7" -> "Dm7" */
  suffix: string;
  /** semitone intervals from root */
  intervals: number[];
  /** weight per interval (same length as intervals) */
  weights: number[];
  /** penalty subtracted per scored chord tone beyond a triad, discourages
   *  hallucinating extensions without evidence */
  complexity: number;
}

const Q = (
  suffix: string,
  intervals: number[],
  weights: number[],
  complexity = 0,
): ChordQuality => ({ suffix, intervals, weights, complexity });

// Interval cheat sheet: 0 root, 1 b9, 2 9, 3 m3/#9, 4 M3, 5 11/sus4, 6 b5/#11,
// 7 P5, 8 #5/b13, 9 6/13, 10 b7, 11 M7
export const CHORD_QUALITIES: Record<string, ChordQuality> = {
  maj:   Q('',      [0, 4, 7],           [1.0, 1.0, 0.6]),
  m:     Q('m',     [0, 3, 7],           [1.0, 1.0, 0.6]),
  aug:   Q('aug',   [0, 4, 8],           [1.0, 1.0, 0.9]),
  dim:   Q('dim',   [0, 3, 6],           [1.0, 1.0, 0.9]),
  sus4:  Q('sus4',  [0, 5, 7],           [1.0, 1.0, 0.7]),

  '6':   Q('6',     [0, 4, 7, 9],        [1.0, 1.0, 0.5, 0.85], 0.02),
  m6:    Q('m6',    [0, 3, 7, 9],        [1.0, 1.0, 0.5, 0.85], 0.02),
  '7':   Q('7',     [0, 4, 7, 10],       [1.0, 1.0, 0.5, 0.95], 0.02),
  maj7:  Q('maj7',  [0, 4, 7, 11],       [1.0, 1.0, 0.5, 0.95], 0.02),
  m7:    Q('m7',    [0, 3, 7, 10],       [1.0, 1.0, 0.5, 0.95], 0.02),
  m7b5:  Q('m7b5',  [0, 3, 6, 10],       [1.0, 1.0, 0.9, 0.95], 0.02),
  dim7:  Q('dim7',  [0, 3, 6, 9],        [1.0, 1.0, 0.9, 0.95], 0.02),
  mMaj7: Q('m(maj7)', [0, 3, 7, 11],     [1.0, 1.0, 0.5, 0.95], 0.03),
  '7sus4': Q('7sus4', [0, 5, 7, 10],     [1.0, 1.0, 0.5, 0.95], 0.03),

  '9':   Q('9',     [0, 4, 7, 10, 2],    [1.0, 1.0, 0.4, 0.9, 0.7], 0.05),
  m9:    Q('m9',    [0, 3, 7, 10, 2],    [1.0, 1.0, 0.4, 0.9, 0.7], 0.05),
  maj9:  Q('maj9',  [0, 4, 7, 11, 2],    [1.0, 1.0, 0.4, 0.9, 0.7], 0.05),
  '7b9': Q('7b9',   [0, 4, 7, 10, 1],    [1.0, 1.0, 0.4, 0.9, 0.75], 0.05),
  '7#9': Q('7#9',   [0, 4, 10, 3],       [1.0, 1.0, 0.9, 0.8], 0.06),
  '7#11': Q('7#11', [0, 4, 7, 10, 6],    [1.0, 1.0, 0.4, 0.9, 0.7], 0.06),
  '13':  Q('13',    [0, 4, 10, 2, 9],    [1.0, 1.0, 0.9, 0.5, 0.75], 0.07),
};

export const QUALITY_KEYS = Object.keys(CHORD_QUALITIES);

/** Pitch classes (relative to root 0) for a quality. */
export const qualityPcs = (quality: string): number[] =>
  CHORD_QUALITIES[quality].intervals;
