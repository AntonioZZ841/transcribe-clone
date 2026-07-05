// Chord track + bar grid -> Real Book style bars, plus plain-text chart export.

import { barSec, barStart, beatSec, numBars } from './barGrid';
import type { Bar, BarChord, BarGrid, ChordSegment, ChordTrack } from '../types';

/**
 * Quantize chord segments onto the bar grid.
 * A chord is placed at the beat where it takes over (the chord covering the
 * majority of that beat wins). Consecutive duplicate labels within a bar are
 * merged; a bar identical to its predecessor is flagged as a repeat (%).
 */
export function buildBars(track: ChordTrack, grid: BarGrid, duration: number): Bar[] {
  const bars: Bar[] = [];
  const total = numBars(grid, duration);
  const bLen = beatSec(grid);
  const beatsPerBar = grid.timeSignature[0];

  for (let i = 0; i < total; i++) {
    const start = barStart(grid, i);
    const end = start + barSec(grid);
    const chords: BarChord[] = [];

    for (let beat = 0; beat < beatsPerBar; beat++) {
      const t0 = start + beat * bLen;
      const t1 = t0 + bLen;
      const seg = dominantSegment(track.segments, t0, t1);
      if (!seg || seg.label === 'N.C.') continue;
      const last = chords[chords.length - 1];
      if (last && last.label === seg.label) continue;
      chords.push({ label: seg.label, beat, segment: seg });
    }

    const prevBar = bars[bars.length - 1];
    const repeatOfPrev =
      prevBar !== undefined &&
      prevBar.chords.length > 0 &&
      chords.length === prevBar.chords.length &&
      chords.every((c, k) => c.label === prevBar.chords[k].label && c.beat === prevBar.chords[k].beat);

    bars.push({ index: i, startSec: start, endSec: end, chords, repeatOfPrev });
  }

  // trim empty trailing bars
  while (bars.length > 0 && bars[bars.length - 1].chords.length === 0) bars.pop();
  return bars;
}

/** Segment covering the largest share of [t0, t1). */
function dominantSegment(
  segments: ChordSegment[],
  t0: number,
  t1: number,
): ChordSegment | null {
  let best: ChordSegment | null = null;
  let bestOverlap = 0;
  for (const seg of segments) {
    if (seg.end <= t0) continue;
    if (seg.start >= t1) break;
    const overlap = Math.min(seg.end, t1) - Math.max(seg.start, t0);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = seg;
    }
  }
  return best;
}

/** Render bars as a copyable text chart, 4 bars per line. */
export function toTextChart(bars: Bar[], barsPerLine = 4): string {
  if (bars.length === 0) return '';
  const cells = bars.map((bar) => {
    if (bar.repeatOfPrev) return '%';
    if (bar.chords.length === 0) return ' ';
    return bar.chords.map((c) => c.label).join(' ');
  });
  const width = Math.max(8, ...cells.map((c) => c.length + 2));
  const lines: string[] = [];
  for (let i = 0; i < cells.length; i += barsPerLine) {
    const row = cells
      .slice(i, i + barsPerLine)
      .map((c) => ` ${c}`.padEnd(width, ' '))
      .join('|');
    lines.push(`|${row}|`);
  }
  return lines.join('\n');
}
