// Chroma frame -> best jazz chord label.
// Weighted template matching (adamstark-style residual scoring, extended):
//   score = matched weighted energy − penalty for energy outside the template
//           − complexity penalty + bass-note bonus
// The bass bonus is what disambiguates same-pitch-class pairs (C6 vs Am7).

import { CHORD_QUALITIES, QUALITY_KEYS } from './chordTemplates';
import { NOTE_NAMES } from '../types';

export interface ChordCandidate {
  rootPc: number;
  quality: string;
  label: string;
  score: number;
  confidence: number;
  bassPc: number | null;
}

const OUTSIDE_PENALTY = 0.7;
const BASS_ROOT_BONUS = 0.1;
const SILENCE_ENERGY = 1e-6;
// Melody wildcard: forgive part of the single loudest non-chord pitch class,
// but only to the extent that tone is temporally *unstable* — a sustained
// foreign tone is real harmony evidence (e.g. the 7th a triad template would
// love to ignore), while a flickering one is melody residue.
const WILDCARD_FORGIVENESS = 0.8;

export function labelFor(rootPc: number, quality: string, bassPc: number | null): string {
  const base = `${NOTE_NAMES[rootPc]}${CHORD_QUALITIES[quality].suffix}`;
  if (bassPc !== null && bassPc !== rootPc) return `${base}/${NOTE_NAMES[bassPc]}`;
  return base;
}

/**
 * Score every root x quality against a normalized chroma vector.
 * `bassChroma` supplies bass-note evidence; `energy` gates out silence.
 * `stability` (0..1 per pitch class, optional) is the fraction of the
 * smoothing window in which each pc was active — unstable foreign tones are
 * partially forgiven as likely melody. Omitted = fully stable = no wildcard.
 */
export function matchChord(
  chroma: Float32Array,
  bassChroma: Float32Array,
  energy: number,
  stability?: Float32Array,
): ChordCandidate | null {
  if (energy < SILENCE_ENERGY) return null;

  // strongest bass pitch class (if there is meaningful bass energy)
  let bassPc: number | null = null;
  let bassMax = 0;
  for (let pc = 0; pc < 12; pc++) {
    if (bassChroma[pc] > bassMax) {
      bassMax = bassChroma[pc];
      bassPc = pc;
    }
  }
  if (bassMax < 0.3) bassPc = null;

  let total = 0;
  for (let pc = 0; pc < 12; pc++) total += chroma[pc];
  if (total <= 0) return null;

  let best: ChordCandidate | null = null;
  let secondScore = -Infinity;

  for (let root = 0; root < 12; root++) {
    for (const quality of QUALITY_KEYS) {
      const tpl = CHORD_QUALITIES[quality];
      let matched = 0;
      let weightSum = 0;
      let inTemplate = 0;
      let isTemplatePc = 0; // bitmask of template pitch classes
      for (let i = 0; i < tpl.intervals.length; i++) {
        const pc = (root + tpl.intervals[i]) % 12;
        matched += chroma[pc] * tpl.weights[i];
        weightSum += tpl.weights[i];
        inTemplate += chroma[pc];
        isTemplatePc |= 1 << pc;
      }
      // melody wildcard: forgive the loudest foreign tone by its instability
      let forgivable = 0;
      if (stability) {
        for (let pc = 0; pc < 12; pc++) {
          if (isTemplatePc & (1 << pc)) continue;
          const f = chroma[pc] * WILDCARD_FORGIVENESS * (1 - stability[pc]);
          if (f > forgivable) forgivable = f;
        }
      }
      const outsideRaw = Math.max(0, total - inTemplate - forgivable);
      const outside = outsideRaw / total; // 0..1
      let score = matched / weightSum - OUTSIDE_PENALTY * outside - tpl.complexity;
      if (bassPc !== null && bassPc === root) score += BASS_ROOT_BONUS;

      if (best === null || score > best.score) {
        if (best) secondScore = best.score;
        best = { rootPc: root, quality, label: '', score, confidence: 0, bassPc: null };
      } else if (score > secondScore) {
        secondScore = score;
      }
    }
  }

  if (!best) return null;

  // slash chord: keep the sounding bass when it's a chord tone other than root
  const tplPcs = CHORD_QUALITIES[best.quality].intervals.map(
    (iv) => (best!.rootPc + iv) % 12,
  );
  if (bassPc !== null && bassPc !== best.rootPc && tplPcs.includes(bassPc)) {
    best.bassPc = bassPc;
  }

  best.label = labelFor(best.rootPc, best.quality, best.bassPc);
  // confidence: absolute fit blended with margin over runner-up
  const margin = Number.isFinite(secondScore) ? Math.max(0, best.score - secondScore) : 0.5;
  best.confidence = Math.max(0, Math.min(1, 0.5 * best.score + 0.5 * Math.min(1, margin * 8)));
  return best;
}
