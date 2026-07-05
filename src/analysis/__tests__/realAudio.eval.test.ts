// Real-audio evaluation harness (NOT part of the normal suite — gated behind
// EVAL_AUDIO so `npm test` stays fast and self-contained).
//
// Drop mono 16-bit PCM WAVs into ./eval-audio/ (decode any source with ffmpeg:
//   ffmpeg -i song.mp3 -ac 1 -ar 22050 eval-audio/song.wav
// ) then run:
//   EVAL_AUDIO=1 npx vitest run src/analysis/__tests__/realAudio.eval.test.ts
//
// It prints the estimated key, a compact chord timeline, and a chord histogram.
// If the WAV's name matches a jazz standard AND eval-audio/jazzstd.json is
// present (the iReal Pro–sourced chart set from mikeoliphant/JazzStandards:
//   curl -sL https://raw.githubusercontent.com/mikeoliphant/JazzStandards/master/JazzStandards.json \
//     -o eval-audio/jazzstd.json
// ) it also compares the detected chord-QUALITY distribution against the iReal
// chart — a transposition- and alignment-free concordance, since real
// recordings are in unknown keys and unaligned. Ground truth for the lead
// sheet comes from those iReal charts.
//
// Both the audio and jazzstd.json are gitignored — local analysis only.

import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, it, expect } from 'vitest';
import { analyzeChords } from '../chordTrack';

const DIR = resolve(__dirname, '../../../eval-audio');

function readWavMono(path: string): { samples: Float32Array; sampleRate: number } {
  const buf = readFileSync(path);
  // walk RIFF chunks to find fmt + data (ffmpeg may add a LIST/INFO chunk)
  let pos = 12;
  let sampleRate = 22050;
  let channels = 1;
  let bits = 16;
  let dataOff = 44;
  let dataLen = buf.length - 44;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(pos + 10);
      sampleRate = buf.readUInt32LE(pos + 12);
      bits = buf.readUInt16LE(pos + 22);
    } else if (id === 'data') {
      dataOff = pos + 8;
      dataLen = size;
      break;
    }
    pos += 8 + size + (size & 1);
  }
  const bytes = bits / 8;
  const n = Math.floor(dataLen / bytes / channels);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    samples[i] = buf.readInt16LE(dataOff + i * channels * bytes) / 32768;
  }
  return { samples, sampleRate };
}

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`;
}

// --- iReal Pro ground-truth comparison (transposition-invariant) ----------
type Family =
  | 'maj' | '6' | 'maj7' | 'dom7' | 'min' | 'min6' | 'min7'
  | 'm7b5' | 'dim' | 'aug' | 'sus' | 'other';

/** Coarse chord-quality family from a label in iReal OR our own notation. */
function family(label: string): Family {
  // strip root (A-G + accidental) and any slash bass
  const s = label.replace(/^[A-G][#b]?/, '').split('/')[0];
  if (/^(m7b5|h|ø|-7b5|min7b5)/.test(s)) return 'm7b5';
  if (/^(dim7|dim|o7|o|0)/.test(s)) return 'dim';
  if (/^(m6|-6|min6)/.test(s)) return 'min6';
  if (/^(maj7|maj9|\^7|\^9|\^|M7)/.test(s)) return 'maj7';
  if (/^(m|-|min)(?!aj)/.test(s)) return /7|9|11|13/.test(s) ? 'min7' : 'min';
  if (/^(sus)/.test(s)) return 'sus';
  if (/^(aug|\+)/.test(s)) return 'aug';
  if (/^(6|69)/.test(s)) return '6';
  if (/^(7|9|11|13)/.test(s)) return 'dom7';
  if (s === '' ) return 'maj';
  if (/^(add9|2|5)/.test(s)) return 'maj';
  return 'other';
}

interface Standard { Title: string; Sections: { MainSegment: { Chords: string } }[] }

function loadStandards(): Standard[] {
  const p = resolve(DIR, 'jazzstd.json');
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Standard[]) : [];
}

function matchStandard(wavName: string, stds: Standard[]): Standard | null {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  const base = norm(wavName.replace(/\.wav$/i, '').replace(/\b(19|20)\d\d\b/g, ''));
  let best: Standard | null = null;
  let bestLen = 0;
  for (const s of stds) {
    const t = norm(s.Title);
    if ((base.includes(t) || t.includes(base)) && t.length > bestLen) {
      best = s;
      bestLen = t.length;
    }
  }
  return best;
}

/** Chord-quality histogram (normalized) from a list of (label, weight). */
function familyHist(items: [string, number][]): Map<Family, number> {
  const h = new Map<Family, number>();
  let total = 0;
  for (const [label, w] of items) {
    h.set(family(label), (h.get(family(label)) ?? 0) + w);
    total += w;
  }
  if (total > 0) for (const k of h.keys()) h.set(k, h.get(k)! / total);
  return h;
}

function cosine(a: Map<Family, number>, b: Map<Family, number>): number {
  const keys = new Set([...a.keys(), ...b.keys()]);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const k of keys) {
    const x = a.get(k) ?? 0;
    const y = b.get(k) ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function fmtHist(h: Map<Family, number>): string {
  return [...h.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${(v * 100).toFixed(0)}%`)
    .join(' ');
}

function report(name: string, samples: Float32Array, sampleRate: number): void {
  const t0 = Date.now();
  const track = analyzeChords(samples, sampleRate, { voicings: false });
  const dur = samples.length / sampleRate;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  // chord histogram (by total sounding time), skipping N.C.
  const hist = new Map<string, number>();
  for (const s of track.segments) {
    if (s.label === 'N.C.') continue;
    hist.set(s.label, (hist.get(s.label) ?? 0) + (s.end - s.start));
  }
  const top = [...hist.entries()].sort((a, b) => b[1] - a[1]);
  const ncTime = track.segments
    .filter((s) => s.label === 'N.C.')
    .reduce((a, s) => a + (s.end - s.start), 0);

  // deduped chord sequence (consecutive equal labels already merged)
  const seq = track.segments.map((s) => s.label);

  const lines = [
    `=== ${name} === (${fmt(dur)}, analyzed in ${secs}s)`,
    `estimated key: ${track.key ?? '?'}`,
    `${track.segments.length} segments, ${top.length} distinct chords, N.C. ${((ncTime / dur) * 100).toFixed(0)}% of time`,
    `top chords by time: ${top.slice(0, 14).map(([l, t]) => `${l}(${t.toFixed(0)}s)`).join('  ')}`,
    `sequence: ${seq.slice(0, 80).join(' -> ')}${seq.length > 80 ? ' ...' : ''}`,
  ];

  // iReal Pro ground-truth comparison (transposition- & alignment-invariant)
  const std = matchStandard(name, loadStandards());
  if (std) {
    const gtChords = std.Sections.flatMap((s) =>
      s.MainSegment.Chords.split('|').flatMap((bar) => bar.split(',')).map((c) => c.trim()).filter(Boolean),
    );
    const gtHist = familyHist(gtChords.map((c) => [c, 1]));
    const detHist = familyHist(
      track.segments.filter((s) => s.label !== 'N.C.').map((s) => [s.label, s.end - s.start]),
    );
    lines.push(
      `iReal chart: ${std.Title} (${gtChords.length} chords)`,
      `  ground-truth qualities: ${fmtHist(gtHist)}`,
      `  detected qualities:     ${fmtHist(detHist)}`,
      `  quality concordance (cosine, transposition-free): ${(cosine(gtHist, detHist) * 100).toFixed(0)}%`,
    );
  }
  lines.push('');
  appendFileSync(resolve(DIR, '_report.txt'), lines.join('\n') + '\n');

  expect(track.segments.length).toBeGreaterThan(0);
}

const wavs = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.wav')) : [];

describe.runIf(process.env.EVAL_AUDIO)('real-audio chord detection', () => {
  if (wavs.length === 0) {
    it('no audio found', () => {
      console.log(`Put mono WAVs in ${DIR} (see header for the ffmpeg command).`);
      expect(true).toBe(true);
    });
    return;
  }
  beforeAll(() => writeFileSync(resolve(DIR, '_report.txt'), `real-audio chord eval\n\n`));
  for (const f of wavs) {
    it(`analyzes ${f}`, () => {
      const { samples, sampleRate } = readWavMono(resolve(DIR, f));
      report(f, samples, sampleRate);
    }, 120000);
  }
});
