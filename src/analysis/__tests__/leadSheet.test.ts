import { describe, expect, it } from 'vitest';
import { buildBars, toTextChart } from '../leadSheet';
import { TapTempo, barAtTime, snapToBeat } from '../barGrid';
import type { BarGrid, ChordSegment, ChordTrack } from '../../types';

const seg = (start: number, end: number, label: string): ChordSegment => ({
  start,
  end,
  label,
  root: label.replace(/[^A-G#b].*$/, '') || null,
  quality: null,
  bass: null,
  confidence: 0.9,
});

const GRID: BarGrid = { bpm: 120, downbeatSec: 0, timeSignature: [4, 4] }; // bar = 2s

describe('buildBars', () => {
  it('assigns one chord per bar and flags repeats as %', () => {
    const track: ChordTrack = {
      key: 'C',
      segments: [seg(0, 2, 'Dm7'), seg(2, 4, 'G7'), seg(4, 12, 'Cmaj7')],
    };
    const bars = buildBars(track, GRID, 12);
    expect(bars.length).toBe(6);
    expect(bars[0].chords.map((c) => c.label)).toEqual(['Dm7']);
    expect(bars[1].chords.map((c) => c.label)).toEqual(['G7']);
    expect(bars[2].chords.map((c) => c.label)).toEqual(['Cmaj7']);
    expect(bars[2].repeatOfPrev).toBe(false);
    expect(bars[3].repeatOfPrev).toBe(true);
    expect(bars[4].repeatOfPrev).toBe(true);
  });

  it('places two chords in one bar at the right beats', () => {
    // bar 0: Dm7 on beat 0-1, G7 on beats 2-3 (beat = 0.5s)
    const track: ChordTrack = {
      key: null,
      segments: [seg(0, 1, 'Dm7'), seg(1, 2, 'G7'), seg(2, 4, 'Cmaj7')],
    };
    const bars = buildBars(track, GRID, 4);
    expect(bars[0].chords.map((c) => `${c.label}@${c.beat}`)).toEqual(['Dm7@0', 'G7@2']);
    expect(bars[1].chords.map((c) => c.label)).toEqual(['Cmaj7']);
  });

  it('skips N.C. and trims empty trailing bars', () => {
    const track: ChordTrack = {
      key: null,
      segments: [seg(0, 2, 'Fmaj7'), { ...seg(2, 8, 'N.C.'), root: null }],
    };
    const bars = buildBars(track, GRID, 8);
    expect(bars.length).toBe(1);
    expect(bars[0].chords[0].label).toBe('Fmaj7');
  });

  it('respects a shifted downbeat', () => {
    const grid: BarGrid = { bpm: 120, downbeatSec: 1, timeSignature: [4, 4] };
    const track: ChordTrack = { key: null, segments: [seg(1, 3, 'Bb7')] };
    const bars = buildBars(track, grid, 4);
    expect(bars[0].startSec).toBe(1);
    expect(bars[0].chords[0].label).toBe('Bb7');
  });
});

describe('toTextChart', () => {
  it('renders 4 bars per line with % repeats', () => {
    const track: ChordTrack = {
      key: null,
      segments: [
        seg(0, 2, 'Dm7'),
        seg(2, 4, 'G7b9'),
        seg(4, 8, 'Cmaj7'),
        seg(8, 10, 'Fm7'),
        seg(10, 12, 'Bb7'),
      ],
    };
    const chart = toTextChart(buildBars(track, GRID, 12));
    const lines = chart.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('Dm7');
    expect(lines[0]).toContain('G7b9');
    expect(lines[0]).toContain('Cmaj7');
    expect(lines[0]).toContain('%');
    expect(lines[1]).toContain('Fm7');
    expect(lines[1]).toContain('Bb7');
  });
});

describe('barGrid helpers', () => {
  it('snaps to the beat grid', () => {
    expect(snapToBeat(GRID, 0.26)).toBeCloseTo(0.5);
    expect(snapToBeat(GRID, 0.24)).toBeCloseTo(0);
  });

  it('finds the bar containing a time', () => {
    expect(barAtTime(GRID, 0)).toBe(0);
    expect(barAtTime(GRID, 1.99)).toBe(0);
    expect(barAtTime(GRID, 2)).toBe(1);
  });

  it('tap tempo converges on the tapped interval', () => {
    const tap = new TapTempo();
    let bpm: number | null = null;
    for (let i = 0; i < 5; i++) bpm = tap.tap(i * 500); // 500ms -> 120 bpm
    expect(bpm).toBeCloseTo(120);
  });
});
