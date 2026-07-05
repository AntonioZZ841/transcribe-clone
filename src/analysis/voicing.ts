// Voicing estimation: which octaves of the detected chord's tones are
// actually sounding. Constrained polyphonic estimation — we already know the
// pitch classes from the chord label, so we only score candidate notes whose
// pitch class is a chord tone, greedily accepting the strongest with harmonic
// suppression so overtones don't masquerade as played notes.

import { SaliencePicker } from './pitchSalience';
import { qualityPcs } from './chordTemplates';
import { midiToName, nameToPc } from '../types';

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
 * @returns note names low->high, e.g. ["D2","A3","C4","F4"]
 */
export function estimateVoicing(
  mags: Float32Array,
  sampleRate: number,
  fftSize: number,
  rootName: string,
  quality: string,
  bassName: string | null,
): string[] {
  const rootPc = nameToPc(rootName);
  const chordPcs = new Set(qualityPcs(quality).map((iv) => (rootPc + iv) % 12));
  const bassPc = bassName ? nameToPc(bassName) : rootPc;

  const picker = new SaliencePicker(mags, sampleRate, fftSize);
  const accepted: number[] = [];

  // 1) bass first: strongest low-register candidate, biased toward the
  //    expected bass pitch class
  let bassMidi = -1;
  let bassEv = 0;
  for (let m = MIDI_LO; m <= BASS_MIDI_HI; m++) {
    const pc = m % 12;
    if (!chordPcs.has(pc)) continue;
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
  });
  for (const p of rest) {
    if (!accepted.some((a) => Math.abs(a - p.midi) < 1)) accepted.push(p.midi);
  }

  accepted.sort((a, b) => a - b);
  return accepted.map(midiToName);
}
