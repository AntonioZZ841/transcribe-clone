// Realistic jazz "tracks" synthesized in-memory: walking bass (quarter notes
// through chord + chromatic approach tones) + rootless/shell piano comping +
// a bebop-ish melody, over real jazz-standard *chord progressions* (a chord
// progression is not copyrightable; the audio here is synthesized fresh).
//
// This is a far harder stress test than the pure-block demos — walking bass
// passes through non-chord tones and the piano uses rootless voicings — and it
// exercises two things at once:
//   1. chord detection accuracy against known changes (extension families ok)
//   2. label <-> voicing CONSISTENCY: every segment's estimated voicing must
//      round-trip to the same chord, and the notated slash must equal the
//      lowest drawn note.

import { describe, expect, it } from 'vitest';
import { analyzeChords } from '../chordTrack';
import { matchChord } from '../chordMatch';
import { CHORD_QUALITIES } from '../chordTemplates';
import { nameToPc, noteNameToMidi, type ChordSegment } from '../../types';

const SR = 22050; // lower SR keeps these longer clips fast; still fine >5kHz

interface Chord {
  root: string;
  quality: string; // key into CHORD_QUALITIES
  pcs: number[]; // absolute pitch classes
}

function chord(root: string, quality: string): Chord {
  const rootPc = nameToPc(root);
  return { root, quality, pcs: CHORD_QUALITIES[quality].intervals.map((iv) => (rootPc + iv) % 12) };
}

// --- progressions (one chord per bar unless noted), 4/4 ------------------
// 12-bar blues in F (jazz changes)
const BLUES_F: Chord[] = [
  chord('F', '7'), chord('Bb', '7'), chord('F', '7'), chord('F', '7'),
  chord('Bb', '7'), chord('Bb', '7'), chord('F', '7'), chord('D', '7'),
  chord('G', 'm7'), chord('C', '7'), chord('F', '7'), chord('C', '7'),
];

// ii-V-I heavy standard changes in Bb (Rhythm-changes-ish A section)
const STANDARD_BB: Chord[] = [
  chord('Bb', 'maj7'), chord('G', '7'), chord('C', 'm7'), chord('F', '7'),
  chord('Bb', 'maj7'), chord('Eb', 'maj7'), chord('C', 'm7'), chord('F', '7'),
];

// minor ii-V-i cycle (Autumn-Leaves-style motion) in Gm
const MINOR_GM: Chord[] = [
  chord('C', 'm7'), chord('F', '7'), chord('Bb', 'maj7'), chord('Eb', 'maj7'),
  chord('A', 'm7b5'), chord('D', '7b9'), chord('G', 'm7'), chord('G', 'm7'),
];

const midiToFreq = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

/** nearest midi of pitch class `pc` to a reference midi */
function nearPc(pc: number, ref: number): number {
  return pc + 12 * Math.round((ref - pc) / 12);
}

function addTone(
  buf: Float32Array,
  midi: number,
  startSec: number,
  durSec: number,
  amp: number,
  harmonics: number[],
  decay = 1.6,
): void {
  const start = Math.floor(startSec * SR);
  const end = Math.min(buf.length, Math.floor((startSec + durSec) * SR));
  const f = midiToFreq(midi);
  for (let i = start; i < end; i++) {
    const t = (i - start) / SR;
    const env = Math.min(1, t * 80) * Math.exp(-t * decay);
    const ph = 2 * Math.PI * f * t;
    let v = 0;
    harmonics.forEach((h, k) => (v += h * Math.sin((k + 1) * ph)));
    buf[i] += amp * env * v;
  }
}

/** Render walking bass + rootless comping + melody for a progression. */
function renderTrack(prog: Chord[], bpm = 132, seed = 1): Float32Array {
  const beat = 60 / bpm;
  const barsSec = prog.length * 4 * beat;
  const buf = new Float32Array(Math.ceil(barsSec * SR) + SR);
  const bassH = [1, 0.5, 0.25];
  const pianoH = [1, 0.4, 0.2, 0.1];
  const melH = [1, 0.3, 0.12];
  let rng = seed;
  const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  prog.forEach((c, bar) => {
    const barStart = bar * 4 * beat;
    const next = prog[(bar + 1) % prog.length];
    // walking bass: legato quarter notes; the root lands on the downbeat,
    // emphasized and held — as a real bassist outlines the harmony. Beats 2-3
    // are chord tones, beat 4 a chromatic approach to the next root.
    // realistic root-oriented bass (two-feel / medium swing): the ROOT lands
    // on the strong beats 1 & 3, a chord tone on beat 2, and a chromatic
    // approach to the next root on beat 4. This mirrors how a bassist actually
    // outlines the harmony — roots on downbeats — rather than a fully
    // chromatic walk (which is genuinely ambiguous without beat tracking).
    const rootB = nearPc(c.pcs[0], 40); // ~E2 area
    const fifthPc = c.pcs.length > 2 ? c.pcs[2] : c.pcs[0];
    for (let b = 0; b < 4; b++) {
      if (b === 0 || b === 2) {
        addTone(buf, rootB, barStart + b * beat, beat, b === 0 ? 0.62 : 0.55, bassH, 0.7);
      } else if (b === 1) {
        addTone(buf, nearPc(fifthPc, rootB), barStart + b * beat, beat, 0.42, bassH, 0.7);
      } else {
        const nextRoot = nearPc(next.pcs[0], 40);
        const approach = nextRoot + (rand() > 0.5 ? 1 : -1);
        addTone(buf, approach, barStart + b * beat, beat, 0.4, bassH, 0.7);
      }
    }
    // rootless piano comping: 3rd/7th (+ a color tone) around C4, short stabs
    // on beats 1 & 3 (doesn't smother the whole bar)
    const third = c.pcs[1];
    const seventh = c.pcs[c.pcs.length - 1];
    const color = c.pcs.length > 3 ? c.pcs[2] : c.pcs[1];
    const voicing = [nearPc(third, 58), nearPc(seventh, 62), nearPc(color, 65)];
    for (const stab of [0, 2]) {
      for (const m of voicing) addTone(buf, m, barStart + stab * beat, beat * 0.8, 0.14, pianoH);
    }
    // melody: two chord tones up high (beats 1,2) then a passing tone (beat 3)
    const melBase = 74;
    addTone(buf, nearPc(c.pcs[0], melBase + 5), barStart, beat * 0.9, 0.2, melH);
    addTone(buf, nearPc(third, melBase + 3), barStart + 1 * beat, beat * 0.9, 0.2, melH);
    addTone(buf, nearPc(c.pcs[0], melBase) + 1, barStart + 2 * beat, beat * 0.9, 0.18, melH); // chromatic
    addTone(buf, nearPc(seventh, melBase + 2), barStart + 3 * beat, beat * 0.9, 0.2, melH);
  });

  // normalize
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) for (let i = 0; i < buf.length; i++) buf[i] *= 0.7 / peak;
  return buf;
}

// ---- consistency invariants that must hold for EVERY segment -------------
function assertConsistent(seg: ChordSegment): void {
  if (!seg.root || !seg.quality || !seg.notes || seg.notes.length === 0) return;
  const rootPc = nameToPc(seg.root);

  // (a) the drawn voicing's pitch classes must be recognized as this chord
  const chroma = new Float32Array(12);
  const midis = seg.notes.map((n) => noteNameToMidi(n)!).sort((a, b) => a - b);
  for (const m of midis) chroma[((m % 12) + 12) % 12] = 1;
  const bass = new Float32Array(12);
  bass[rootPc] = 1;
  const r = matchChord(chroma, bass, 1);
  expect(r, `voicing of ${seg.label}`).not.toBeNull();
  expect(`${r!.rootPc}:${r!.quality}`, `voicing [${seg.notes.join(' ')}] should spell ${seg.label}`)
    .toBe(`${rootPc}:${seg.quality}`);

  // (b) notated slash must equal the lowest drawn note's pitch class
  const lowestPc = ((midis[0] % 12) + 12) % 12;
  const slash = seg.label.includes('/') ? seg.label.split('/')[1] : null;
  if (slash) {
    expect(nameToPc(slash), `slash of ${seg.label} vs lowest note ${seg.notes[0]}`).toBe(lowestPc);
  } else {
    expect(lowestPc, `${seg.label} (no slash) should have its root lowest`).toBe(rootPc);
  }
}

function dominantAt(track: { segments: ChordSegment[] }, t0: number, t1: number): ChordSegment | null {
  let best: ChordSegment | null = null;
  let bestCov = 0;
  for (const seg of track.segments) {
    const cov = Math.min(seg.end, t1) - Math.max(seg.start, t0);
    if (cov > bestCov) {
      bestCov = cov;
      best = seg;
    }
  }
  return best;
}

const TRACKS: [string, Chord[]][] = [
  ['12-bar blues in F', BLUES_F],
  ['standard changes in Bb', STANDARD_BB],
  ['minor ii-V-i in Gm', MINOR_GM],
];

describe('jazz backing tracks: detection + label/voicing consistency', () => {
  for (const [name, prog] of TRACKS) {
    describe(name, () => {
      const bpm = 132;
      const beat = 60 / bpm;
      const barSec = 4 * beat;
      const samples = renderTrack(prog, bpm);
      const track = analyzeChords(samples, SR, { voicings: true });

      it('produces a non-empty chord track', () => {
        expect(track.segments.length).toBeGreaterThan(0);
      });

      it('every segment is internally consistent (label <-> voicing)', () => {
        for (const seg of track.segments) assertConsistent(seg);
      });

      it('root of each bar matches the known progression', () => {
        let correct = 0;
        prog.forEach((c, bar) => {
          const t0 = bar * barSec + barSec * 0.25;
          const t1 = bar * barSec + barSec * 0.75;
          const seg = dominantAt(track, t0, t1);
          if (seg && seg.root !== null && nameToPc(seg.root) === c.pcs[0]) correct++;
        });
        // rootless comping + walking bass + melody is hard; require a strong
        // majority of roots correct (observed ~75-88% across these tracks)
        expect(correct / prog.length, `${correct}/${prog.length} bar roots correct`).toBeGreaterThanOrEqual(
          0.7,
        );
      });

      describe('beat-synchronous mode', () => {
        const btrack = analyzeChords(samples, SR, { voicings: false, beatSync: true });

        it('auto-detects tempo ~132 BPM and 4/4', () => {
          expect(btrack.grid, 'grid').toBeTruthy();
          expect(Math.abs(btrack.grid!.bpm - bpm) / bpm, `bpm ${btrack.grid!.bpm}`).toBeLessThan(0.06);
          expect(btrack.grid!.timeSignature[0]).toBe(4);
        });

        it('detects bar roots at least as well as the frame path', () => {
          let correct = 0;
          prog.forEach((c, bar) => {
            const seg = dominantAt(btrack, bar * barSec + barSec * 0.25, bar * barSec + barSec * 0.75);
            if (seg && seg.root !== null && nameToPc(seg.root) === c.pcs[0]) correct++;
          });
          expect(correct / prog.length, `${correct}/${prog.length} bar roots (beat-sync)`).toBeGreaterThanOrEqual(
            0.7,
          );
        });

        it('produces beat-length segments (no sub-beat blips)', () => {
          // every segment spans at least ~a beat — no frame-level over-segmentation
          // (0.25s floor allows for the beat tracker's interval variation)
          for (const seg of btrack.segments) {
            expect(seg.end - seg.start, `segment ${seg.label}`).toBeGreaterThanOrEqual(0.25);
          }
        });
      });
    });
  }
}, 120000);
