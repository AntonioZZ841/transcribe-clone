// Shared harmonic-aware pitch machinery, built on spectral *peaks* rather than
// raw bins: bin-window evidence lets neighbouring semitones steal each other's
// energy at low frequencies (where a semitone is ~1 bin wide), while peak
// matching uses a tolerance in *semitones*, which is scale-invariant.
//
// Used by the offline chroma (chord detection) and the voicing estimator.

import { binToFreq } from './fft';

export const freqToMidi = (f: number): number => 69 + 12 * Math.log2(f / 440);
export const midiToFreq = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

export const N_PARTIALS = 5;
const MATCH_TOL_SEMITONES = 0.35;
const PEAK_REL_THRESHOLD = 0.004;

interface Peak {
  freq: number;
  /** mutable: suppressed when a note claims this peak as a partial */
  mag: number;
}

export interface PickedPitch {
  midi: number;
  evidence: number;
}

export interface PickOptions {
  midiLo?: number;
  midiHi?: number;
  maxNotes?: number;
  /** stop when evidence falls below this fraction of the first pick */
  minRelEvidence?: number;
  /** restrict candidates to these pitch classes */
  pcFilter?: Set<number>;
  /** never pick these exact midi notes (e.g. tracked melody notes) */
  excludeMidi?: Set<number>;
}

/**
 * Greedy pitch picker over a spectral peak list. `evidence(midi)` sums the
 * strongest peak near each expected partial (1/h weighted); accepting a note
 * damps its partials' peaks so overtones don't get re-counted as new notes.
 */
export class SaliencePicker {
  private peaks: Peak[] = []; // sorted by freq

  constructor(mags: Float32Array, sampleRate: number, fftSize: number) {
    let globalMax = 0;
    for (let k = 2; k < mags.length - 1; k++) if (mags[k] > globalMax) globalMax = mags[k];
    if (globalMax <= 0) return;
    const threshold = globalMax * PEAK_REL_THRESHOLD;
    for (let k = 2; k < mags.length - 1; k++) {
      const m = mags[k];
      if (m > threshold && m > mags[k - 1] && m >= mags[k + 1]) {
        // parabolic interpolation for sub-bin frequency
        const alpha = mags[k - 1];
        const beta = m;
        const gamma = mags[k + 1];
        const denom = alpha - 2 * beta + gamma;
        const delta = denom !== 0 ? (0.5 * (alpha - gamma)) / denom : 0;
        this.peaks.push({ freq: binToFreq(k + delta, sampleRate, fftSize), mag: m });
      }
    }
  }

  /** Index of the strongest peak within tolerance of freq, or -1. */
  private matchPeak(freq: number): number {
    // peaks are sorted by freq: binary search then scan the tolerance window
    let lo = 0;
    let hi = this.peaks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.peaks[mid].freq < freq) lo = mid + 1;
      else hi = mid;
    }
    let best = -1;
    let bestMag = 0;
    for (let i = Math.max(0, lo - 2); i < Math.min(this.peaks.length, lo + 3); i++) {
      const p = this.peaks[i];
      const distSt = Math.abs(12 * Math.log2(p.freq / freq));
      if (distSt <= MATCH_TOL_SEMITONES && p.mag > bestMag) {
        bestMag = p.mag;
        best = i;
      }
    }
    return best;
  }

  evidence(midi: number): number {
    const f0 = midiToFreq(midi);
    let ev = 0;
    for (let h = 1; h <= N_PARTIALS; h++) {
      const idx = this.matchPeak(f0 * h);
      if (idx >= 0) ev += this.peaks[idx].mag / h;
    }
    return ev;
  }

  suppress(midi: number): void {
    const f0 = midiToFreq(midi);
    for (let h = 1; h <= N_PARTIALS * 2; h++) {
      const idx = this.matchPeak(f0 * h);
      if (idx >= 0) this.peaks[idx].mag *= h === 1 ? 0.1 : 0.35;
    }
  }

  pick(opts: PickOptions = {}): PickedPitch[] {
    const {
      midiLo = 28,
      midiHi = 96,
      maxNotes = 10,
      minRelEvidence = 0.08,
      pcFilter,
      excludeMidi,
    } = opts;

    const picked: PickedPitch[] = [];
    let firstEv = 0;
    while (picked.length < maxNotes) {
      let bestMidi = -1;
      let bestEv = 0;
      for (let m = midiLo; m <= midiHi; m++) {
        if (pcFilter && !pcFilter.has(((m % 12) + 12) % 12)) continue;
        if (excludeMidi && excludeMidi.has(m)) continue;
        if (picked.some((p) => p.midi === m)) continue;
        const ev = this.evidence(m);
        if (ev > bestEv) {
          bestEv = ev;
          bestMidi = m;
        }
      }
      if (bestMidi < 0 || bestEv <= 0) break;
      if (firstEv === 0) firstEv = bestEv;
      else if (bestEv < firstEv * minRelEvidence) break;
      picked.push({ midi: bestMidi, evidence: bestEv });
      this.suppress(bestMidi);
    }
    return picked;
  }
}
