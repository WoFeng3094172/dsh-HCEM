/**
 * core.js — 数值地基：基-2 FFT、STFT、mel 滤波器组，以及一批不给就到处重写的小工具。
 *
 * 这里没有任何插件的知识，只有"一段 float32 采样能算出什么"。
 * 上层（rhy / tonal / structure）只允许依赖本文件，不允许互相偷用内部数组 ——
 * 之前样本里出现过"节奏模块自己再做一遍 STFT、参数和音高模块不一致"的事故。
 */

/** In-place iterative radix-2 FFT. `re`/`im` must have length 2^k. */
export function fft(re, im, inverse = false) {
  const n = re.length;
  if (n <= 1) return;
  if ((n & (n - 1)) !== 0) throw new RangeError(`fft length must be a power of two, got ${n}`);
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
  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sign * 2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const ar = re[i + k];
        const ai = im[i + k];
        const br = re[i + k + half] * cr - im[i + k + half] * ci;
        const bi = re[i + k + half] * ci + im[i + k + half] * cr;
        re[i + k] = ar + br;
        im[i + k] = ai + bi;
        re[i + k + half] = ar - br;
        im[i + k + half] = ai - bi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

/** Periodic Hann window (DFT-even), length n. */
export function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/** Dolph-Chebyshev-ish "sqrt-Hann" window: better sidelobes for onset flux. */
export function sqrtHann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  return w;
}

/**
 * Magnitude STFT. Returns { mags: Float32Array[], frames, nfft, hop, sr }.
 * Frames are centered: frame k covers [k*hop - nfft/2, k*hop + nfft/2), zero-padded outside,
 * so frame k's time is exactly k*hop/sr (no half-frame offset trap).
 */
export function stft(x, sr, { nfft = 2048, hop = 256, window = 'hann', maxFrames = Infinity } = {}) {
  const win = window === 'sqrt' ? sqrtHann(nfft) : hann(nfft);
  const bins = nfft >> 1;
  const frames = Math.min(maxFrames, Math.max(1, 1 + Math.floor(x.length / hop)));
  const mags = new Array(frames);
  const re = new Float32Array(nfft);
  const im = new Float32Array(nfft);
  const half = nfft >> 1;
  for (let f = 0; f < frames; f++) {
    const start = f * hop - half;
    for (let i = 0; i < nfft; i++) {
      const s = start + i;
      re[i] = s >= 0 && s < x.length ? x[s] * win[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    const mag = new Float32Array(bins);
    for (let b = 0; b < bins; b++) mag[b] = Math.hypot(re[b], im[b]);
    mags[f] = mag;
  }
  return { mags, frames, nfft, hop, sr, bins };
}

/** Power spectra (magnitude squared) of a decoded signal, cached per call site. */
export function power(mags) {
  const out = new Float32Array(mags.length);
  for (let i = 0; i < mags.length; i++) out[i] = mags[i] * mags[i];
  return out;
}

/**
 * HTK-style triangular mel filterbank weights, one Float32Array per filter over FFT bins.
 * Cached in a module-level Map keyed by every parameter that changes the shape.
 */
const MEL_CACHE = new Map();
export function melFilterbank(sr, nfft, nMels = 40, fmin = 30, fmax = null) {
  const top = Math.min(fmax ?? sr / 2, sr / 2) * 0.999;
  const key = `${sr}|${nfft}|${nMels}|${fmin.toFixed(2)}|${top.toFixed(2)}`;
  const hit = MEL_CACHE.get(key);
  if (hit) return hit;
  const hzToMel = (f) => 2595 * Math.log10(1 + f / 700);
  const melToHz = (m) => 700 * (Math.pow(10, m / 2595) - 1);
  const m0 = hzToMel(fmin);
  const m1 = hzToMel(top);
  const points = [];
  for (let i = 0; i < nMels + 2; i++) points.push(melToHz(m0 + ((m1 - m0) * i) / (nMels + 1)));
  const binOf = (f) => (f * nfft) / sr;
  const filters = [];
  for (let i = 0; i < nMels; i++) {
    const lo = points[i];
    const mid = points[i + 1];
    const hi = points[i + 2];
    const w = new Float32Array(nfft >> 1);
    for (let b = (nfft >> 1) - 1; b >= 0; b--) {
      const f = (b * sr) / nfft;
      let v = 0;
      if (f >= lo && f <= mid) v = (f - lo) / Math.max(mid - lo, 1e-9);
      else if (f > mid && f <= hi) v = (hi - f) / Math.max(hi - mid, 1e-9);
      if (v > 0) w[b] = v;
    }
    filters.push(w);
  }
  // Reference frequencies for log-mel band -> Hz (filter centroid), used by the chroma mapper.
  filters.reference = { sr, nfft, nMels, fmin, fmax: top, binOf };
  MEL_CACHE.set(key, filters);
  return filters;
}

/** Apply a mel filterbank to one magnitude spectrum (power domain). */
export function melEnergies(mag, filters) {
  const out = new Float32Array(filters.length);
  for (let i = 0; i < filters.length; i++) {
    const w = filters[i];
    let s = 0;
    for (let b = 0; b < w.length; b++) if (w[b] !== 0) s += w[b] * mag[b] * mag[b];
    out[i] = s;
  }
  return out;
}

/** DCT-II (orthonormal) of the first `keep` coefficients of `values`. */
export function dct(values, keep = 13) {
  const n = values.length;
  const out = new Float32Array(Math.min(keep, n));
  const scale = Math.PI / n;
  for (let k = 0; k < out.length; k++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += values[i] * Math.cos(scale * k * (i + 0.5));
    out[k] = s * Math.sqrt((k === 0 ? 1 : 2) / n);
  }
  return out;
}

/** Root-mean-square of a slice. */
export function rms(x, start = 0, end = x.length) {
  let s = 0;
  const n = Math.max(1, end - start);
  for (let i = start; i < end; i++) s += x[i] * x[i];
  return Math.sqrt(s / n);
}

/** Peak absolute value of a slice. */
export function peak(x, start = 0, end = x.length) {
  let p = 0;
  for (let i = start; i < end; i++) { const v = Math.abs(x[i]); if (v > p) p = v; }
  return p;
}

export function dB(v, floor = -120) {
  return v <= 0 ? floor : Math.max(floor, 20 * Math.log10(v));
}

/** Median of a numeric array (sorts a copy). */
export function median(values) {
  if (!values.length) return 0;
  const a = Float64Array.from(values).sort();
  const n = a.length;
  return n % 2 ? a[(n - 1) >> 1] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

/** Percentile (0..1) with linear interpolation, on a copy. */
export function percentile(values, q) {
  if (!values.length) return 0;
  const a = Float64Array.from(values).sort();
  const pos = (a.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

export function mean(values) {
  if (!values.length) return 0;
  let s = 0;
  for (let i = 0; i < values.length; i++) s += values[i];
  return s / values.length;
}

export function std(values) {
  if (!values.length) return 0;
  const m = mean(values);
  let s = 0;
  for (let i = 0; i < values.length; i++) { const d = values[i] - m; s += d * d; }
  return Math.sqrt(s / values.length);
}

/** Centered moving average with a half-width in frames (moving average window = 2*half+1). */
export function movingAverage(x, half) {
  const n = x.length;
  const out = new Float32Array(n);
  if (half <= 0) { out.set(x); return out; }
  let acc = 0;
  let count = 0;
  const win = 2 * half + 1;
  for (let i = 0; i < n + half; i++) {
    if (i < n) { acc += x[i]; count++; }
    const drop = i - win;
    if (drop >= 0) { acc -= x[drop]; count--; }
    const c = i - half;
    if (c >= 0) out[c] = acc / Math.max(1, count);
  }
  return out;
}

/** Median filter with a half-width in frames; boundaries clamp. */
export function medianFilter(x, half) {
  if (half <= 0) return Float32Array.from(x);
  const n = x.length;
  const out = new Float32Array(n);
  const buf = [];
  for (let i = 0; i < n; i++) {
    buf.length = 0;
    const a = Math.max(0, i - half);
    const b = Math.min(n - 1, i + half);
    for (let j = a; j <= b; j++) buf.push(x[j]);
    out[i] = median(buf);
  }
  return out;
}

/** Zero-mean unit-L2 normalization (returns a new Float32Array). */
export function normalize(x) {
  const n = x.length;
  const out = new Float32Array(n);
  let m = 0;
  for (let i = 0; i < n; i++) m += x[i];
  m /= Math.max(1, n);
  let s = 0;
  for (let i = 0; i < n; i++) { const d = x[i] - m; out[i] = d; s += d * d; }
  const norm = Math.sqrt(s) || 1;
  for (let i = 0; i < n; i++) out[i] /= norm;
  return out;
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na * nb) || 1);
}

/** Parabolic interpolation of a local maximum: returns the refined offset in frames (-0.5..0.5). */
export function parabolicOffset(prev, cur, next) {
  const denom = prev - 2 * cur + next;
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-12) return 0;
  const d = (0.5 * (prev - next)) / denom;
  return Math.abs(d) <= 0.5 ? d : 0;
}

/** Local maxima above `threshold`, at least `minDistance` frames apart, strongest first. */
export function peaks(x, { threshold = 0, minDistance = 1, maxCount = Infinity } = {}) {
  const cand = [];
  for (let i = 1; i < x.length - 1; i++) {
    if (x[i] > threshold && x[i] >= x[i - 1] && x[i] > x[i + 1]) cand.push(i);
  }
  cand.sort((a, b) => x[b] - x[a]);
  const picked = [];
  for (const i of cand) {
    if (picked.length >= maxCount) break;
    if (picked.every((j) => Math.abs(j - i) >= minDistance)) picked.push(i);
  }
  picked.sort((a, b) => a - b);
  return picked;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const round = (v, digits = 2) => {
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
};

/* ---- filters -------------------------------------------------------------------- */

/**
 * Second-order (RBJ) high-pass, transposed direct form II. Used to keep kick drums and
 * rumble out of the tonal stage: on the test mix the kick sweeping 48→168 Hz owned the
 * loudest bins, and the chroma followed it into nonsense (C, B, C# for a C major chord).
 */
export function highpass(x, sr, { fc = 80, q = 0.7071 } = {}) {
  const w0 = (2 * Math.PI * fc) / sr;
  const alpha = Math.sin(w0) / (2 * q);
  const cosw = Math.cos(w0);
  const a0 = 1 + alpha;
  const b0 = (1 + cosw) / 2 / a0;
  const b1 = -(1 + cosw) / a0;
  const b2 = b0;
  const a1 = (-2 * cosw) / a0;
  const a2 = (1 - alpha) / a0;
  const out = new Float32Array(x.length);
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + z1;
    z1 = b1 * x[i] - a1 * v + z2;
    z2 = b2 * x[i] - a2 * v;
    out[i] = v;
  }
  return out;
}

/** Second-order (RBJ) low-pass, same form as `highpass`. */
export function lowpass(x, sr, { fc = 4000, q = 0.7071 } = {}) {
  const w0 = (2 * Math.PI * fc) / sr;
  const alpha = Math.sin(w0) / (2 * q);
  const cosw = Math.cos(w0);
  const a0 = 1 + alpha;
  const b0 = ((1 - cosw) / 2) / a0;
  const b1 = (1 - cosw) / a0;
  const b2 = b0;
  const a1 = (-2 * cosw) / a0;
  const a2 = (1 - alpha) / a0;
  const out = new Float32Array(x.length);
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + z1;
    z1 = b1 * x[i] - a1 * v + z2;
    z2 = b2 * x[i] - a2 * v;
    out[i] = v;
  }
  return out;
}

/**
 * Harmonic/percussive split by median filtering along time, per frequency bin
 * (Fitzgerald 2010). Sustained notes survive; kick/snare/hat transients do not, which is
 * exactly what the tonal stage needs before folding to chroma.
 */
export function harmonicMags(mags, { kernelFrames = 17 } = {}) {
  const frames = mags.length;
  const bins = mags[0]?.length ?? 0;
  const half = Math.max(1, Math.floor(kernelFrames / 2));
  const out = new Array(frames);
  for (let f = 0; f < frames; f++) out[f] = new Float32Array(bins);
  const col = new Float32Array(frames);
  const win = new Float32Array(half * 2 + 1);
  for (let b = 0; b < bins; b++) {
    for (let f = 0; f < frames; f++) col[f] = mags[f][b];
    for (let f = 0; f < frames; f++) {
      let n = 0;
      for (let k = f - half; k <= f + half; k++) {
        const i = k < 0 ? 0 : k >= frames ? frames - 1 : k;
        win[n++] = col[i];
      }
      // insertion sort of the small window (n <= 33), then take the middle
      for (let i = 1; i < n; i++) {
        const v = win[i];
        let j = i - 1;
        while (j >= 0 && win[j] > v) { win[j + 1] = win[j]; j--; }
        win[j + 1] = v;
      }
      out[f][b] = win[n >> 1];
    }
  }
  return out;
}
