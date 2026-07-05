// Big current-chord readout. Default mode reads the precomputed chord track at
// the playhead (stable); live mode analyses the analyser output on the fly —
// this is the real-time path that works even while scrubbing.

import { useEffect, useState } from 'react';
import { engine } from '../audio/engine';
import { useStore } from '../state/store';
import { chromaFromSpectrum } from '../analysis/chroma';
import { matchChord } from '../analysis/chordMatch';
import type { ChordSegment } from '../types';

function segmentAt(segments: ChordSegment[], t: number): ChordSegment | null {
  // binary search
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].end <= t) lo = mid + 1;
    else if (segments[mid].start > t) hi = mid - 1;
    else return segments[mid];
  }
  return null;
}

export function NowChord() {
  const playhead = useStore((s) => s.playhead);
  const chordTrack = useStore((s) => s.chordTrack);
  const liveChordMode = useStore((s) => s.liveChordMode);
  const setLiveChordMode = useStore((s) => s.setLiveChordMode);
  const isPlaying = useStore((s) => s.isPlaying);
  const [liveLabel, setLiveLabel] = useState<string>('—');

  useEffect(() => {
    if (!liveChordMode) return;
    const id = setInterval(() => {
      if (!engine.isPlaying) return;
      const live = engine.getLiveSpectrum();
      if (!live) return;
      const { chroma, bassChroma, energy } = chromaFromSpectrum(
        live.mags,
        engine.sampleRate,
        live.fftSize,
      );
      const cand = matchChord(chroma, bassChroma, energy);
      setLiveLabel(cand ? cand.label : '—');
    }, 120);
    return () => clearInterval(id);
  }, [liveChordMode]);

  let label = '—';
  let sub = '';
  if (liveChordMode) {
    label = isPlaying ? liveLabel : '—';
    sub = 'live';
  } else if (chordTrack) {
    const seg = segmentAt(chordTrack.segments, playhead);
    if (seg) {
      label = seg.label;
      sub = seg.notes && seg.notes.length > 0 ? seg.notes.join(' ') : '';
    }
  }

  return (
    <div className="now-chord">
      <span className="sub">{sub}</span>
      <span className="label">{label}</span>
      <button
        className={liveChordMode ? 'active' : ''}
        title="Live mode analyses the audio output in real time instead of reading the precomputed track"
        onClick={() => setLiveChordMode(!liveChordMode)}
      >
        Live
      </button>
    </div>
  );
}
