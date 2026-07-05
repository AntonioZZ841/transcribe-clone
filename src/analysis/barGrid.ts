// Manual bar grid: user supplies bpm + downbeat (tap tempo / set-at-playhead).
// Automatic beat tracking can later replace the *source* of BarGrid without
// touching consumers.

import type { BarGrid } from '../types';

export const DEFAULT_GRID: BarGrid = { bpm: 120, downbeatSec: 0, timeSignature: [4, 4] };

export const beatSec = (grid: BarGrid): number => 60 / grid.bpm;

export const barSec = (grid: BarGrid): number => beatSec(grid) * grid.timeSignature[0];

/** Bar index (0-based) containing time t. Times before the downbeat clamp to 0. */
export const barAtTime = (grid: BarGrid, t: number): number =>
  Math.max(0, Math.floor((t - grid.downbeatSec) / barSec(grid)));

export const barStart = (grid: BarGrid, index: number): number =>
  grid.downbeatSec + index * barSec(grid);

/** Snap a time to the nearest beat. */
export const snapToBeat = (grid: BarGrid, t: number): number => {
  const b = beatSec(grid);
  return grid.downbeatSec + Math.round((t - grid.downbeatSec) / b) * b;
};

export const numBars = (grid: BarGrid, duration: number): number =>
  Math.max(0, Math.ceil((duration - grid.downbeatSec) / barSec(grid)));

/** Tap-tempo: median of recent inter-tap intervals. */
export class TapTempo {
  private taps: number[] = [];

  tap(nowMs: number): number | null {
    // reset if the previous tap was too long ago
    if (this.taps.length > 0 && nowMs - this.taps[this.taps.length - 1] > 2500) {
      this.taps = [];
    }
    this.taps.push(nowMs);
    if (this.taps.length < 2) return null;
    const intervals = [];
    for (let i = 1; i < this.taps.length; i++) {
      intervals.push(this.taps[i] - this.taps[i - 1]);
    }
    intervals.sort((a, b) => a - b);
    const median = intervals[Math.floor(intervals.length / 2)];
    return Math.round((60000 / median) * 10) / 10;
  }

  reset(): void {
    this.taps = [];
  }
}
