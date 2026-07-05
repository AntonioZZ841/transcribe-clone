// Voicing estimation: which octaves of the detected chord's tones are
// actually sounding. Constrained polyphonic estimation — we already know the
// pitch classes from the chord label, so we only score candidate notes whose
// pitch class is a chord tone, greedily accepting the strongest with harmonic
// suppression so overtones don't masquerade as played notes.

import { SaliencePicker } from './pitchSalience';
import { CHORD_QUALITIES, qualityPcs } from './chordTemplates';
import { matchChord } from './chordMatch';
import { midiToName, nameToPc, noteNameToMidi } from '../types';

const MIDI_LO = 28; // E1
const MIDI_HI = 84; // C6
const BASS_MIDI_HI = 48; // ~C3: the bass search register
const MAX_NOTES = 6;

/**
 * Estimate sounding notes for a chord segment.
 * @param mags   averaged linear magnitude spectrum over the segment
 * @param rootName chord root, e.g. "D"
 * @param quality  quality key, e.g. "m7"
 * @param bassName slash bass name or null
 * @param excludeMidi notes belonging to the tracked lead melody, removed from
 *   the voicing so the staff shows the comping/harmony, not the melodic line.
 *   Their spectral partials are also damped so they don't inflate lower picks.
 * @returns note names low->high, e.g. ["D2","A3","C4","F4"]
 */
export function estimateVoicing(
  mags: Float32Array,
  sampleRate: number,
  fftSize: number,
  rootName: string,
  quality: string,
  bassName: string | null,
  excludeMidi?: Set<number>,
): string[] {
  const rootPc = nameToPc(rootName);
  const chordPcs = new Set(qualityPcs(quality).map((iv) => (rootPc + iv) % 12));
  const bassPc = bassName ? nameToPc(bassName) : rootPc;

  const picker = new SaliencePicker(mags, sampleRate, fftSize);
  // remove the melody's spectral contribution before estimating the voicing
  if (excludeMidi) for (const m of excludeMidi) picker.suppress(m);
  const accepted: number[] = [];

  // 1) bass first: strongest low-register candidate, biased toward the
  //    expected bass pitch class
  let bassMidi = -1;
  let bassEv = 0;
  for (let m = MIDI_LO; m <= BASS_MIDI_HI; m++) {
    const pc = m % 12;
    if (!chordPcs.has(pc)) continue;
    if (excludeMidi && excludeMidi.has(m)) continue;
    const ev = picker.evidence(m) * (pc === bassPc ? 1.35 : 1);
    if (ev > bassEv) {
      bassEv = ev;
      bassMidi = m;
    }
  }
  if (bassMidi >= 0 && bassEv > 0) {
    accepted.push(bassMidi);
    picker.suppress(bassMidi);
  }

  // 2) greedily add remaining chord tones by evidence
  const rest = picker.pick({
    midiLo: MIDI_LO,
    midiHi: MIDI_HI,
    maxNotes: MAX_NOTES - accepted.length,
    minRelEvidence: 0.12,
    pcFilter: chordPcs,
    excludeMidi,
  });
  for (const p of rest) {
    if (!accepted.some((a) => Math.abs(a - p.midi) < 1)) accepted.push(p.midi);
  }

  accepted.sort((a, b) => a - b);
  return accepted.map(midiToName);
}

export interface ReconciledVoicing {
  notes: string[];
  /** pitch class of the notated bass (slash), or null if the root is lowest */
  bassPc: number | null;
}

/**
 * Make the printed chord label and the drawn voicing tell the same story, in
 * both directions:
 *  - label -> voicing: if the estimated voicing is missing a *defining* tone
 *    (so the notes alone would NOT be recognized as this chord), add the
 *    minimal shell — highest-weight template tones first — until the voicing's
 *    pitch classes round-trip through the matcher to the same root+quality.
 *    Nothing is added when the voicing is already sufficient.
 *  - voicing -> label: the notated slash is taken from the actual lowest note,
 *    so `Cmaj7/E` is printed iff E is really at the bottom of the staff.
 */
export function reconcileVoicing(
  rootName: string,
  quality: string,
  notes: string[],
): ReconciledVoicing {
  const rootPc = nameToPc(rootName);
  const tpl = CHORD_QUALITIES[quality];
  const templatePcs = tpl.intervals
    .map((iv, i) => ({ pc: (rootPc + iv) % 12, w: tpl.weights[i] }))
    .sort((a, b) => b.w - a.w);

  const midis = notes
    .map(noteNameToMidi)
    .filter((m): m is number => m !== null)
    .sort((a, b) => a - b);

  // Would these pitch classes be recognized as the intended chord? Reference
  // the root in the bass so the check is about pc-content, not inversion.
  const roundTrips = (): boolean => {
    if (midis.length === 0) return false;
    const chroma = new Float32Array(12);
    for (const m of midis) chroma[((m % 12) + 12) % 12] = 1;
    const bass = new Float32Array(12);
    bass[rootPc] = 1;
    const r = matchChord(chroma, bass, 1);
    return r !== null && r.rootPc === rootPc && r.quality === quality;
  };

  const median = midis.length ? midis[Math.floor(midis.length / 2)] : 60;
  for (const { pc } of templatePcs) {
    if (roundTrips()) break;
    if (midis.some((m) => ((m % 12) + 12) % 12 === pc)) continue;
    // place the implied tone nearest the middle of the voicing, above the bass
    let m = pc + 12 * Math.round((median - pc) / 12);
    if (midis.length) m = Math.max(m, midis[0] + 1);
    while (midis.includes(m)) m += 12;
    midis.push(m);
    midis.sort((a, b) => a - b);
  }

  const bassPc = midis.length && ((midis[0] % 12) + 12) % 12 !== rootPc
    ? ((midis[0] % 12) + 12) % 12
    : null;
  return { notes: midis.map(midiToName), bassPc };
}
