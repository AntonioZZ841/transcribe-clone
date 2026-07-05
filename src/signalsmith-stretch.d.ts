declare module 'signalsmith-stretch' {
  /**
   * Creates the Signalsmith Stretch AudioWorklet node.
   * Returns an AudioNode with extra scheduling/buffer methods attached
   * (typed in src/audio/engine.ts as StretchNode).
   */
  export default function SignalsmithStretch(
    context: AudioContext,
    channelOptions?: Record<string, unknown>,
  ): Promise<AudioNode>;
}
