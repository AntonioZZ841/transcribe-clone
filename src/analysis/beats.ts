// Beat & meter detection: spectral-flux onset envelope -> tempo (weighted
// autocorrelation) -> beat times (Ellis-style dynamic programming) -> downbeat
// + time signature (harmonic-change periodicity across beats).
//
// The onset envelope runs at a finer hop than the chord analysis (beat timing
// needs ~20ms resolution, chords ~90ms). Everything downstream — beat-
// synchronous chroma, the auto lead-sheet grid — hangs off `beatTimes`.

import { magnitudeSpectrum } from './fft';

const ODF_FFT = 1024;
const ODF_HOP = 512;
const BPM_MIN = 50;
const BPM_MAX = 210;
const PREF_BPM = 120; // tempo-octave preference centre
const PREF_WIDTH = 0.9; // octaves (std of the log-normal preference)
const TIGHTNESS = 6; // DP transition stiffness

export interface BeatGridEstimate {
  bpm: number;
  beatTimes: number[];
  downbeatSec: number;
  timeSignature: [number, number];
  beatsPerBar: number;
}

/** Spectral-flux onset detection function + its frame rate (fps). */
export function onsetEnvelope(
  samples: Float32Array,
  sampleRate: number,
): { odf: Float32Array; fps: number } {
  const n = Math.max(0, Math.floor((samples.length - ODF_FFT) / ODF_HOP) + 1);
  const odf = new Float32Array(n);
  let prev: Float32Array | null = null;
  for (let i = 0; i < n; i++) {
    const mags = magnitudeSpectrum(samples.subarray(i * ODF_HOP, i * ODF_HOP + ODF_FFT));
    // log compression tames the loud low end and stabilises flux on noisy audio
    for (let k = 0; k < mags.length; k++) mags[k] = Math.log1p(20 * mags[k]);
    if (prev) {
      let flux = 0;
      for (let k = 0; k < mags.length; k++) {
        const d = mags[k] - prev[k];
        if (d > 0) flux += d;
      }
      odf[i] = flux;
    }
    prev = mags;
  }
  return { odf, fps: sampleRate / ODF_HOP };
}

/** Subtract a moving average (detrend) and half-wave rectify. */
function detrend(odf: Float32Array, win: number): Float32Array {
  const out = new Float32Array(odf.length);
  let sum = 0;
  const half = Math.floor(win / 2);
  for (let i = 0; i < odf.length; i++) {
    sum += odf[i];
    if (i >= win) sum -= odf[i - win];
    const mean = sum / Math.min(i + 1, win);
    out[Math.max(0, i - half)] = Math.max(0, odf[i] - mean);
  }
  return out;
}

const prefWeight = (bpm: number): number =>
  Math.exp(-0.5 * (Math.log2(bpm / PREF_BPM) / PREF_WIDTH) ** 2);

/**
 * Global tempo via preference-weighted, overlap-normalized autocorrelation of
 * the onset envelope. Normalizing by the number of summed terms makes the
 * periodicity at each metrical multiple comparable, so the tempo-octave
 * preference (log-normal around 120 BPM) — not an autocorrelation-magnitude
 * bias toward slow or fast — decides the level.
 */
export function estimateTempo(odf: Float32Array, fps: number): number {
  const d = detrend(odf, Math.round(fps * 1.5));
  const lagMin = Math.max(2, Math.round((fps * 60) / BPM_MAX));
  const lagMax = Math.min(d.length - 2, Math.round((fps * 60) / BPM_MIN));
  // overlap-normalized autocorrelation over the candidate range (+1 margin)
  const r = new Float32Array(lagMax + 2);
  for (let lag = lagMin - 1; lag <= lagMax + 1 && lag < d.length; lag++) {
    if (lag < 1) continue;
    let s = 0;
    let terms = 0;
    for (let i = 0; i + lag < d.length; i++, terms++) s += d[i] * d[i + lag];
    r[lag] = terms ? s / terms : 0;
  }
  // score interpolated peaks: a true period at a fractional lag (e.g. 18.46)
  // splits across integer lags, so parabolic interpolation recovers its real
  // height — without it the clean 2× lag (37.0) wrongly wins
  let bestLag = lagMin;
  let bestScore = -Infinity;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    if (r[lag] < r[lag - 1] || r[lag] < r[lag + 1]) continue; // local maxima only
    const denom = r[lag - 1] - 2 * r[lag] + r[lag + 1];
    const delta = denom !== 0 ? (0.5 * (r[lag - 1] - r[lag + 1])) / denom : 0;
    const peak = r[lag] - 0.25 * (r[lag - 1] - r[lag + 1]) * delta;
    const trueLag = lag + delta;
    const score = peak * prefWeight((60 * fps) / trueLag);
    if (score > bestScore) {
      bestScore = score;
      bestLag = trueLag;
    }
  }
  // octave correction: an accent every other beat (e.g. comping on 1 & 3) can
  // make the half-tempo peak win. If doubling the tempo (halving the lag) stays
  // in range and the beat level still has real onset support, prefer it — the
  // faster level is the true beat.
  const rAt = (lag: number) => r[Math.round(lag)] ?? 0;
  for (let k = 0; k < 2; k++) {
    const half = bestLag / 2;
    if (half < lagMin) break;
    const supported = rAt(half) >= 0.33 * rAt(bestLag);
    const preferred =
      prefWeight((60 * fps) / half) >= 0.8 * prefWeight((60 * fps) / bestLag);
    if (supported && preferred) bestLag = half;
    else break;
  }
  return (60 * fps) / bestLag;
}

const cosine = (a: Float32Array, b: Float32Array): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

/**
 * Time signature + downbeat from per-beat harmonic-change novelty: chords
 * change on downbeats, so novelty is periodic at the bar length. Tests 4/4 vs
 * 3/4 and every phase, picking the grouping whose downbeats carry the most
 * harmonic change.
 */
export function detectMeterDownbeat(beatChroma: Float32Array[]): {
  beatsPerBar: number;
  downbeatIndex: number;
} {
  const n = beatChroma.length;
  if (n < 6) return { beatsPerBar: 4, downbeatIndex: 0 };
  const novelty = new Float32Array(n);
  for (let i = 1; i < n; i++) novelty[i] = 1 - cosine(beatChroma[i], beatChroma[i - 1]);

  let best = { beatsPerBar: 4, downbeatIndex: 0, contrast: -Infinity };
  for (const B of [4, 3]) {
    for (let phase = 0; phase < B; phase++) {
      let down = 0;
      let downCount = 0;
      let other = 0;
      let otherCount = 0;
      for (let i = 0; i < n; i++) {
        if ((i - phase + B * 100) % B === 0) {
          down += novelty[i];
          downCount++;
        } else {
          other += novelty[i];
          otherCount++;
        }
      }
      const contrast =
        (downCount ? down / downCount : 0) - (otherCount ? other / otherCount : 0);
      // small bias toward 4/4 (the common case) on ties
      const adj = contrast + (B === 4 ? 0.02 : 0);
      if (adj > best.contrast) best = { beatsPerBar: B, downbeatIndex: phase, contrast: adj };
    }
  }
  return { beatsPerBar: best.beatsPerBar, downbeatIndex: best.downbeatIndex };
}

// Below this onset-periodicity, the material has no clear beat (e.g. sustained
// pads / block chords with soft attacks) and auto-tempo would be worse than a
// sensible default — so we decline to beat-sync and let the caller fall back.
const MIN_BEAT_CONFIDENCE = 0.12;

/** Periodicity of the onset envelope at the beat period (0..1) — a beat-clarity
 *  confidence: high for percussive/rhythmic audio, near 0 for sustained chords. */
function beatConfidence(odf: Float32Array, fps: number, bpm: number): number {
  const d = detrend(odf, Math.round(fps * 1.5));
  const lag = Math.round((fps * 60) / bpm);
  let r0 = 0;
  let rk = 0;
  for (let i = 0; i < d.length; i++) r0 += d[i] * d[i];
  for (let i = 0; i + lag < d.length; i++) rk += d[i] * d[i + lag];
  return r0 > 0 ? rk / r0 : 0;
}

/**
 * Full grid estimate. Returns empty `beatTimes` (a "no reliable beat" signal)
 * when the onset envelope isn't convincingly periodic, so the caller can fall
 * back to frame-based analysis with a manual/default tempo.
 */
export function estimateBeats(samples: Float32Array, sampleRate: number): {
  bpm: number;
  beatTimes: number[];
  confidence: number;
} {
  const { odf, fps } = onsetEnvelope(samples, sampleRate);
  const bpm = estimateTempo(odf, fps);
  const confidence = beatConfidence(odf, fps, bpm);
  if (confidence < MIN_BEAT_CONFIDENCE) return { bpm, beatTimes: [], confidence };
  const beatFrames = trackBeatsFrames(odf, fps, bpm);
  return { bpm, beatTimes: beatFrames.map((t) => t / fps), confidence };
}

/** DP beat tracker returning ODF-frame indices (used by estimateBeats). */
function trackBeatsFrames(odf: Float32Array, fps: number, bpm: number): number[] {
  const n = odf.length;
  if (n === 0) return [];
  const local = detrend(odf, Math.round(fps * 1.5));
  let mean = 0;
  for (const v of local) mean += v;
  mean /= n;
  let varsum = 0;
  for (const v of local) varsum += (v - mean) ** 2;
  const std = Math.sqrt(varsum / n) || 1;
  for (let i = 0; i < n; i++) local[i] /= std;

  const period = (fps * 60) / bpm;
  const lo = Math.max(1, Math.round(period * 0.5));
  const hi = Math.round(period * 2);
  const cum = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    let best = 0;
    let bestJ = -1;
    for (let d = lo; d <= hi; d++) {
      const prev = t - d;
      if (prev < 0) break;
      const score = cum[prev] - TIGHTNESS * Math.log(d / period) ** 2;
      if (score > best) {
        best = score;
        bestJ = prev;
      }
    }
    cum[t] = local[t] + (bestJ >= 0 ? best : 0);
    back[t] = bestJ;
  }
  let endT = n - 1;
  for (let t = Math.max(0, n - hi); t < n; t++) if (cum[t] > cum[endT]) endT = t;
  const beats: number[] = [];
  for (let t = endT; t >= 0; ) {
    beats.push(t);
    const p = back[t];
    if (p < 0) break;
    t = p;
  }
  return beats.reverse();
}
