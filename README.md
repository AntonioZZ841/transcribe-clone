# Transcribe Clone

A browser-based clone of [Transcribe!](https://www.seventhstring.com/xscribe/overview.html)
(Seventh String Software) — a tool for musicians working out music by ear — with an extra
headline feature: **real-time jazz chord annotation** plus **Real Book style lead sheet** and
**sheet-music voicing** output.

## Features

- **Waveform navigation** — scrollable/zoomable canvas waveform, click to seek, drag to set a
  loop region, wheel to zoom, chord lane rendered underneath.
- **Pitch-independent slowdown** — 25%–200% speed without changing pitch, via the
  [signalsmith-stretch](https://github.com/Signalsmith-Audio/signalsmith-stretch) WASM
  AudioWorklet.
- **Pitch shift & fine tune** — ±semitones plus ±50 cents, without changing speed.
- **A–B loops** — drag on the waveform or `[` / `]` keys; save, name, recall (persisted).
- **Spectrum & note guessing** — live log-frequency spectrum, harmonic-suppressed peak
  picking, detected notes highlighted on a clickable piano keyboard (click = reference tone).
- **Chord detection (jazz vocabulary)** — offline whole-file analysis in a Web Worker:
  harmonic-suppressed pitch salience → chroma → weighted template matching over 22 qualities
  (`maj7`, `m7`, `m7b5`, `dim7`, `9`, `13`, `7b9`, `7#9`, `7#11`, slash chords, …), median
  filtering and segmentation into a chord track with confidences + estimated key.
- **Real-time now-chord readout** — follows the playhead from the precomputed track, or flip
  to **Live** mode to analyse the actual audio output on the fly (works with EQ/pitch applied).
- **Real Book lead sheet** — tap tempo / set downbeat, chords quantized to bars, 4 bars per
  line with `%` repeat signs, ♭/♯ glyphs, click a bar to jump there, copy-as-text and JSON
  export.
- **Voicing sheet music** — per chord segment the engine estimates *which octaves* of the
  chord tones are actually sounding (spectral peak evidence constrained to the detected chord)
  and engraves them on a grand staff with [VexFlow](https://github.com/0xfe/vexflow).
- **EQ & mix** — 3-band EQ, stereo/mono/left/right/karaoke (L−R phase cancel) mix modes.
- **Keyboard shortcuts** — `Space` play/pause, `←`/`→` skip (`Shift` = fine), `[`/`]` loop
  points, `L` loop toggle.

## Run

```sh
npm install
npm run dev     # open http://localhost:5173, then drop in an audio file
npm test        # unit + accuracy tests (includes a known-progression demo clip)
npm run build   # production build
```

No audio handy? Click **“load the built-in demo clip”** — a synthesized
`| Dm7 | G7 | Cmaj7 | % | Fm7 Bb7 | Ebmaj7 | Am7b5 D7b9 | Gm |` progression the analysis
detects bar-for-bar.

## Architecture

```
src/
  audio/
    engine.ts        Web Audio graph: stretch worklet → mix matrix → 3-band EQ → analyser
    loadFile.ts      decode → engine → background analysis worker
  analysis/          pure, unit-tested DSP (no DOM)
    fft.ts           radix-2 FFT
    pitchSalience.ts peak detection + harmonic-suppressed greedy pitch picking
    chroma.ts        salience-based chroma (offline) + bin-folded chroma (live)
    chordTemplates.ts / chordMatch.ts   jazz template table + weighted scorer
    chordTrack.ts    frames → smoothing → matching → median filter → segments (+key)
    voicing.ts       chord-constrained octave estimation per segment
    barGrid.ts / leadSheet.ts           manual tempo/downbeat grid → bars, % repeats, text chart
    noteGuess.ts     live spectrum → note highlights
    worker.ts        Web Worker wrapper for whole-file analysis
  ui/                React components (waveform canvas, transport, spectrum+piano,
                     lead sheet, VexFlow voicing sheet, loop list)
  state/store.ts     zustand store + engine wiring + localStorage persistence
```

### How the chord engine works

1. **Frames** (8192 samples, hop 4096) → magnitude spectrum.
2. **Pitch salience**: detect spectral peaks (sub-bin interpolated), then greedily pick
   fundamentals — each accepted note damps its harmonics so overtones aren't re-counted
   (a note's 3rd harmonic otherwise pollutes the chroma a perfect 12th up and drowns real
   7ths/extensions).
3. **Chroma**: picked fundamentals fold into a 12-bin vector (√-compressed so a softly voiced
   7th still registers), plus a separate bass-register chroma.
4. **Matching**: every root × quality template scored as weighted-match − outside-energy
   penalty − complexity penalty + bass bonus (the bass evidence resolves `C6` vs `Am7` and
   symmetric `dim7` roots, and yields slash chords).
5. **Track**: temporal smoothing → per-frame labels → median filter → merge into segments,
   drop blips, estimate key (Krumhansl profiles), estimate a voicing per segment.

Accuracy is tested end-to-end in `src/analysis/__tests__/demoEval.test.ts` against the
bundled demo clip (8/8 bars, including `Am7b5` and slash-bass cases).

## Label ↔ voicing consistency

The printed chord label (lead sheet) and the drawn voicing (sheet music) are reconciled so they
always tell the same story, in both directions (`reconcileVoicing` in `voicing.ts`):

- **label → voicing**: if the estimated voicing is missing a *defining* tone (so the notes alone
  wouldn't be recognized as the named chord), the minimal shell is completed — highest-weight
  template tones first — until the voicing's pitch classes round-trip through the matcher to the
  same root+quality. Nothing is added when the voicing already suffices.
- **voicing → label**: the notated slash is taken from the actual lowest drawn note, so
  `Cmaj7/E` prints iff E is really at the bottom of the staff.

`jazzTracks.test.ts` asserts this invariant on every segment of three synthesized jazz
arrangements: for each chord, a binary chroma of the drawn voicing must re-detect as the printed
label, and the slash must equal the lowest note.

## Bass emphasis (rootless voicings)

Jazz piano voicings are often *rootless* (3rd–5th–7th only) — and e.g. F7's `A C Eb` is literally
an A-diminished triad. Without the bass, the matcher hears the third as the root (`F7` → `Adim`).
So the analysis (a) tracks the actual **bass line** as the single lowest sounding note per frame,
(b) mean-smooths it (a walking-bass root lands on the downbeat only, so a median would filter it
out), and (c) folds a share (`BASS_EMPHASIS`) into the chroma, so chords that omit the sounding
bass pay the outside penalty. This keeps slash/inversion handling intact while fixing rootless
voicings.

### Checking against jazz material

`jazzTracks.test.ts` synthesizes three real jazz-standard *progressions* (a chord progression
isn't copyrightable; the audio is generated fresh) as full arrangements — root-oriented bass +
rootless piano comping + a bebop melody: a 12-bar F blues, Rhythm-changes-style A section in Bb,
and a minor ii-V-i cycle in Gm. Observed: **~75–88% of bar roots correct**, and **100% label ↔
voicing consistency**. Honest limitations on this hard material: chord *qualities* are sometimes
reduced (a softly-comped 7th drops to a triad, e.g. `Bbmaj7` → `Bb`), and a fully *chromatic*
walking bass (as opposed to a root-emphasizing two-feel) stays ambiguous without beat-synchronous
analysis — the natural next step, since the bar grid already exists. Real commercial recordings
can't be bundled (copyright), but the app analyzes any file you drop in.

## Melody robustness

Real recordings put a lead melody on top of the harmony — non-chord passing tones that
pollute the chroma. Four counter-measures are implemented (gated by
`demoMelodyEval.test.ts`, which runs an adversarial clip — the same progression with a loud
eighth-note melody incl. chromatic passing tones — and requires 8/8 bars):

1. **Melody tracking + subtraction** (`melodyTrack.ts`) — the strong, *moving* top voice is
   linked frame-to-frame (jump-penalized continuity, Melodia-style heuristic) and its picks
   are excluded before chroma folding. The mobility gate is what protects held chord tones:
   a static top note (e.g. a sustained 7th) is treated as harmony, a moving line as melody.
2. **Stability smoothing** (`chordTrack.ts`) — per-pitch-class *median* over the smoothing
   window instead of a mean: a passing tone lighting a pitch class for 1–3 frames is crushed;
   sustained harmony survives.
3. **Stability-gated wildcard** (`chordMatch.ts`) — the loudest non-chord pitch class is
   partially forgiven in the outside-energy penalty, but only in proportion to its temporal
   *instability*. (An unconditional wildcard regresses: the plain-triad template happily
   "forgives" a real sustained 7th.)
4. **Center-cut analysis source** (`loadFile.ts`, "Chords from" selector) — analyses
   `(L−R)/2` instead of the mono mix: anything mixed dead center (typically the lead
   vocal/melody) cancels exactly, while panned accompaniment survives. Cheapest possible
   source separation; try it when the lead sits center.

### Heavier methods that directly extract/subtract the melody (not yet implemented)

- **Predominant-f0 tracking + harmonic subtraction** — track the melody's fundamental with
  [Melodia](https://www.upf.edu/web/mtg/melodia)-style salience, [pYIN](https://code.soundsoftware.ac.uk/projects/pyin),
  or [CREPE](https://github.com/marl/crepe) (deep, runs in ONNX/TF.js), then remove the
  melody as a sinusoidal model: subtract its partials (`f0`, `2f0`, `3f0`, …) from the
  spectrum before chord analysis. This is the rigorous version of `melodyTrack.ts` and slots
  in behind the same interface (frame picks in → excluded pitches out, or spectrum in →
  cleaned spectrum out).
- **HPSS** (harmonic–percussive source separation, Fitzgerald median-filtering) — cheap
  spectrogram-domain split that removes drums/transients; helps chroma on full mixes and is
  implementable in ~50 lines on the existing STFT.
- **REPET** ([REpeating Pattern Extraction Technique](https://interactiveaudiolab.github.io/resources/repet.html)) —
  separates the repeating background (harmony) from the non-repeating foreground (melody)
  by autocorrelating the spectrogram; well suited to loop-based/steady accompaniment.
- **DNN stem separation** — [Open-Unmix](https://github.com/sigsep/open-unmix-pytorch)
  (lighter) or [Demucs/HT-Demucs](https://github.com/facebookresearch/demucs) (better), run
  in the analysis worker via ONNX Runtime Web: feed the *accompaniment* stem to the chord
  engine and (bonus) the *vocals* stem to a melody transcriber. Gold standard, but a
  40–200 MB model download and seconds of inference — should be an opt-in "Deep analysis"
  mode rather than the default path.

## Out of scope (so far)

Video sync, CD reading, recording, automatic beat tracking (bar grid is manual tap/anchor by
design — the interface in `barGrid.ts` is ready for an automatic replacement), MusicXML/iReal
export, ML chord backend (the `chordMatch.ts` interface is the seam to swap in an ONNX model).
