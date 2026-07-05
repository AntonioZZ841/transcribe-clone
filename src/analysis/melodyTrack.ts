// Predominant-melody tracking over per-frame pitch picks, so the chord
// analysis can subtract the lead line before folding chroma.
//
// Heuristic version of the Melodia/pYIN idea: the melody is the strong,
// *moving* top voice with temporal continuity. We link the strongest
// upper-register pick frame-to-frame (jump-penalized), then only treat it as
// melody where the line actually moves — a static top voice for a whole
// window is far more likely to be a held harmony note (e.g. the 7th on top
// of a piano voicing), and removing that would destroy chord evidence.
//
// A future upgrade can swap this for a real f0 tracker (pYIN/CREPE) plus
// sinusoidal-model subtraction of the melody's partials; the interface
// (frame picks in, per-frame excluded midi out) stays the same.

import type { PickedPitch } from './pitchSalience';

const MELODY_MIN_MIDI = 60; // melody register: C4 and up
const REL_STRENGTH = 0.2; // candidate must be ≥ this fraction of frame max
const JUMP_PENALTY = 0.12; // per-semitone continuity penalty
const TOP_VOICE_BONUS = 1.2;
const MOBILITY_WINDOW = 4; // ± frames; melody must move within this window

/**
 * @returns per-frame midi of the tracked melody note, or null where no
 *          (moving) melody is present.
 */
export function trackMelody(framePicks: PickedPitch[][]): (number | null)[] {
  // 1) raw trajectory: strongest continuous upper-register pick per frame
  const raw: (number | null)[] = new Array(framePicks.length).fill(null);
  let prev: number | null = null;
  for (let i = 0; i < framePicks.length; i++) {
    const picks = framePicks[i];
    if (picks.length === 0) {
      prev = null;
      continue;
    }
    let frameMax = 0;
    let top = -1;
    for (const p of picks) {
      if (p.evidence > frameMax) frameMax = p.evidence;
      if (p.midi >= MELODY_MIN_MIDI && p.midi > top) top = p.midi;
    }
    let best: number | null = null;
    let bestScore = 0;
    for (const p of picks) {
      if (p.midi < MELODY_MIN_MIDI || p.evidence < frameMax * REL_STRENGTH) continue;
      const continuity = prev === null ? 1 : 1 / (1 + JUMP_PENALTY * Math.abs(p.midi - prev));
      const score = p.evidence * continuity * (p.midi === top ? TOP_VOICE_BONUS : 1);
      if (score > bestScore) {
        bestScore = score;
        best = p.midi;
      }
    }
    raw[i] = best;
    if (best !== null) prev = best;
  }

  // 2) mobility gate: melody moves; a static line is treated as harmony
  return raw.map((m, i) => {
    if (m === null) return null;
    for (
      let j = Math.max(0, i - MOBILITY_WINDOW);
      j <= Math.min(raw.length - 1, i + MOBILITY_WINDOW);
      j++
    ) {
      if (raw[j] !== null && raw[j] !== m) return m; // moving -> melody
    }
    return null; // static -> keep as harmony
  });
}
