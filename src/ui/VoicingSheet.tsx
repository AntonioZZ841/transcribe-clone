// Sheet-music style output of the estimated chord voicings: a grand staff
// (treble + bass) engraved with VexFlow, one stacked chord per detected
// segment, chord symbols above, 4 bars per line. Click a bar to seek.

import { useEffect, useMemo, useRef } from 'react';
import {
  Accidental,
  Annotation,
  AnnotationVerticalJustify,
  Formatter,
  Renderer,
  Stave,
  StaveConnector,
  StaveNote,
  Voice,
} from 'vexflow';
import { transport, useStore } from '../state/store';
import { buildBars } from '../analysis/leadSheet';
import { prettyLabel } from './format';
import type { Bar } from '../types';

const BARS_PER_ROW = 4;
const MAX_BARS = 64;
const ROW_W = 1100;
const TREBLE_Y = 20;
const BASS_Y = 110;
const ROW_H = 220;

/** "Eb3" -> { key: "eb/3", accidental: "b" } */
function toVexKey(note: string): { key: string; accidental: string | null } {
  const m = note.match(/^([A-G])(#|b)?(-?\d)$/);
  if (!m) return { key: 'c/4', accidental: null };
  const [, letter, acc, octave] = m;
  return {
    key: `${letter.toLowerCase()}${acc ?? ''}/${octave}`,
    accidental: acc ?? null,
  };
}

const octaveOf = (note: string): number => Number(note.match(/(-?\d)$/)?.[1] ?? 4);
const midiOf = (note: string): number => {
  const m = note.match(/^([A-G])(#|b)?(-?\d)$/);
  if (!m) return 60;
  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  let pc = base[m[1]];
  if (m[2] === '#') pc += 1;
  if (m[2] === 'b') pc -= 1;
  return pc + (Number(m[3]) + 1) * 12;
};

function durationFor(count: number): string {
  if (count <= 1) return 'w';
  if (count === 2) return 'h';
  return 'q';
}

/** Build a StaveNote (or rest) for a set of note names on one clef. */
function makeNote(notes: string[], duration: string, clef: 'treble' | 'bass'): StaveNote {
  if (notes.length === 0) {
    return new StaveNote({
      keys: [clef === 'treble' ? 'b/4' : 'd/3'],
      duration: `${duration}r`,
      clef,
    });
  }
  const keys = notes.map(toVexKey);
  const note = new StaveNote({ keys: keys.map((k) => k.key), duration, clef });
  keys.forEach((k, i) => {
    if (k.accidental) note.addModifier(new Accidental(k.accidental), i);
  });
  return note;
}

function renderRow(container: HTMLDivElement, rowBars: Bar[], beatsPerBar: number): void {
  const renderer = new Renderer(container, Renderer.Backends.SVG);
  renderer.resize(ROW_W, ROW_H);
  const ctx = renderer.getContext();

  const barW = (ROW_W - 20) / BARS_PER_ROW;

  rowBars.forEach((bar, i) => {
    const x = 10 + i * barW;
    const treble = new Stave(x, TREBLE_Y, barW);
    const bass = new Stave(x, BASS_Y, barW);
    if (i === 0) {
      treble.addClef('treble');
      bass.addClef('bass');
    }
    treble.setContext(ctx).draw();
    bass.setContext(ctx).draw();
    if (i === 0) {
      new StaveConnector(treble, bass).setType('brace').setContext(ctx).draw();
    }
    new StaveConnector(treble, bass).setType('singleLeft').setContext(ctx).draw();
    if (i === rowBars.length - 1) {
      new StaveConnector(treble, bass).setType('singleRight').setContext(ctx).draw();
    }

    const chords = bar.chords.slice(0, 4);
    const duration = durationFor(chords.length);
    const trebleNotes: StaveNote[] = [];
    const bassNotes: StaveNote[] = [];

    if (chords.length === 0) {
      trebleNotes.push(makeNote([], 'w', 'treble'));
      bassNotes.push(makeNote([], 'w', 'bass'));
    }

    for (const c of chords) {
      const all = (c.segment.notes ?? []).filter((n) => octaveOf(n) >= 0);
      const trebleKeys = all.filter((n) => midiOf(n) >= 60);
      const bassKeys = all.filter((n) => midiOf(n) < 60);
      const tn = makeNote(trebleKeys, duration, 'treble');
      tn.addModifier(
        new Annotation(prettyLabel(c.label))
          .setFont('Georgia', 14, 'bold')
          .setVerticalJustification(AnnotationVerticalJustify.TOP),
        0,
      );
      trebleNotes.push(tn);
      bassNotes.push(makeNote(bassKeys, duration, 'bass'));
    }

    // pad 3-chord bars with a quarter rest so tick math stays consistent
    if (chords.length === 3) {
      trebleNotes.push(makeNote([], 'q', 'treble'));
      bassNotes.push(makeNote([], 'q', 'bass'));
    }

    const make = (notes: StaveNote[]) => {
      const voice = new Voice({ numBeats: beatsPerBar, beatValue: 4 });
      voice.setStrict(false);
      voice.addTickables(notes);
      return voice;
    };
    const tv = make(trebleNotes);
    const bv = make(bassNotes);
    new Formatter().joinVoices([tv]).joinVoices([bv]).format([tv, bv], barW - 60);
    tv.draw(ctx, treble);
    bv.draw(ctx, bass);
  });
}

export function VoicingSheet() {
  const chordTrack = useStore((s) => s.chordTrack);
  const duration = useStore((s) => s.duration);
  const grid = useStore((s) => s.grid);
  const hostRef = useRef<HTMLDivElement>(null);

  const bars = useMemo(
    () => (chordTrack ? buildBars(chordTrack, grid, duration).slice(0, MAX_BARS) : []),
    [chordTrack, grid, duration],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = '';
    if (bars.length === 0) return;

    for (let i = 0; i < bars.length; i += BARS_PER_ROW) {
      const rowBars = bars.slice(i, i + BARS_PER_ROW);
      const row = document.createElement('div');
      row.className = 'row';
      const svgHost = document.createElement('div');
      svgHost.style.overflowX = 'auto';
      row.appendChild(svgHost);

      // transparent per-bar click layer for seeking
      const clickLayer = document.createElement('div');
      clickLayer.className = 'click-layer';
      rowBars.forEach((bar) => {
        const cell = document.createElement('div');
        cell.title = `Bar ${bar.index + 1} — click to play from here`;
        cell.addEventListener('click', () => transport.seek(bar.startSec));
        clickLayer.appendChild(cell);
      });
      row.appendChild(clickLayer);
      host.appendChild(row);

      try {
        renderRow(svgHost, rowBars, grid.timeSignature[0]);
      } catch (err) {
        // engraving problems on odd input shouldn't take the app down
        console.error('VexFlow render failed for row', i / BARS_PER_ROW, err);
      }
    }
  }, [bars, grid.timeSignature]);

  if (!chordTrack) {
    return <div className="hint">Open a file and wait for chord analysis to finish.</div>;
  }

  return (
    <div className="voicing-sheet">
      <div ref={hostRef} />
      <div className="hint">
        Estimated voicings: for each detected chord, the engine looks for which octaves of the
        chord tones are actually present in the spectrum. Set the tempo/downbeat in the Lead
        Sheet tab to align bars. Click a bar to play from there.
      </div>
    </div>
  );
}
