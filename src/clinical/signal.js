// Signal analytics: beat-interval rhythm screening, personal baselines and trends.

/** RMSSD heart-rate variability (ms) from beat-to-beat intervals. */
export function computeRmssd(intervals) {
  if (intervals.length < 3) return null;
  let sum = 0;
  for (let i = 1; i < intervals.length; i++) sum += (intervals[i] - intervals[i - 1]) ** 2;
  return Math.sqrt(sum / (intervals.length - 1));
}

/** Rhythm screening only: flags patterns for human review, and does not diagnose. */
export function classifyRhythm(intervals) {
  if (intervals.length < 8) return { rhythm: 'insufficient', cv: null };
  const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const sd = Math.sqrt(intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / intervals.length);
  const cv = sd / mean;
  if (intervals.some((i) => i > 3000)) return { rhythm: 'pause', cv };
  if (cv > 0.15) return { rhythm: 'irregular', cv };
  const rate = 60000 / mean;
  if (rate > 100) return { rhythm: 'tachycardia', cv };
  if (rate < 50) return { rhythm: 'bradycardia', cv };
  return { rhythm: 'regular', cv };
}

const SD_FLOOR = { hr: 3, rr: 1.5, spo2: 0.7, sys: 5, dia: 4, temp: 0.15 };
const MIN_SAMPLES = 120;

/** Exponentially weighted personal baseline for one parameter. */
export class Baseline {
  constructor(param, state = null) {
    this.param = param;
    this.n = state?.n ?? 0;
    this.mean = state?.mean ?? 0;
    this.variance = state?.variance ?? 0;
  }

  learn(x) {
    this.n += 1;
    const alpha = Math.max(1 / this.n, 0.002);
    const delta = x - this.mean;
    this.mean += alpha * delta;
    this.variance = (1 - alpha) * (this.variance + alpha * delta * delta);
  }

  /** Null until enough samples exist, so an untrained baseline can never alarm. */
  zscore(x) {
    if (this.n < MIN_SAMPLES) return null;
    const sd = Math.max(Math.sqrt(this.variance), SD_FLOOR[this.param] ?? 1);
    return (x - this.mean) / sd;
  }
}

/** Least-squares slope over a time window, in units per minute. */
export class Trend {
  constructor(windowMs) {
    this.windowMs = windowMs;
    this.points = [];
  }

  add(t, v) {
    this.points.push([t, v]);
    while (this.points.length && t - this.points[0][0] > this.windowMs) this.points.shift();
  }

  reset() {
    this.points = [];
  }

  /** Null until at least 80% of the window is covered. */
  slopePerMin() {
    if (this.points.length < 3) return null;
    const t0 = this.points[0][0];
    const span = this.points.at(-1)[0] - t0;
    if (span < this.windowMs * 0.8) return null;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const [t, v] of this.points) {
      const x = (t - t0) / 60000;
      sx += x; sy += v; sxx += x * x; sxy += x * v;
    }
    const n = this.points.length;
    const denom = n * sxx - sx * sx;
    return denom === 0 ? null : (n * sxy - sx * sy) / denom;
  }

  change() {
    return this.points.length ? this.points.at(-1)[1] - this.points[0][1] : 0;
  }
}
