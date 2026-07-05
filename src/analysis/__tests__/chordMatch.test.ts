import { describe, expect, it } from 'vitest';
import { matchChord, labelFor } from '../chordMatch';
import { CHORD_QUALITIES } from '../chordTemplates';
import { NOTE_NAMES } from '../../types';

/** Binary chroma from a chord's pitch classes, bass evidence on the root. */
function chromaFor(rootPc: number, quality: string): {
  chroma: Float32Array;
  bassChroma: Float32Array;
} {
  const chroma = new Float32Array(12);
  const bassChroma = new Float32Array(12);
  for (const iv of CHORD_QUALITIES[quality].intervals) {
    chroma[(rootPc + iv) % 12] = 1;
  }
  bassChroma[rootPc] = 1;
  return { chroma, bassChroma };
}

describe('matchChord round-trips its own templates', () => {
  // unambiguous core vocabulary, every root
  const core = ['maj', 'm', '7', 'maj7', 'm7', 'm7b5', 'sus4', '9', 'm9', 'maj9', '7b9', '7#9'];
  for (const quality of core) {
    it(`recovers ${quality} at all 12 roots`, () => {
      for (let root = 0; root < 12; root++) {
        const { chroma, bassChroma } = chromaFor(root, quality);
        const result = matchChord(chroma, bassChroma, 1);
        expect(result, `${NOTE_NAMES[root]}${quality}`).not.toBeNull();
        expect(`${result!.rootPc}:${result!.quality}`).toBe(`${root}:${quality}`);
      }
    });
  }

  it('resolves C6 vs Am7 (same pitch classes) by bass note', () => {
    const c6 = chromaFor(0, '6');
    const rc6 = matchChord(c6.chroma, c6.bassChroma, 1)!;
    expect(rc6.label).toBe('C6');

    const am7 = chromaFor(9, 'm7');
    const ram7 = matchChord(am7.chroma, am7.bassChroma, 1)!;
    expect(ram7.label).toBe('Am7');
  });

  it('resolves symmetric dim7 by bass note', () => {
    for (const root of [0, 3, 6, 9]) {
      const { chroma, bassChroma } = chromaFor(root, 'dim7');
      const r = matchChord(chroma, bassChroma, 1)!;
      expect(r.rootPc).toBe(root);
      expect(r.quality).toBe('dim7');
    }
  });

  it('returns null on silence', () => {
    expect(matchChord(new Float32Array(12), new Float32Array(12), 0)).toBeNull();
  });

  it('flags slash chords when a chord tone other than the root is in the bass', () => {
    const { chroma } = chromaFor(0, 'maj7'); // Cmaj7
    const bassChroma = new Float32Array(12);
    bassChroma[4] = 1; // E in the bass
    const r = matchChord(chroma, bassChroma, 1)!;
    expect(r.label).toBe('Cmaj7/E');
  });
});

describe('labelFor', () => {
  it('formats plain, suffixed and slash labels', () => {
    expect(labelFor(0, 'maj', null)).toBe('C');
    expect(labelFor(2, 'm7', null)).toBe('Dm7');
    expect(labelFor(7, '7b9', null)).toBe('G7b9');
    expect(labelFor(0, 'maj7', 4)).toBe('Cmaj7/E');
  });
});
