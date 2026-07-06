// Offline whole-file chord analysis: frame -> melody f0 tracking + harmonic
// subtraction -> pitch picks -> chroma -> stability smoothing -> match ->
// median filter -> segment -> per-segment voicing. Pure function of samples,
// so it runs identically in the worker and in tests.

import { magnitudeSpectrum } from './fft';
import { bandEnergy, foldPicks, normalize } from './chroma';
import { SaliencePicker } from './pitchSalience';
import {
  frameSalience,
  subtractMelodyHarmonics,
  trackPredominantMelody,
} from './predominantMelody';
import { labelFor, matchChord } from './chordMatch';
import { estimateVoicing, reconcileVoicing } from './voicing';
import { detectMeterDownbeat, estimateBeats } from './beats';
import { NOTE_NAMES, nameToPc, type BarGrid, type ChordSegment, type ChordTrack } from '../types';

export const FFT_SIZE = 8192;
export const HOP = 4096;
const SMOOTH_FRAMES = 4; // ± frames of chroma stability window
const MEDIAN_WINDOW = 5; // label median filter
const MIN_SEGMENT_SEC = 0.35;
const BASS_EMPHASIS = 0.45; // how strongly the bass register weights the chroma
const ACTIVE_THRESHOLD = 0.15; // pc counts as "active" in a normalized frame

export interface AnalyzeOptions {
  onProgress?: (fraction: number) => void;
  voicings?: boolean;
  /** aggregate chroma per detected beat + auto tempo/meter (better on real
   *  mixes; sets track.grid). Off by default so frame-level tests are stable. */
  beatSync?: boolean;
}

interface FrameResult {
  label: string;
  root: string | null;
  quality: string | null;
  bass: string | null;
  confidence: number;
}

export function analyzeChords(
  samples: Float32Array,
  sampleRate: number,
  opts: AnalyzeOptions = {},
): ChordTrack {
  const nFrames = Math.max(0, Math.floor((samples.length - FFT_SIZE) / HOP) + 1);
  if (nFrames === 0) return { key: null, segments: [] };

  // 1) per-frame spectra + a melody-register salience function
  const rawMags: Float32Array[] = [];
  const saliences: Float32Array[] = [];
  const energies: number[] = [];
  for (let i = 0; i < nFrames; i++) {
    const frame = samples.subarray(i * HOP, i * HOP + FFT_SIZE);
    const mags = magnitudeSpectrum(frame);
    rawMags.push(mags);
    energies.push(bandEnergy(mags, sampleRate, FFT_SIZE));
    saliences.push(frameSalience(new SaliencePicker(mags, sampleRate, FFT_SIZE)));
    if (i % 32 === 0) opts.onProgress?.((0.4 * i) / nFrames);
  }

  // 1b) predominant-f0 melody tracking (Viterbi over the salience + a
  //     mobility gate so held chord tones are NOT mistaken for melody)
  const melody = trackPredominantMelody(saliences);
  const melodyMidi = melody.map((p) => p.midi);

  // 1c) subtract the melody's harmonic series from each spectrum, then derive
  //     the harmony picks + chroma from the *cleaned* spectrum
  const chromas: Float32Array[] = [];
  const bassChromas: Float32Array[] = [];
  const keyChroma = new Float32Array(12);
  for (let i = 0; i < nFrames; i++) {
    const midi = melodyMidi[i];
    const cleaned =
      midi !== null ? subtractMelodyHarmonics(rawMags[i], midi, sampleRate, FFT_SIZE) : rawMags[i];
    const picks = new SaliencePicker(cleaned, sampleRate, FFT_SIZE).pick({
      midiLo: 28,
      midiHi: 96,
      maxNotes: 10,
    });
    const chroma = new Float32Array(12);
    const bassChroma = new Float32Array(12);
    foldPicks(picks, null, chroma, bassChroma); // melody already gone from the spectrum
    chromas.push(chroma);
    bassChromas.push(bassChroma);
    for (let pc = 0; pc < 12; pc++) keyChroma[pc] += chroma[pc];
    if (i % 32 === 0) opts.onProgress?.(0.4 + (0.3 * i) / nFrames);
  }

  const frameSec = HOP / sampleRate;
  const frameOffset = FFT_SIZE / 2 / sampleRate; // center of the first frame
  let segments: ChordSegment[] = [];
  let grid: BarGrid | undefined;

  // Beat-synchronous path: aggregate the melody-subtracted chroma per detected
  // beat, auto-detect meter/downbeat, and match once per beat. Averaging over a
  // whole beat tames a walking bass (its passing tones wash out while the
  // downbeat root stays) and aligns chords to musical time for the lead sheet.
  if (opts.beatSync) {
    const bs = beatSyncSegments(chromas, bassChromas, energies, samples, sampleRate, frameOffset, frameSec);
    if (bs) {
      segments = bs.segments;
      grid = bs.grid;
    }
  }

  if (!grid) {
  // 2) stability smoothing + matching: per-pitch-class *median* over the
  //    window, not mean — a melody passing tone lights a pc for 1-3 frames
  //    and a median crushes it, while sustained harmony tones survive
  const frameResults: FrameResult[] = [];
  const smoothed = new Float32Array(12);
  const smoothedBass = new Float32Array(12);
  const stability = new Float32Array(12);
  const meanEnergy = energies.reduce((a, b) => a + b, 0) / nFrames;
  const windowVals: number[] = [];
  for (let i = 0; i < nFrames; i++) {
    const j0 = Math.max(0, i - SMOOTH_FRAMES);
    const j1 = Math.min(nFrames - 1, i + SMOOTH_FRAMES);
    const windowLen = j1 - j0 + 1;
    for (let pc = 0; pc < 12; pc++) {
      windowVals.length = 0;
      let activeCount = 0;
      for (let j = j0; j <= j1; j++) {
        windowVals.push(chromas[j][pc]);
        if (chromas[j][pc] > ACTIVE_THRESHOLD) activeCount++;
      }
      windowVals.sort((a, b) => a - b);
      smoothed[pc] = windowVals[Math.floor(windowVals.length / 2)];
      stability[pc] = activeCount / windowLen;
      // bass: MEAN over the window (not median) so the metrically-strong bass
      // root — often sounding on only the downbeat of a walking line — still
      // accumulates instead of being filtered out as a minority note
      let bassSum = 0;
      for (let j = j0; j <= j1; j++) bassSum += bassChromas[j][pc];
      smoothedBass[pc] = bassSum / windowLen;
    }
    normalize(smoothed);
    normalize(smoothedBass);
    // bass emphasis: fold a share of the bass-register chroma into the main
    // chroma so the sounding bass root carries real weight. Without this, a
    // rootless comping voicing (3rd-5th-7th) outvotes the bass and the chord
    // is misheard as rooted on its 3rd (F7's A-C-Eb reads as Adim). Emphasizing
    // the bass makes chords that omit the bass note pay the outside penalty.
    for (let pc = 0; pc < 12; pc++) smoothed[pc] += BASS_EMPHASIS * smoothedBass[pc];
    normalize(smoothed);
    // silence gate relative to the track's own level
    const silent = energies[i] < meanEnergy * 0.02;
    const cand = silent ? null : matchChord(smoothed, smoothedBass, energies[i], stability);
    if (cand) {
      frameResults.push({
        label: cand.label,
        root: NOTE_NAMES[cand.rootPc],
        quality: cand.quality,
        bass: cand.bassPc !== null ? NOTE_NAMES[cand.bassPc] : null,
        confidence: cand.confidence,
      });
    } else {
      frameResults.push({ label: 'N.C.', root: null, quality: null, bass: null, confidence: 0 });
    }
    if (i % 32 === 0) opts.onProgress?.(0.6 + (0.25 * i) / nFrames);
  }

  // 3) median filter on labels (mode within window)
  const filtered = medianFilterLabels(frameResults, MEDIAN_WINDOW);

  // 4) merge into segments
  for (let i = 0; i < filtered.length; i++) {
    const t = i === 0 ? 0 : frameOffset + i * frameSec;
    const last = segments[segments.length - 1];
    if (last && last.label === filtered[i].label) {
      last.end = frameOffset + (i + 1) * frameSec;
      last.confidence = Math.max(last.confidence, filtered[i].confidence);
    } else {
      if (last) last.end = t;
      segments.push({
        start: t,
        end: frameOffset + (i + 1) * frameSec,
        label: filtered[i].label,
        root: filtered[i].root,
        quality: filtered[i].quality,
        bass: filtered[i].bass,
        confidence: filtered[i].confidence,
      });
    }
  }
  if (segments.length > 0) segments[segments.length - 1].end = samples.length / sampleRate;

  // 5) drop blips: merge too-short segments into the previous kept one
  const kept: ChordSegment[] = [];
  for (const seg of segments) {
    const prev = kept[kept.length - 1];
    if (seg.end - seg.start < MIN_SEGMENT_SEC && prev) {
      prev.end = seg.end;
    } else if (prev && prev.label === seg.label) {
      prev.end = seg.end;
      prev.confidence = Math.max(prev.confidence, seg.confidence);
    } else {
      kept.push(seg);
    }
  }
  segments = kept;
  } // end frame-based path

  // 6) voicings per segment (skip N.C.), excluding the tracked lead melody so
  //    the sheet shows the comping/harmony rather than the melodic line
  if (opts.voicings !== false) {
    for (let s = 0; s < segments.length; s++) {
      const seg = segments[s];
      if (seg.root && seg.quality) {
        const melodyNotes = melodyNotesInSpan(melodyMidi, seg.start, seg.end, frameOffset, frameSec);
        const voiced = segmentVoicing(samples, sampleRate, seg, melodyNotes);
        // reconcile so the printed label and the drawn voicing agree: complete
        // the shell if a defining tone was missed, and take the slash from the
        // actual lowest note
        if (voiced.length > 0) {
          const { notes, bassPc } = reconcileVoicing(seg.root, seg.quality, voiced);
          seg.notes = notes;
          const rootPc = nameToPc(seg.root);
          seg.bass = bassPc !== null ? NOTE_NAMES[bassPc] : null;
          seg.label = labelFor(rootPc, seg.quality, bassPc);
        } else {
          seg.notes = voiced;
        }
      }
      if (s % 4 === 0) opts.onProgress?.(0.85 + (0.15 * s) / segments.length);
    }
  }

  opts.onProgress?.(1);
  return { key: estimateKey(keyChroma), segments, grid };
}

/**
 * Beat-synchronous segmentation: detect tempo/beats, aggregate the per-frame
 * (melody-subtracted) chroma into one vector per beat, detect meter + downbeat,
 * match once per beat, then merge equal labels into beat-aligned segments.
 * Returns null when too few beats were found (caller falls back to frames).
 */
function beatSyncSegments(
  chromas: Float32Array[],
  bassChromas: Float32Array[],
  energies: number[],
  samples: Float32Array,
  sampleRate: number,
  frameOffset: number,
  frameSec: number,
): { segments: ChordSegment[]; grid: BarGrid } | null {
  const { bpm, beatTimes } = estimateBeats(samples, sampleRate);
  if (beatTimes.length < 8) return null;
  const duration = samples.length / sampleRate;
  const bounds = [...beatTimes, duration];

  const nBeats = beatTimes.length;
  const beatChroma: Float32Array[] = [];
  const beatBass: Float32Array[] = [];
  const beatStab: Float32Array[] = [];
  const beatEnergy: number[] = [];
  for (let b = 0; b < nBeats; b++) {
    const f0 = Math.max(0, Math.round((bounds[b] - frameOffset) / frameSec));
    const f1 = Math.min(chromas.length - 1, Math.round((bounds[b + 1] - frameOffset) / frameSec));
    const ch = new Float32Array(12);
    const ba = new Float32Array(12);
    const st = new Float32Array(12);
    let e = 0;
    let count = 0;
    for (let f = f0; f <= f1; f++) {
      for (let pc = 0; pc < 12; pc++) {
        ch[pc] += chromas[f][pc];
        ba[pc] += bassChromas[f][pc];
        if (chromas[f][pc] > ACTIVE_THRESHOLD) st[pc] += 1;
      }
      e += energies[f];
      count++;
    }
    if (count === 0) {
      const f = Math.min(chromas.length - 1, Math.max(0, f0));
      ch.set(chromas[f]);
      ba.set(bassChromas[f]);
      e = energies[f];
      count = 1;
    }
    for (let pc = 0; pc < 12; pc++) st[pc] /= count;
    normalize(ch);
    normalize(ba);
    beatChroma.push(ch);
    beatBass.push(ba);
    beatStab.push(st);
    beatEnergy.push(e / count);
  }

  const { beatsPerBar, downbeatIndex } = detectMeterDownbeat(beatChroma);
  const meanEnergy = beatEnergy.reduce((a, b) => a + b, 0) / nBeats;

  // match per beat (with bass emphasis, as in the frame path)
  const beatResults: FrameResult[] = [];
  for (let b = 0; b < nBeats; b++) {
    const ch = Float32Array.from(beatChroma[b]);
    for (let pc = 0; pc < 12; pc++) ch[pc] += BASS_EMPHASIS * beatBass[b][pc];
    normalize(ch);
    const cand =
      beatEnergy[b] < meanEnergy * 0.02
        ? null
        : matchChord(ch, beatBass[b], beatEnergy[b], beatStab[b]);
    beatResults.push(
      cand
        ? {
            label: cand.label,
            root: NOTE_NAMES[cand.rootPc],
            quality: cand.quality,
            bass: cand.bassPc !== null ? NOTE_NAMES[cand.bassPc] : null,
            confidence: cand.confidence,
          }
        : { label: 'N.C.', root: null, quality: null, bass: null, confidence: 0 },
    );
  }

  const filtered = medianFilterLabels(beatResults, 3);
  const segments: ChordSegment[] = [];
  for (let b = 0; b < nBeats; b++) {
    const last = segments[segments.length - 1];
    if (last && last.label === filtered[b].label) {
      last.end = bounds[b + 1];
      last.confidence = Math.max(last.confidence, filtered[b].confidence);
    } else {
      segments.push({
        start: b === 0 ? 0 : bounds[b],
        end: bounds[b + 1],
        label: filtered[b].label,
        root: filtered[b].root,
        quality: filtered[b].quality,
        bass: filtered[b].bass,
        confidence: filtered[b].confidence,
      });
    }
  }

  // Refine the downbeat *phase* to align bar lines with where chords actually
  // change: the beat tracker's absolute phase can be a fraction of a beat off
  // and detectMeterDownbeat may pick a later bar line, which would start the
  // lead-sheet grid mid-tune. Take the duration-weighted circular mean of the
  // segment-start phases (mod one bar) — chord changes cluster on downbeats.
  const barSec = (beatsPerBar * 60) / bpm;
  let sx = 0;
  let sy = 0;
  for (const seg of segments) {
    if (seg.start <= 0 || seg.label === 'N.C.') continue;
    const w = Math.min(seg.end - seg.start, barSec);
    const ang = (2 * Math.PI * (seg.start % barSec)) / barSec;
    sx += w * Math.cos(ang);
    sy += w * Math.sin(ang);
  }
  let phase = sx === 0 && sy === 0
    ? beatTimes[Math.min(downbeatIndex, beatTimes.length - 1)] % barSec
    : (Math.atan2(sy, sx) / (2 * Math.PI)) * barSec;
  if (phase < 0) phase += barSec;

  const grid: BarGrid = {
    bpm: Math.round(bpm * 10) / 10,
    downbeatSec: phase,
    timeSignature: [beatsPerBar, 4],
  };
  return { segments, grid };
}

/** Distinct tracked-melody midi notes whose frame falls within [start, end). */
function melodyNotesInSpan(
  melody: (number | null)[],
  start: number,
  end: number,
  frameOffset: number,
  frameSec: number,
): Set<number> {
  const notes = new Set<number>();
  const i0 = Math.max(0, Math.floor((start - frameOffset) / frameSec));
  const i1 = Math.min(melody.length - 1, Math.ceil((end - frameOffset) / frameSec));
  for (let i = i0; i <= i1; i++) {
    if (melody[i] !== null) notes.add(melody[i]!);
  }
  return notes;
}

/** Averaged spectrum over the middle of the segment -> voicing estimate. */
function segmentVoicing(
  samples: Float32Array,
  sampleRate: number,
  seg: ChordSegment,
  excludeMidi?: Set<number>,
): string[] {
  const startSample = Math.floor(seg.start * sampleRate);
  const endSample = Math.min(samples.length, Math.floor(seg.end * sampleRate));
  const span = endSample - startSample;
  if (span < FFT_SIZE) return [];
  // sample up to 4 frames from the stable middle 60% of the segment
  const midStart = startSample + Math.floor(span * 0.2);
  const midEnd = endSample - Math.floor(span * 0.2) - FFT_SIZE;
  const nFrames = Math.max(1, Math.min(4, Math.floor((midEnd - midStart) / HOP) + 1));
  const avg = new Float32Array(FFT_SIZE / 2);
  let used = 0;
  for (let i = 0; i < nFrames; i++) {
    const off = midStart + Math.floor(((midEnd - midStart) * i) / Math.max(1, nFrames - 1) || 0);
    if (off < 0 || off + FFT_SIZE > samples.length) continue;
    const mags = magnitudeSpectrum(samples.subarray(off, off + FFT_SIZE));
    for (let k = 0; k < avg.length; k++) avg[k] += mags[k];
    used++;
  }
  if (used === 0) return [];
  return estimateVoicing(avg, sampleRate, FFT_SIZE, seg.root!, seg.quality!, seg.bass, excludeMidi);
}

function medianFilterLabels(frames: FrameResult[], window: number): FrameResult[] {
  const half = Math.floor(window / 2);
  return frames.map((_, i) => {
    const counts = new Map<string, number>();
    for (let j = Math.max(0, i - half); j <= Math.min(frames.length - 1, i + half); j++) {
      counts.set(frames[j].label, (counts.get(frames[j].label) ?? 0) + 1);
    }
    let bestLabel = frames[i].label;
    let bestCount = 0;
    for (const [label, count] of counts) {
      if (count > bestCount) {
        bestCount = count;
        bestLabel = label;
      }
    }
    // return the frame nearest to i that carries the winning label
    for (let d = 0; d <= half; d++) {
      for (const j of [i - d, i + d]) {
        if (j >= 0 && j < frames.length && frames[j].label === bestLabel) return frames[j];
      }
    }
    return frames[i];
  });
}

// Krumhansl-Schmuckler style key estimation from summed chroma.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export function estimateKey(summedChroma: Float32Array): string | null {
  let total = 0;
  for (let pc = 0; pc < 12; pc++) total += summedChroma[pc];
  if (total <= 0) return null;
  let best = -Infinity;
  let bestKey: string | null = null;
  for (let tonic = 0; tonic < 12; tonic++) {
    let maj = 0;
    let min = 0;
    for (let pc = 0; pc < 12; pc++) {
      maj += summedChroma[(tonic + pc) % 12] * MAJOR_PROFILE[pc];
      min += summedChroma[(tonic + pc) % 12] * MINOR_PROFILE[pc];
    }
    if (maj > best) {
      best = maj;
      bestKey = NOTE_NAMES[tonic];
    }
    if (min > best) {
      best = min;
      bestKey = `${NOTE_NAMES[tonic]}m`;
    }
  }
  return bestKey;
}
