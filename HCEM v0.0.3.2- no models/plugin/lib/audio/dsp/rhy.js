/**
 * rhy.js — 节奏：起音包络 → 速度 → 拍点 → 小节（下拍）→ 清晰度。
 *
 * 三条从样本里换来的纪律，写在代码里的位置就是它们的成因：
 *
 * 1) **不要在帧网格上直接量周期。** 22.05 kHz / hop 256 = 11.61 ms；一个 0.534 s 的拍
 *    会正好落在整数帧上，长曲子里累计漂移足以让后半段全部脱拍。所以拍点的时间来自
 *    **峰值亚帧内插**（抛物线，±0.5 帧），DP 只负责决定"哪一帧开始一个拍"。
 * 2) **速度不是单一数字。** 输出 bpm 同时给出二倍/三倍关系的竞争分值；如果 2× 或 ½
 *    的分值差距小于 8%，标记 ambiguous，让调用方知道自己拿到的可能是倍频。
 * 3) **下拍（4/4 的第一拍）先验不可靠。** 只报"四种相位里最强的那个" + 对比度；
 *    对比度 <15% 时直接说归属不确定，允许调用方用参数覆盖。
 */

import {
  dB, fft, hann, mean, median, melEnergies, melFilterbank, movingAverage, normalize, parabolicOffset, peaks, percentile, round, std,
} from './core.js';

const HOP = 256;
const NFFT = 2048;

/**
 * Spectral-flux onset envelope on log-mel bands, computed in ONE streaming pass.
 *
 * It deliberately does not return the magnitude spectra: a 10-minute file at 22 kHz
 * would keep ~50k frames × 1k bins alive (~200 MB) just to answer "where are the beats".
 * The low-band series the kick detector needs is accumulated in the same pass.
 */
export function onsetEnvelope(samples, sr, { nfft = 1024, hop = 256, melBands = 40, lowBand = [30, 150] } = {}) {
  const win = hann(nfft);
  const filters = melFilterbank(sr, nfft, melBands, 30);
  const frames = Math.max(0, Math.floor((samples.length - nfft) / hop) + 1);
  const strength = new Float32Array(frames);
  const low = new Float32Array(frames);
  const bins = nfft >> 1;
  const loB = Math.max(1, Math.floor((lowBand[0] * nfft) / sr));
  const hiB = Math.min(bins - 1, Math.ceil((lowBand[1] * nfft) / sr));
  const re = new Float32Array(nfft);
  const im = new Float32Array(nfft);
  let prev = null;
  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let i = 0; i < nfft; i++) { re[i] = samples[off + i] * win[i]; im[i] = 0; }
    fft(re, im, false);
    const mag = new Float32Array(bins);
    for (let b = 0; b < bins; b++) mag[b] = Math.hypot(re[b], im[b]);
    const mel = melEnergies(mag, filters);
    if (prev) {
      let flux = 0;
      for (let b = 0; b < mel.length; b++) {
        const d = Math.log1p(1000 * mel[b]) - Math.log1p(1000 * prev[b]);
        if (d > 0) flux += d;
      }
      strength[f] = flux;
    }
    let lb = 0;
    for (let b = loB; b <= hiB; b++) lb += mag[b] * mag[b];
    low[f] = Math.sqrt(lb);
    prev = mel;
  }
  // Remove the slow part so a sustained pad does not look like a stream of onsets.
  const slow = movingAverage(strength, Math.max(1, Math.round(0.4 / (hop / sr))));
  let max = 0;
  let lowMax = 0;
  for (let f = 0; f < frames; f++) {
    strength[f] = Math.max(0, strength[f] - slow[f]);
    if (strength[f] > max) max = strength[f];
    if (low[f] > lowMax) lowMax = low[f];
  }
  const m = mean(strength) || 1;
  for (let f = 0; f < frames; f++) strength[f] /= m;
  if (lowMax > 0) for (let f = 0; f < frames; f++) low[f] /= lowMax;
  const times = new Float32Array(frames);
  for (let f = 0; f < frames; f++) times[f] = f * hop / sr;
  return {
    strength,
    lowBand: { times, values: low, hop, sr },
    hop,
    sr,
    secondsPerFrame: hop / sr,
    frames,
  };
}

/** Sub-frame onset times (seconds) from an envelope, with the raw frame index kept. */
export function onsetTimes(env, { threshold = 0.55, minGapSec = 0.05 } = {}) {
  const { strength, secondsPerFrame } = env;
  const minDistance = Math.max(1, Math.round(minGapSec / secondsPerFrame));
  const idx = peaks(strength, { threshold, minDistance, maxCount: 20000 });
  const times = new Float32Array(idx.length);
  const frames = new Int32Array(idx.length);
  for (let i = 0; i < idx.length; i++) {
    const f = idx[i];
    const off = parabolicOffset(strength[f - 1] ?? 0, strength[f], strength[f + 1] ?? 0);
    frames[i] = f;
    times[i] = (f + off) * secondsPerFrame;
  }
  return { times, frames };
}

/**
 * Period search over onset times with circular phase coherence, cross-checked against
 * autocorrelation of the envelope. The two disagreeing is information, not noise.
 */
export function estimateTempo(env, onset, { minBpm = 50, maxBpm = 220 } = {}) {
  const { strength, secondsPerFrame, sr } = env;
  const dur = strength.length * secondsPerFrame;

  // --- autocorrelation of the envelope at 0.5 BPM steps -----------------------------
  const acfScore = new Map();
  const centres = [];
  for (let bpm = minBpm; bpm <= maxBpm; bpm += 0.5) centres.push(bpm);
  const lagFrames = (bpm) => 60 / bpm / secondsPerFrame;
  const sample = (lag) => {
    const i = Math.floor(lag);
    const f = lag - i;
    const a = strength[i] ?? 0;
    const b = strength[i + 1] ?? 0;
    return a * (1 - f) + b * f;
  };
  // Normalized autocorrelation: sum of env[i]*env[i+lag] over the overlap.
  for (const bpm of centres) {
    const lag = lagFrames(bpm);
    let num = 0;
    let d1 = 0;
    let d2 = 0;
    const limit = strength.length - Math.ceil(lag) - 1;
    for (let i = 0; i < limit; i += 2) {
      const a = strength[i];
      const b = sample(i + lag);
      num += a * b;
      d1 += a * a;
      d2 += b * b;
    }
    acfScore.set(bpm, num / (Math.sqrt(d1 * d2) || 1));
  }

  // --- circular coherence of onset times at each candidate period -------------------
  const cohScore = new Map();
  const times = onset.times;
  for (const bpm of centres) {
    const p = 60 / bpm;
    let re = 0;
    let im = 0;
    let wsum = 0;
    for (let k = 0; k < times.length; k++) {
      const w = strength[onset.frames[k]] || 1;
      const phase = (2 * Math.PI * times[k]) / p;
      re += w * Math.cos(phase);
      im += w * Math.sin(phase);
      wsum += w;
    }
    cohScore.set(bpm, Math.hypot(re, im) / (wsum || 1));
  }

  // --- combine, then handle the octave ambiguity explicitly -------------------------
  const combined = new Map();
  for (const bpm of centres) {
    const ac = acfScore.get(bpm) || 0;
    const coh = cohScore.get(bpm) || 0;
    // A slight preference for the 80–160 BPM band mirrors how people tap along;
    // it is a prior, not evidence, so it is small (15% max).
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.75, 2));
    combined.set(bpm, 0.55 * ac + 0.45 * coh + 0.15 * prior);
  }
  const ranked = [...combined.entries()].sort((a, b) => b[1] - a[1]);
  const [bestBpm, bestScore] = ranked[0];
  const rival = (factor) => {
    const target = bestBpm * factor;
    let best = -Infinity;
    for (const [bpm, score] of combined) {
      if (Math.abs(bpm - target) <= target * 0.02 && score > best) best = score;
    }
    return best === -Infinity ? 0 : best;
  };
  const half = rival(0.5);
  const twice = rival(2);
  const third = rival(1 / 3);
  const thirdScore = Math.max(0, third);
  const gapToOctave = Math.max(half, twice) / (bestScore || 1);
  const gapToThird = thirdScore / (bestScore || 1);
  let ambiguity = 'ok';
  if (Math.max(gapToOctave, gapToThird) > 0.92) ambiguity = 'ambiguous';
  else if (Math.max(gapToOctave, gapToThird) > 0.8) ambiguity = 'marginal';

  const rivalBpm = half >= twice ? bestBpm / 2 : bestBpm * 2;

  return {
    bpm: round(bestBpm, 1),
    score: bestScore,
    ambiguity,
    octaveRivals: [
      { bpm: round(bestBpm / 2, 1), score: half / (bestScore || 1) },
      { bpm: round(bestBpm * 2, 1), score: twice / (bestScore || 1) },
      { bpm: round(bestBpm / 3, 1), score: thirdScore / (bestScore || 1) },
    ].filter((r) => r.score > 0.35),
    rival: ambiguity === 'ok' ? null : { bpm: round(rivalBpm, 1) },
    top: ranked.slice(0, 5).map(([bpm, score]) => ({ bpm: round(bpm, 1), score: round(score, 3) })),
    durationSeconds: round(dur, 2),
    acfAtBest: round(acfScore.get(bestBpm) || 0, 3),
    coherenceAtBest: round(cohScore.get(bestBpm) || 0, 3),
    sr,
  };
}

/**
 * Dynamic-programming beat tracker (Ellis 2007 style): local onset support plus a
 * log-normal transition cost around the estimated period.
 */
export function trackBeats(env, tempo, { tightness = 60 } = {}) {
  const { strength, secondsPerFrame } = env;
  const n = strength.length;
  const period = 60 / tempo.bpm / secondsPerFrame;
  const minLag = Math.max(1, Math.round(period * 0.5));
  const maxLag = Math.max(minLag + 1, Math.round(period * 2));
  const local = movingAverage(strength, Math.max(1, Math.round(period * 0.08)));
  const maxLocal = Math.max(...local, 1e-9);
  const cumscore = new Float64Array(n);
  const backlink = new Int32Array(n).fill(-1);
  let bestEnd = 0;
  let bestEndScore = -Infinity;
  for (let i = 0; i < n; i++) {
    let bestPrev = -1;
    let bestVal = -Infinity;
    for (let j = Math.max(0, i - maxLag); j <= i - minLag; j++) {
      const ratio = (i - j) / period;
      const tx = -tightness * Math.pow(Math.log(Math.max(ratio, 1e-6)), 2);
      const v = cumscore[j] + tx;
      if (v > bestVal) { bestVal = v; bestPrev = j; }
    }
    const localNorm = local[i] / maxLocal;
    if (bestPrev < 0) {
      cumscore[i] = localNorm;
      backlink[i] = -1;
    } else {
      cumscore[i] = localNorm + bestVal;
      backlink[i] = bestPrev;
    }
    if (i > n - Math.round(period * 3) && cumscore[i] > bestEndScore) {
      bestEndScore = cumscore[i];
      bestEnd = i;
    }
  }
  const frames = [];
  for (let i = bestEnd; i >= 0 && frames.length < 20000; i = backlink[i]) {
    frames.push(i);
    if (backlink[i] < 0) break;
  }
  frames.reverse();

  // Snap each DP frame to the strongest onset within ±35% of a period, then interpolate.
  const { times: onsetT, frames: onsetF } = onsetTimes(env, { threshold: 0.25, minGapSec: 0.03 });
  const beats = [];
  const radius = Math.max(2, Math.round(period * 0.35));
  for (const f of frames) {
    let bestIdx = -1;
    let bestVal = 0;
    for (let k = 0; k < onsetF.length; k++) {
      const d = Math.abs(onsetF[k] - f);
      if (d <= radius && strength[onsetF[k]] > bestVal) { bestVal = strength[onsetF[k]]; bestIdx = k; }
    }
    const t = bestIdx >= 0 ? onsetT[bestIdx] : f * secondsPerFrame;
    if (!beats.length || t - beats[beats.length - 1] > period * 0.35 * secondsPerFrame) beats.push(t);
  }
  const ibi = [];
  for (let i = 1; i < beats.length; i++) ibi.push((beats[i] - beats[i - 1]) * 1000);
  const medIbi = median(ibi);
  const driftMs = ibi.length ? std(ibi) : 0;
  const coverage = beats.length ? Math.min(1, beats.length / Math.max(1, Math.round((env.strength.length * secondsPerFrame) / (medIbi / 1000 || 1)))) : 0;
  let support = 0;
  if (beats.length) {
    for (const t of beats) {
      const f = Math.round(t / secondsPerFrame);
      let peakVal = 0;
      for (let d = -2; d <= 2; d++) peakVal = Math.max(peakVal, strength[f + d] ?? 0);
      support += peakVal;
    }
    support /= beats.length;
  }
  return {
    beats: beats.map((t) => round(t, 4)),
    beatCount: beats.length,
    medianIbiMs: round(medIbi, 2),
    driftMs: round(driftMs, 2),
    coverage: round(coverage, 3),
    pulseClarity: round(support, 3),
    bpmFromBeats: medIbi > 0 ? round(60000 / medIbi, 2) : null,
  };
}

/**
 * Downbeat (bar start) by low-band (kick) energy at each beat, folded mod 4.
 * Returns the winning phase plus the contrast that decides whether it may be trusted.
 */
export function estimateDownbeat(beats, bandEnergy, { beatsPerBar = 4, maxLagSec = 0.06 } = {}) {
  if (beats.length < beatsPerBar * 2) {
    return { phase: 0, contrast: 0, ambiguous: true, bars: 0, phaseScores: [] };
  }
  const { times, values } = bandEnergy; // times: seconds, values: normalized 0..1
  const energyAt = (t) => {
    let best = 0;
    for (let k = 0; k < times.length; k++) {
      if (Math.abs(times[k] - t) <= maxLagSec) best = Math.max(best, values[k]);
    }
    return best;
  };
  const sums = new Array(beatsPerBar).fill(0);
  const counts = new Array(beatsPerBar).fill(0);
  for (let i = 0; i < beats.length; i++) {
    const phase = i % beatsPerBar;
    sums[phase] += energyAt(beats[i]);
    counts[phase]++;
  }
  const avg = sums.map((s, i) => (counts[i] ? s / counts[i] : 0));
  const total = avg.reduce((a, b) => a + b, 0) || 1;
  const norm = avg.map((v) => v / total);
  let phase = 0;
  for (let i = 1; i < norm.length; i++) if (norm[i] > norm[phase]) phase = i;
  const sorted = [...norm].sort((a, b) => b - a);
  const contrast = sorted[1] > 0 ? (sorted[0] - sorted[1]) / sorted[1] : sorted[0] > 0 ? 1 : 0;
  return {
    phase,
    contrast: round(contrast, 3),
    // <15% differences are below what a 4/4 kick pattern can resolve on real material.
    ambiguous: contrast < 0.15,
    bars: Math.floor(beats.length / beatsPerBar),
    phaseScores: norm.map((v) => round(v, 3)),
    beatsPerBar,
  };
}

/**
 * Band energy sampled at the beat grid — used for the kick phase and for "is the
 * low end hitting on the beat" style reporting.
 */
export function bandEnergySeries(frameMagnitudes, nfft, sr, { band = [30, 150], hop = HOP } = {}) {
  const mags = typeof frameMagnitudes?.[0] === 'number' ? [frameMagnitudes] : frameMagnitudes;
  const bins = mags[0]?.length ?? 0;
  const lo = Math.max(0, Math.floor((band[0] * nfft) / sr));
  const hi = Math.min(bins - 1, Math.ceil((band[1] * nfft) / sr));
  const values = new Float32Array(mags.length);
  let max = 0;
  for (let f = 0; f < mags.length; f++) {
    let s = 0;
    const mag = mags[f];
    for (let b = lo; b <= hi; b++) s += mag[b] * mag[b];
    values[f] = Math.sqrt(s);
    if (values[f] > max) max = values[f];
  }
  if (max > 0) for (let f = 0; f < values.length; f++) values[f] /= max;
  const times = new Float32Array(values.length);
  for (let f = 0; f < values.length; f++) times[f] = f * hop / sr;
  return { times, values, hop, sr };
}

/**
 * Second opinion on the downbeat, from harmony instead of kick energy.
 * A four-on-the-floor kick gives every phase identical low-band energy (measured
 * contrast 0.0 on the test mix), while chords still change on bar lines. The two
 * estimates agreeing is worth more than either alone.
 */
export function estimateDownbeatChroma(beatVectors, { beatsPerBar = 4 } = {}) {
  const n = beatVectors.length;
  if (n < beatsPerBar * 2) return { phase: 0, contrast: 0, ambiguous: true, phaseScores: [], beatsPerBar };
  const sums = new Array(beatsPerBar).fill(0);
  const counts = new Array(beatsPerBar).fill(0);
  for (let i = 1; i < n; i++) {
    let d = 0;
    for (let k = 0; k < 12; k++) d += Math.abs(beatVectors[i][k] - beatVectors[i - 1][k]);
    sums[i % beatsPerBar] += d;
    counts[i % beatsPerBar]++;
  }
  const avg = sums.map((s, i) => (counts[i] ? s / counts[i] : 0));
  const total = avg.reduce((a, b) => a + b, 0) || 1;
  const norm = avg.map((v) => v / total);
  let phase = 0;
  for (let i = 1; i < norm.length; i++) if (norm[i] > norm[phase]) phase = i;
  const sorted = [...norm].sort((a, b) => b - a);
  const contrast = sorted[1] > 0 ? (sorted[0] - sorted[1]) / sorted[1] : sorted[0] > 0 ? 1 : 0;
  return { phase, contrast: round(contrast, 3), ambiguous: contrast < 0.15, phaseScores: norm.map((v) => round(v, 3)), beatsPerBar };
}

/** Summary numbers the formatter prints next to the tempo, never on their own. */
export function rhythmSummary(tempo, tracked, downbeat) {
  return {
    bpm: tempo.bpm,
    bpmSource: tracked.bpmFromBeats ? round(tracked.bpmFromBeats, 1) : tempo.bpm,
    ambiguity: tempo.ambiguity,
    rival: tempo.rival,
    beatCount: tracked.beatCount,
    driftMs: tracked.driftMs,
    pulseClarity: tracked.pulseClarity,
    coverage: tracked.coverage,
    downbeat: downbeat.phase,
    downbeatContrast: downbeat.contrast,
    downbeatAmbiguous: downbeat.ambiguous,
    bars: downbeat.bars,
  };
}

/** dB helper re-exported so callers do not import core directly. */
export { dB, percentile, peaks };
