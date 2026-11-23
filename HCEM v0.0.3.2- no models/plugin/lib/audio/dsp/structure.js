/**
 * structure.js — 段落：把"这首歌是不是前奏-主歌-副歌"变成一个可以反驳的判断。
 *
 * 做法是老实的经典做法：拍同步色度 → 自相似矩阵 → 棋盘核 novelty → 边界。
 * 所有阈值都随结果一起打印，因为"切在 41.2s"这种断言必须让人能自己复核。
 */

import { cosine, mean, percentile, round, std } from './core.js';

/** Beat-synchronous chroma: one vector per beat, spanning [beat[i], beat[i+1]). */
export function beatSyncChroma(chroma, beats) {
  const { frames, secondsPerFrame } = chroma;
  if (!beats || beats.length < 4) {
    // Fall back to a 1-second grid so short clips still produce something.
    const grid = [];
    for (let t = 0; t < frames.length * secondsPerFrame; t += 1) grid.push(t);
    beats = grid.length > 2 ? grid : [0];
  }
  const out = [];
  for (let i = 0; i < beats.length - 1; i++) {
    const start = beats[i];
    const end = beats[i + 1];
    const i0 = Math.max(0, Math.floor(start / secondsPerFrame));
    const i1 = Math.min(frames.length, Math.max(i0 + 1, Math.ceil(end / secondsPerFrame)));
    const acc = new Float64Array(12);
    for (let f = i0; f < i1; f++) for (let k = 0; k < 12; k++) acc[k] += frames[f][k];
    let sum = 0;
    for (let k = 0; k < 12; k++) sum += acc[k];
    const v = new Float32Array(12);
    if (sum > 0) for (let k = 0; k < 12; k++) v[k] = acc[k] / sum;
    out.push({ start, end, vector: v });
  }
  return out;
}

/** Cosine self-similarity matrix, values in [0,1]. */
export function selfSimilarity(vectors) {
  const n = vectors.length;
  const rows = new Array(n);
  for (let i = 0; i < n; i++) {
    const row = new Float32Array(n);
    for (let j = 0; j < n; j++) {
      if (i === j) row[j] = 1;
      else row[j] = Math.max(0, cosine(vectors[i], vectors[j]));
    }
    rows[i] = row;
  }
  return rows;
}

/**
 * Checkerboard-kernel novelty (Foote). High where the local statistics change —
 * i.e. a section boundary. Gaussian weighting keeps the far corners from dominating.
 */
export function noveltyCurve(ssm, kernelBeats = 8) {
  const n = ssm.length;
  const half = Math.max(2, Math.round(kernelBeats / 2));
  const kernel = [];
  let ksum = 0;
  for (let i = -half; i <= half; i++) {
    for (let j = -half; j <= half; j++) {
      const g = Math.exp(-((i * i + j * j) / (2 * Math.pow(half / 1.5, 2))));
      const v = Math.sign(i) * Math.sign(j) * g;
      kernel.push([i, j, v]);
      ksum += Math.abs(v);
    }
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const [di, dj, v] of kernel) {
      const a = i + di;
      const b = i + dj;
      if (a < 0 || b < 0 || a >= n || b >= n) continue;
      s += v * ssm[a][b];
    }
    out[i] = s / (ksum || 1);
  }
  // Normalise to a usable 0..1 range but keep the raw values for reporting.
  const raw = Float32Array.from(out);
  const mx = Math.max(...out, 1e-9);
  for (let i = 0; i < n; i++) out[i] = Math.max(0, out[i]) / mx;
  return { novelty: out, raw };
}

/**
 * Boundaries = local maxima above mean + k·std, at least `minBeats` apart.
 * Returns beats plus the strength that made each one a boundary (for the report).
 */
export function detectSections(novelty, beats, { sigma = 1.0, minBeats = 8 } = {}) {
  const n = novelty.length;
  const vals = Array.from(novelty);
  const mu = mean(vals);
  const sd = std(vals);
  const threshold = mu + sigma * sd;
  const picks = [];
  for (let i = 2; i < n - 2; i++) {
    if (novelty[i] < threshold) continue;
    if (novelty[i] < novelty[i - 1] || novelty[i] < novelty[i + 1]) continue;
    if (picks.length && i - picks[picks.length - 1] < minBeats) {
      if (novelty[i] > novelty[picks[picks.length - 1]]) picks[picks.length - 1] = i;
      continue;
    }
    picks.push(i);
  }
  const boundaries = picks.map((i) => ({
    beat: i,
    time: quanter(beats[Math.min(i, beats.length - 1)] ?? i),
    strength: round(novelty[i], 3),
  }));
  return { boundaries, threshold: round(threshold, 3), mean: round(mu, 3), std: round(sd, 3) };
}

const quanter = (t) => round(t, 2);

/**
 * Label sections by comparing mean chroma to every earlier section.
 * A section that matches an earlier one inherits its letter (A → A or A'), which is
 * enough to say "副歌回来了" without pretending to know verse from chorus.
 */
export function labelSections(sections) {
  const reps = [];
  const out = [];
  for (const sec of sections) {
    const v = sec.vector;
    let bestIdx = -1;
    let best = 0;
    for (let i = 0; i < reps.length; i++) {
      const s = cosine(v, reps[i].vector);
      if (s > best) { best = s; bestIdx = i; }
    }
    if (bestIdx >= 0 && best >= 0.86) {
      const base = reps[bestIdx].label;
      const count = reps[bestIdx].uses + 1;
      reps[bestIdx].uses = count;
      const label = count === 1 ? `${base}'` : `${base}${count}`;
      out.push({ ...sec, label, similarityToEarlier: round(best, 3) });
    } else {
      reps.push({ vector: v, label: sectionLetter(reps.length), uses: 0 });
      out.push({ ...sec, label: sectionLetter(reps.length - 1), similarityToEarlier: round(best, 3) });
    }
  }
  return out;
}

const sectionLetter = (i) => String.fromCharCode(65 + (i % 26)) + (i >= 26 ? String(Math.floor(i / 26)) : '');

/** Mean chroma vector of a beat range, for section comparison. */
export function meanVector(beatChroma, fromIdx, toIdx) {
  const acc = new Float64Array(12);
  let n = 0;
  for (let i = fromIdx; i < toIdx && i < beatChroma.length; i++) {
    const v = beatChroma[i].vector;
    for (let k = 0; k < 12; k++) acc[k] += v[k];
    n++;
  }
  const out = new Float32Array(12);
  if (n) for (let k = 0; k < 12; k++) out[k] = acc[k] / n;
  return out;
}

/**
 * Energy + spectrally-noisy-content summary per segment. `vocalBandShare` is a proxy
 * (share of 300–3500 Hz energy), never a claim that someone is singing.
 */
export function segmentStats(mags, nfft, sr, hop, segment, { vocalBand = [300, 3500], lowBand = [30, 160] } = {}) {
  const { start, end } = segment;
  const i0 = Math.max(0, Math.floor(start / (hop / sr)));
  const i1 = Math.min(mags.length, Math.max(i0 + 1, Math.ceil(end / (hop / sr))));
  const bin = (hz) => Math.round((hz * nfft) / sr);
  const [vLo, vHi] = [bin(vocalBand[0]), bin(vocalBand[1])];
  const [lLo, lHi] = [bin(lowBand[0]), bin(lowBand[1])];
  let all = 0;
  let voc = 0;
  let low = 0;
  let frames = 0;
  for (let f = i0; f < i1; f++) {
    const m = mags[f];
    for (let b = 1; b < m.length; b++) {
      const p = m[b] * m[b];
      all += p;
      if (b >= vLo && b <= vHi) voc += p;
      if (b >= lLo && b <= lHi) low += p;
    }
    frames++;
  }
  const rmsLike = frames ? Math.sqrt(all / (frames * (mags[0]?.length ?? 1))) : 0;
  return {
    vocalBandShare: all > 0 ? round(voc / all, 3) : 0,
    lowBandShare: all > 0 ? round(low / all, 3) : 0,
    energyDb: round(20 * Math.log10(rmsLike + 1e-9), 1),
  };
}

/** Loudness envelope in dB, one value per `windowSeconds`, for "where is the loud part". */
export function loudnessEnvelope(samples, sr, windowSeconds = 1) {
  const w = Math.max(1, Math.round(windowSeconds * sr));
  const out = [];
  for (let i = 0; i < samples.length; i += w) {
    const end = Math.min(samples.length, i + w);
    let s = 0;
    for (let k = i; k < end; k++) s += samples[k] * samples[k];
    const rms = Math.sqrt(s / Math.max(1, end - i));
    out.push({ t: round(i / sr, 2), db: round(20 * Math.log10(rms + 1e-9), 1) });
  }
  const dbs = out.map((x) => x.db);
  return {
    points: out,
    medianDb: round(percentile(dbs, 0.5), 1),
    p95Db: round(percentile(dbs, 0.95), 1),
    rangeDb: round(percentile(dbs, 0.95) - percentile(dbs, 0.05), 1),
  };
}

/** "Chain" of sections with start/end/duration and stats, ready for the formatter. */
export function sectionChain(labeled, beatChroma, mags, nfft, sr, hop) {
  const out = [];
  for (let i = 0; i < labeled.length; i++) {
    const sec = labeled[i];
    const start = sec.time;
    const end = i + 1 < labeled.length ? labeled[i + 1].time : round((beatChroma[beatChroma.length - 1]?.end ?? start), 2);
    const stats = segmentStats(mags, nfft, sr, hop, { start, end });
    out.push({
      label: sec.label,
      start: round(start, 2),
      end: round(end, 2),
      durationSeconds: round(end - start, 2),
      boundaryStrength: sec.strength,
      similarityToEarlier: sec.similarityToEarlier,
      ...stats,
    });
  }
  return out;
}
