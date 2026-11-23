/**
 * tonal.js — 调性：色度 → 调 → 和弦 → 旋律。
 *
 * 诚实规则（照抄样本里被现实教育出来的那几条）：
 *  - 调性给的是"最像的"两个候选和它们的差距，不是断言。差距小就直说分不清。
 *  - 和弦默认只报根音，性质（大三/小三/七）在混合音频里本来就不可靠；
 *    键内优先，键外候选要领先 0.06 才允许翻盘。
 *  - 旋律是**单声部 f0 估计**，不是"人声提取"。有和声/失真吉他/宽混响时它会跟错，
 *    所以输出里永远带 voicedFraction 和 octaveJumpRate，让读的人知道该不该信。
 */

import {
  cosine, mean, median, normalize, percentile, round, std,
} from './core.js';

const PC = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const pcName = (n) => PC[((n % 12) + 12) % 12];

export function midiToHz(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

export function hzToMidi(f) {
  return 69 + 12 * Math.log2(f / 440);
}

export function midiName(m) {
  const r = Math.round(m);
  return `${pcName(r)}${Math.floor(r / 12) - 1}`;
}

/**
 * Chroma from a magnitude STFT: triangular pitch-class folding between 55 Hz and 3 kHz,
 * magnitude (not power) weighted, then per-frame L1 normalisation.
 */
export function chromagram(frameMagnitudes, nfft, sr, { fmin = 90, fmax = 4000, frameHop = 256, power = 2 } = {}) {
  // Accept either an array of frames or a single magnitude spectrum (the latter is handy
  // for tests, and wrapping it here is cheaper than debugging NaN chroma later).
  const mags = typeof frameMagnitudes?.[0] === 'number' ? [frameMagnitudes] : frameMagnitudes;
  const bins = mags[0]?.length ?? 0;
  const lo = Math.max(1, Math.floor((fmin * nfft) / sr));
  const hi = Math.min(bins - 1, Math.ceil((fmax * nfft) / sr));
  const out = new Array(mags.length);
  for (let f = 0; f < mags.length; f++) {
    const c = new Float32Array(12);
    const mag = mags[f];
    for (let b = lo; b <= hi; b++) {
      const hz = (b * sr) / nfft;
      const midi = hzToMidi(hz);
      if (!Number.isFinite(midi)) continue;
      const lo1 = Math.floor(midi);
      const frac = midi - lo1;
      const a = ((lo1 % 12) + 12) % 12;
      const b1 = ((lo1 + 1) % 12 + 12) % 12;
      // Power domain, not magnitude: a 70x peak on the pad's bins still lost to the
      // 1400 noise bins above it when summed linearly (chroma came out flat at 0.08/pc).
      const w = power === 2 ? mag[b] * mag[b] : power === 1 ? mag[b] : Math.sqrt(mag[b]);
      c[a] += w * (1 - frac);
      c[b1] += w * frac;
    }
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += c[i];
    if (sum > 0) for (let i = 0; i < 12; i++) c[i] /= sum;
    out[f] = c;
  }
  return { frames: out, hop: frameHop, sr, secondsPerFrame: frameHop / sr };
}

/** Energy-weighted mean chroma over [start,end) seconds; frames below `floorRatio` of the max are ignored. */
export function meanChroma(chroma, start = 0, end = Infinity) {
  const { frames, secondsPerFrame } = chroma;
  const i0 = Math.max(0, Math.floor(start / secondsPerFrame));
  const i1 = Math.min(frames.length, Math.ceil(end / secondsPerFrame));
  const acc = new Float64Array(12);
  let n = 0;
  // Frame energy proxy: L1 of the chroma before normalisation is lost, so use variance instead.
  for (let i = i0; i < i1; i++) {
    const c = frames[i];
    let s = 0;
    for (let k = 0; k < 12; k++) s += c[k];
    if (s <= 0) continue;
    for (let k = 0; k < 12; k++) acc[k] += c[k];
    n++;
  }
  if (!n) return new Float32Array(12);
  const out = new Float32Array(12);
  for (let k = 0; k < 12; k++) out[k] = acc[k] / n;
  return out;
}

const KRUMHANSL_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KRUMHANSL_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function pearson(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return num / (Math.sqrt(da * db) || 1);
}

/** Krumhansl–Schmuckler key estimate over the whole (or a windowed) chroma. */
export function estimateKey(chroma, profileChroma = null) {
  const c = profileChroma ?? meanChroma(chroma);
  const total = c.reduce((a, b) => a + b, 0) || 1;
  const cn = Array.from(c, (v) => v / total);
  const flatness = (() => {
    const logs = cn.filter((v) => v > 1e-6).map((v) => Math.log(v));
    if (logs.length < 4) return 1;
    const geo = Math.exp(mean(logs));
    return geo / (mean(cn) || 1e-9);
  })();
  const candidates = [];
  for (let root = 0; root < 12; root++) {
    for (const [mode, prof] of [['major', KRUMHANSL_MAJOR], ['minor', KRUMHANSL_MINOR]]) {
      const rotated = [];
      for (let i = 0; i < 12; i++) rotated.push(prof[(i - root + 12) % 12]);
      candidates.push({ root, mode, score: pearson(cn, rotated) });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const second = candidates[1];
  // Gate on the template correlation, not on spectral flatness: a dense mix of many
  // instruments is spectrally flat yet perfectly tonal (the test progression reads
  // flatness 0.96 while its key template score is 0.73).
  const tonal = best.score >= 0.55;
  return {
    key: `${pcName(best.root)} ${best.mode}`,
    root: best.root,
    mode: best.mode,
    score: round(best.score, 3),
    runnerUp: `${pcName(second.root)} ${second.mode}`,
    margin: round(best.score - second.score, 3),
    // Two independent things can make a key estimate wrong: a weak template match
    // (score) and a neck-and-neck runner-up (margin). Reporting only the margin made a
    // mediocre 0.73 match read "1.00"; blending keeps 1.00 for a decisive, strong match.
    confidence: round(Math.max(0, Math.min(1, 0.5 * Math.max(0, best.score) + 0.5 * Math.min(1, (best.score - second.score) * 6))), 2),
    tonal,
    flatness: round(flatness, 3),
    noiseLike: flatness > 0.9,
    candidates: candidates.slice(0, 3).map((x) => ({ key: `${pcName(x.root)} ${x.mode}`, score: round(x.score, 3) })),
  };
}

/* ---- chords ---------------------------------------------------------------------- */

const QUALITIES = {
  maj: { intervals: [0, 4, 7], weights: [1.0, 0.9, 0.6], label: '' },
  min: { intervals: [0, 3, 7], weights: [1.0, 0.9, 0.6], label: 'm' },
  '7': { intervals: [0, 4, 7, 10], weights: [1.0, 0.85, 0.55, 0.45], label: '7' },
  m7: { intervals: [0, 3, 7, 10], weights: [1.0, 0.85, 0.55, 0.45], label: 'm7' },
  dim: { intervals: [0, 3, 6], weights: [1.0, 0.8, 0.6], label: 'dim' },
  sus4: { intervals: [0, 5, 7], weights: [1.0, 0.85, 0.6], label: 'sus4' },
};

/** Precomputed 12×6 chord templates with normalised weights, in the same 12-D space as chroma. */
export function chordTemplates() {
  const list = [];
  for (let root = 0; root < 12; root++) {
    for (const [quality, spec] of Object.entries(QUALITIES)) {
      const t = new Float32Array(12);
      spec.intervals.forEach((iv, i) => { t[(root + iv) % 12] = spec.weights[i]; });
      list.push({
        root,
        quality,
        label: pcName(root) + spec.label,
        tones: spec.intervals.map((iv) => (root + iv) % 12),
        vector: normalize(t),
        raw: t,
      });
    }
  }
  return list;
}

const DIATONIC_QUALITIES = {
  major: ['maj', 'min', 'min', 'maj', 'maj', 'min', 'dim'],
  minor: ['min', 'dim', 'maj', 'min', 'min', 'maj', 'maj'],
};

/** Best chord in the key's diatonic set, and the global best. */
const QUALITY_PRIOR = { sus4: 0.06, dim: 0.05, 7: 0.005, m7: 0.005 };

function scoreChords(c, templates, key) {
  // A small prior against sus4/dim: those templates explain any missing third, so in a
  // full mix they win by a hair precisely when the third is buried in noise. They must
  // beat a plain triad by more than this to be reported at all.
  const scored = templates.map((t) => ({ ...t, score: cosine(c, t.vector) - (QUALITY_PRIOR[t.quality] ?? 0) }));
  scored.sort((a, b) => b.score - a.score);
  let inKey = null;
  let keyRoots = null;
  if (key) {
    const scale = key.mode === 'major' ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10];
    keyRoots = new Set(scale.map((step) => (key.root + step) % 12));
    const qualities = DIATONIC_QUALITIES[key.mode];
    const allowed = new Set();
    scale.forEach((step, i) => {
      const root = (key.root + step) % 12;
      allowed.add(`${root}:${qualities[i]}`);
      // a 7th chord is an acceptable substitute for its diatonic triad
      allowed.add(`${root}:${qualities[i] === 'maj' ? '7' : 'm7'}`);
    });
    inKey = scored.find((t) => allowed.has(`${t.root}:${t.quality}`)) ?? null;
  }
  return { scored, best: scored[0], inKey, keyRoots };
}

/**
 * Beat- or grid-synchronous chord segmentation.
 * @returns {{segments: object[], keyCheck: object, rootsHistogram: object[]}}
 */
export function detectChords(chroma, { beats = null, segmentSeconds = 0.5, key = null, templates = chordTemplates() } = {}) {
  const { frames, secondsPerFrame } = chroma;
  const duration = frames.length * secondsPerFrame;
  // Boundaries: beat-synchronous when we have a beat grid, else a fixed grid.
  const bounds = [];
  if (beats && beats.length > 3) {
    bounds.push(0);
    for (const b of beats) if (b > bounds[bounds.length - 1] + 0.2) bounds.push(Math.min(b, duration));
    if (bounds[bounds.length - 1] < duration - 0.1) bounds.push(duration);
  } else {
    for (let t = 0; t < duration; t += segmentSeconds) bounds.push(t);
    if (bounds[bounds.length - 1] < duration) bounds.push(duration);
  }
  const raw = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i];
    const end = Math.min(bounds[i + 1], duration);
    if (end - start < 0.15) continue;
    const c = meanChroma(chroma, start, end);
    const norm = normalize(c);
    const { best, inKey, keyRoots } = scoreChords(norm, templates, key);
    // Key-aware fallback: an out-of-key chord must lead by 0.06 to displace the in-key one.
    let chosen = best;
    if (inKey && best.root !== inKey.root && best.score - inKey.score > 0.06) {
      chosen = best;
    } else if (inKey && best.root !== inKey.root) {
      chosen = inKey;
    }
    // A missing third is a timing accident (piano arpeggio) or a noise accident (mix).
    // When a plain triad with the same root is within 0.05, report the triad instead of sus4/dim.
    if (chosen.quality === 'sus4' || chosen.quality === 'dim') {
      const triad = scoreChords(norm, templates, key).scored.find(
        (s) => s.root === chosen.root && (s.quality === 'maj' || s.quality === 'min') && chosen.score - s.score <= 0.08,
      );
      if (triad) chosen = triad;
    }
    // "Out of key" is about the ROOT only: quality is unreliable in a mix, and calling a
    // diatonic root "outside" because it was read as sus4 would be a false claim.
    const outOfKey = keyRoots ? !keyRoots.has(chosen.root) : false;
    // Confidence by root: how much the winning ROOT beats the best different root.
    let bestOtherRoot = 0;
    for (const s of scoreChords(norm, templates, key).scored) {
      if (s.root !== chosen.root) { bestOtherRoot = s.score; break; }
    }
    const margin = chosen.score - bestOtherRoot;
    raw.push({
      start: round(start, 3),
      end: round(end, 3),
      root: chosen.root,
      quality: chosen.quality,
      label: chosen.label,
      score: round(chosen.score, 3),
      margin: round(margin, 3),
      outOfKey,
    });
  }
  // Median-of-3 root filter to remove single-segment flicker.
  const filtered = raw.map((seg, i) => {
    if (i === 0 || i === raw.length - 1) return seg;
    const a = raw[i - 1].root;
    const b = raw[i].root;
    const c = raw[i + 1].root;
    if (a === c && a !== b) {
      // Re-evaluate with the neighbours' templates; only adopt when the neighbour wins on score too.
      return raw[i - 1].score >= raw[i].score - 0.01 ? { ...raw[i - 1], start: seg.start, end: seg.end } : seg;
    }
    return seg;
  });
  // Merge identical consecutive labels.
  const merged = [];
  for (const seg of filtered) {
    const last = merged[merged.length - 1];
    if (last && last.label === seg.label && Math.abs(last.end - seg.start) < 1e-6) {
      last.end = seg.end;
      last.margin = Math.min(last.margin, seg.margin);
    } else {
      merged.push({ ...seg });
    }
  }
  const durations = new Map();
  for (const seg of merged) {
    const d = seg.end - seg.start;
    durations.set(seg.root, (durations.get(seg.root) ?? 0) + d);
  }
  const total = [...durations.values()].reduce((a, b) => a + b, 0) || 1;
  const rootsHistogram = [...durations.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([root, d]) => ({ root, name: pcName(root), share: round(d / total, 3) }));
  const avgMargin = mean(merged.map((s) => s.margin));
  return {
    segments: merged,
    rootsHistogram,
    chordCount: merged.length,
    avgMargin: round(avgMargin, 3),
    keyCheck: {
      agreesWithKey: key ? merged.filter((s) => !s.outOfKey).length / Math.max(1, merged.length) : null,
      outOfKeyShare: round(merged.filter((s) => s.outOfKey).length / Math.max(1, merged.length), 3),
    },
  };
}

/* ---- melody (YIN) --------------------------------------------------------------- */

/**
 * Monophonic f0 track. `voiced` is decided by the CMNDF dip, not by loudness alone.
 * Octave errors are folded toward the *local 1-second median*, never toward the previous
 * frame (that cascades: one wrong frame drags the rest of the phrase with it).
 */
export function melodyTrack(sig, sr, { fmin = 65, fmax = 1000, frame = 1024, hop = 256, threshold = 0.18 } = {}) {
  const tauMin = Math.max(2, Math.floor(sr / fmax));
  const tauMax = Math.min(frame - 2, Math.ceil(sr / fmin));
  const n = Math.max(0, Math.floor((sig.length - frame) / hop) + 1);
  const times = new Float32Array(n);
  const f0 = new Float32Array(n);
  const clarity = new Float32Array(n);
  const energy = new Float32Array(n);
  const w = frame;
  for (let f = 0; f < n; f++) {
    const off = f * hop;
    let e = 0;
    for (let i = 0; i < w; i++) e += sig[off + i] * sig[off + i];
    energy[f] = Math.sqrt(e / w);
    times[f] = (off + w / 2) / sr;
    // difference function
    const d = new Float32Array(tauMax + 1);
    for (let tau = tauMin; tau <= tauMax; tau++) {
      let s = 0;
      for (let i = 0; i < w - tauMax; i++) {
        const diff = sig[off + i] - sig[off + i + tau];
        s += diff * diff;
      }
      d[tau] = s;
    }
    // cumulative mean normalised difference
    let running = 0;
    const cmnd = new Float32Array(tauMax + 1);
    cmnd[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) {
      running += d[tau];
      cmnd[tau] = running > 0 ? (d[tau] * tau) / running : 1;
    }
    let bestTau = -1;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (cmnd[tau] < threshold) {
        // walk to the bottom of this dip
        let t = tau;
        while (t + 1 <= tauMax && cmnd[t + 1] < cmnd[t]) t++;
        bestTau = t;
        break;
      }
    }
    if (bestTau < 0) {
      // Fall back only when there is a clear global minimum; otherwise call it unvoiced.
      let minTau = tauMin;
      for (let tau = tauMin + 1; tau <= tauMax; tau++) if (cmnd[tau] < cmnd[minTau]) minTau = tau;
      if (cmnd[minTau] < 0.35) bestTau = minTau;
    }
    if (bestTau < 0) { f0[f] = 0; clarity[f] = 0; continue; }
    const a = cmnd[bestTau - 1] ?? cmnd[bestTau];
    const b = cmnd[bestTau];
    const c = cmnd[bestTau + 1] ?? cmnd[bestTau];
    const denom = a - 2 * b + c;
    const sub = Math.abs(denom) > 1e-12 ? (0.5 * (a - c)) / denom : 0;
    const tau = bestTau + (Math.abs(sub) <= 0.5 ? sub : 0);
    f0[f] = sr / tau;
    clarity[f] = 1 - b;
  }
  // Voiced decision.
  const eSorted = Float32Array.from(energy).sort();
  const eRef = percentile(eSorted, 0.9);
  const voiced = new Uint8Array(n);
  for (let f = 0; f < n; f++) voiced[f] = f0[f] > 0 && clarity[f] > 0.78 && energy[f] > eRef * 0.05 ? 1 : 0;
  // Octave fold toward local median (1 s).
  const med = [];
  for (let f = 0; f < n; f++) {
    if (!voiced[f]) { med.push(0); continue; }
    const t = times[f];
    const vals = [];
    for (let k = 0; k < n; k++) {
      if (voiced[k] && Math.abs(times[k] - t) <= 0.5) vals.push(f0[k]);
    }
    med.push(median(vals));
  }
  let octaveJumps = 0;
  let prev = 0;
  for (let f = 0; f < n; f++) {
    if (!voiced[f]) continue;
    const target = med[f];
    let v = f0[f];
    if (target > 0) {
      for (let guard = 0; guard < 2; guard++) {
        if (v / target > 1.7) v /= 2;
        else if (target / v > 1.7) v *= 2;
        else break;
      }
    }
    f0[f] = v;
    if (prev > 0 && Math.abs(Math.log2(v / prev)) > 0.85) octaveJumps++;
    prev = v;
  }
  const voicedCount = voiced.reduce((a, b) => a + b, 0);
  const midis = [];
  for (let f = 0; f < n; f++) if (voiced[f]) midis.push(hzToMidi(f0[f]));
  const lo = percentile(midis, 0.05);
  const hi = percentile(midis, 0.95);
  // Contour at 0.5 s resolution: median of voiced frames in each window.
  const contour = [];
  if (n) {
    const step = Math.max(1, Math.round(0.5 / (hop / sr)));
    for (let f = 0; f < n; f += step) {
      const vals = [];
      for (let k = f; k < Math.min(n, f + step); k++) if (voiced[k]) vals.push(f0[k]);
      if (vals.length >= 2) {
        const m = median(vals);
        contour.push({ t: round(times[f], 2), hz: round(m, 1), note: midiName(hzToMidi(m)) });
      }
    }
  }
  return {
    frames: n,
    times,
    f0,
    clarity,
    energy,
    voiced,
    voicedFraction: n ? round(voicedCount / n, 3) : 0,
    octaveJumps,
    octaveJumpRate: voicedCount > 0 ? round(octaveJumps / voicedCount, 3) : 0,
    rangeLow: midis.length >= 8 ? round(lo, 2) : null,
    rangeHigh: midis.length >= 8 ? round(hi, 2) : null,
    rangeName: midis.length >= 8 ? `${midiName(lo)}–${midiName(hi)}` : null,
    medianHz: midis.length ? round(midiToHz(median(midis)), 1) : null,
    medianNote: midis.length ? midiName(median(midis)) : null,
    contour,
    durationSeconds: round(n * hop / sr, 2),
  };
}
