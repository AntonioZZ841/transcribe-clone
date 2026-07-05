// Minimal iterative radix-2 real-input FFT returning magnitude spectrum.
// Small and dependency-free; fast enough for offline analysis in a worker
// and occasional live frames.

const hannCache = new Map<number, Float32Array>();

export function hannWindow(size: number): Float32Array {
  let w = hannCache.get(size);
  if (!w) {
    w = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
    }
    hannCache.set(size, w);
  }
  return w;
}

/**
 * In-place complex FFT (interleaved re/im is avoided; separate arrays).
 * size must be a power of two.
 */
function fftComplex(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  // bit reversal
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/**
 * Magnitude spectrum of a (windowed) real frame.
 * Returns size/2 magnitudes; bin k is frequency k * sampleRate / size.
 */
export function magnitudeSpectrum(frame: Float32Array, applyHann = true): Float32Array {
  const n = frame.length;
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  if (applyHann) {
    const w = hannWindow(n);
    for (let i = 0; i < n; i++) re[i] = frame[i] * w[i];
  } else {
    re.set(frame);
  }
  fftComplex(re, im);
  const mags = new Float32Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    mags[k] = Math.hypot(re[k], im[k]);
  }
  return mags;
}

export const binToFreq = (bin: number, sampleRate: number, fftSize: number): number =>
  (bin * sampleRate) / fftSize;

export const freqToBin = (freq: number, sampleRate: number, fftSize: number): number =>
  (freq * fftSize) / sampleRate;
