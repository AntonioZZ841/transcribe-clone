// Audio engine: signalsmith-stretch worklet (speed/pitch/loop) -> mix matrix
// (stereo/mono/left/right/karaoke) -> 3-band EQ -> analyser -> output.
// The engine is a singleton; React reads/writes it via the store's actions.

import SignalsmithStretch from 'signalsmith-stretch';

export type MixMode = 'stereo' | 'mono' | 'left' | 'right' | 'karaoke';

// The stretch node is an AudioWorkletNode with extra methods (see package README).
interface StretchNode extends AudioNode {
  inputTime: number;
  schedule(opts: Partial<{
    output: number;
    active: boolean;
    input: number;
    rate: number;
    semitones: number;
    loopStart: number;
    loopEnd: number;
  }>): void;
  start(when?: number): void;
  stop(when?: number): void;
  addBuffers(buffers: Float32Array[]): Promise<number>;
  dropBuffers(toSeconds?: number): void;
  setUpdateInterval(seconds: number, callback?: () => void): void;
  latency(): number;
}

export interface EngineEvents {
  onPlayhead?: (sec: number) => void;
  onEnded?: () => void;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private stretch: StretchNode | null = null;

  // mix matrix
  private splitter: ChannelSplitterNode | null = null;
  private merger: ChannelMergerNode | null = null;
  private gLL: GainNode | null = null;
  private gLR: GainNode | null = null;
  private gRL: GainNode | null = null;
  private gRR: GainNode | null = null;

  private eqLow: BiquadFilterNode | null = null;
  private eqMid: BiquadFilterNode | null = null;
  private eqHigh: BiquadFilterNode | null = null;
  analyser: AnalyserNode | null = null;

  buffer: AudioBuffer | null = null;
  duration = 0;

  private _playing = false;
  private _playhead = 0;
  private _rate = 1;
  private _semitones = 0;
  private _loop: { a: number; b: number } | null = null;

  events: EngineEvents = {};

  get isPlaying(): boolean {
    return this._playing;
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 44100;
  }

  /** Smooth playhead estimate (worklet reports ~20 Hz; interpolate between). */
  private lastReportSec = 0;
  private lastReportCtxTime = 0;

  getPlayhead(): number {
    if (!this._playing || !this.ctx) return this._playhead;
    const elapsed = this.ctx.currentTime - this.lastReportCtxTime;
    let est = this.lastReportSec + elapsed * this._rate;
    if (this._loop && est > this._loop.b) {
      est = this._loop.a + ((est - this._loop.a) % Math.max(0.01, this._loop.b - this._loop.a));
    }
    return Math.min(est, this.duration);
  }

  private async ensureContext(): Promise<void> {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    const stretch = (await SignalsmithStretch(this.ctx)) as StretchNode;
    this.stretch = stretch;

    // mix matrix
    this.splitter = this.ctx.createChannelSplitter(2);
    this.merger = this.ctx.createChannelMerger(2);
    this.gLL = this.ctx.createGain();
    this.gLR = this.ctx.createGain();
    this.gRL = this.ctx.createGain();
    this.gRR = this.ctx.createGain();
    stretch.connect(this.splitter);
    this.splitter.connect(this.gLL, 0);
    this.splitter.connect(this.gRL, 0);
    this.splitter.connect(this.gLR, 1);
    this.splitter.connect(this.gRR, 1);
    this.gLL.connect(this.merger, 0, 0);
    this.gLR.connect(this.merger, 0, 0);
    this.gRL.connect(this.merger, 0, 1);
    this.gRR.connect(this.merger, 0, 1);

    // EQ chain
    this.eqLow = this.ctx.createBiquadFilter();
    this.eqLow.type = 'lowshelf';
    this.eqLow.frequency.value = 200;
    this.eqMid = this.ctx.createBiquadFilter();
    this.eqMid.type = 'peaking';
    this.eqMid.frequency.value = 1000;
    this.eqMid.Q.value = 0.8;
    this.eqHigh = this.ctx.createBiquadFilter();
    this.eqHigh.type = 'highshelf';
    this.eqHigh.frequency.value = 4000;

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 8192;
    this.analyser.smoothingTimeConstant = 0.6;

    this.merger
      .connect(this.eqLow)
      .connect(this.eqMid)
      .connect(this.eqHigh)
      .connect(this.analyser)
      .connect(this.ctx.destination);

    this.setMixMode('stereo');

    stretch.setUpdateInterval(0.05, () => {
      // while paused the worklet keeps reporting its last input position —
      // ignore it, or it would overwrite seeks made while paused
      if (!this._playing) return;
      const t = stretch.inputTime;
      this.lastReportSec = t;
      this.lastReportCtxTime = this.ctx!.currentTime;
      this._playhead = t;
      this.events.onPlayhead?.(t);
      if (!this._loop && t >= this.duration - 0.05) {
        this.pause();
        this.events.onEnded?.();
      }
    });
  }

  async load(buffer: AudioBuffer): Promise<void> {
    await this.ensureContext();
    const stretch = this.stretch!;
    this.pause();
    stretch.dropBuffers();
    this.buffer = buffer;
    this.duration = buffer.duration;
    this._playhead = 0;
    this.lastReportSec = 0;

    const chans: Float32Array[] = [];
    const n = Math.min(2, buffer.numberOfChannels);
    for (let c = 0; c < n; c++) chans.push(buffer.getChannelData(c));
    if (chans.length === 1) chans.push(chans[0]); // mono -> both ears
    await stretch.addBuffers(chans);
    this.scheduleState(false, 0);
  }

  private scheduleState(active: boolean, input?: number): void {
    if (!this.stretch) return;
    this.stretch.schedule({
      active,
      ...(input !== undefined ? { input } : {}),
      rate: this._rate,
      semitones: this._semitones,
      loopStart: this._loop?.a ?? 0,
      loopEnd: this._loop?.b ?? 0,
    });
  }

  async play(): Promise<void> {
    if (!this.ctx || !this.stretch || !this.buffer) return;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    let from = this._playhead;
    if (this._loop && (from < this._loop.a || from >= this._loop.b)) from = this._loop.a;
    if (!this._loop && from >= this.duration - 0.05) from = 0;
    this.lastReportSec = from;
    this.lastReportCtxTime = this.ctx.currentTime;
    this._playing = true;
    this.scheduleState(true, from);
  }

  pause(): void {
    if (!this.stretch) return;
    this._playhead = this.getPlayhead();
    this._playing = false;
    this.scheduleState(false);
  }

  seek(sec: number): void {
    const t = Math.max(0, Math.min(this.duration, sec));
    this._playhead = t;
    this.lastReportSec = t;
    this.lastReportCtxTime = this.ctx?.currentTime ?? 0;
    // schedule the input position even while paused, so the worklet's own
    // position matches the UI when playback resumes
    this.scheduleState(this._playing, t);
    this.events.onPlayhead?.(t);
  }

  setRate(rate: number): void {
    this._rate = rate;
    if (this._playing) {
      // re-anchor interpolation before the rate change takes effect
      this.lastReportSec = this.getPlayhead();
      this.lastReportCtxTime = this.ctx?.currentTime ?? 0;
    }
    this.scheduleState(this._playing);
  }

  /** Combined pitch: integer transpose + cents fine tune. */
  setPitch(semitones: number, cents: number): void {
    this._semitones = semitones + cents / 100;
    this.scheduleState(this._playing);
  }

  setLoop(a: number | null, b: number | null): void {
    this._loop = a !== null && b !== null && b > a ? { a, b } : null;
    this.scheduleState(this._playing);
  }

  setEq(lowDb: number, midDb: number, highDb: number): void {
    if (!this.eqLow || !this.eqMid || !this.eqHigh) return;
    this.eqLow.gain.value = lowDb;
    this.eqMid.gain.value = midDb;
    this.eqHigh.gain.value = highDb;
  }

  setMixMode(mode: MixMode): void {
    if (!this.gLL || !this.gLR || !this.gRL || !this.gRR) return;
    const M: Record<MixMode, [number, number, number, number]> = {
      // [LL, LR, RL, RR] — out_L = LL*L + LR*R ; out_R = RL*L + RR*R
      stereo: [1, 0, 0, 1],
      mono: [0.5, 0.5, 0.5, 0.5],
      left: [1, 0, 1, 0],
      right: [0, 1, 0, 1],
      karaoke: [0.7, -0.7, -0.7, 0.7],
    };
    const [ll, lr, rl, rr] = M[mode];
    this.gLL.gain.value = ll;
    this.gLR.gain.value = lr;
    this.gRL.gain.value = rl;
    this.gRR.gain.value = rr;
  }

  /** Linear magnitude spectrum from the live analyser (post-EQ). */
  getLiveSpectrum(): { mags: Float32Array; fftSize: number } | null {
    if (!this.analyser) return null;
    const bins = this.analyser.frequencyBinCount;
    const db = new Float32Array(bins);
    this.analyser.getFloatFrequencyData(db);
    const mags = new Float32Array(bins);
    for (let i = 0; i < bins; i++) {
      mags[i] = db[i] <= -180 ? 0 : Math.pow(10, db[i] / 20);
    }
    return { mags, fftSize: this.analyser.fftSize };
  }

  /** Short reference beep for the on-screen piano. */
  playReferenceNote(midi: number): void {
    if (!this.ctx) return;
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.25, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.8);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.85);
  }
}

export const engine = new AudioEngine();
