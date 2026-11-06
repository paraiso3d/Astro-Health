import { HOLD } from './alertEngine.js';
import { ENV_PARAMS, SEVERITY, VITALS, evaluateBand, isPlausible, limitsFor } from './limits.js';
import { computeNews2 } from './news2.js';
import { Baseline, Trend, classifyRhythm, computeRmssd } from './signal.js';

const QUALITY_MIN = 0.5;
const RECOVERY_MS = 5 * 60000;
const STABLE_MS = 2 * 60000;
const STALE_CAUTION_MS = 10000;
const STALE_WARNING_MS = 60000;
const LOW_BATTERY = 15;
const BASELINE_Z = 4;

const LEARNED_ACTIVITIES = new Set(['rest', 'work', 'sleep']);

const PROTOCOL_FOR = {
  spo2: () => 'hypoxia',
  hr: (direction) => (direction === 'high' ? 'arrhythmia' : 'hypotension-syncope'),
  rr: () => 'hypoxia',
  sys: (direction) => (direction === 'low' ? 'hypotension-syncope' : null),
  dia: () => null,
  temp: (direction) => (direction === 'high' ? 'hyperthermia' : null),
};

/** Per-crew rolling state used by the vital-sign evaluators. */
export class CrewSignalState {
  constructor(baselines = {}) {
    this.activity = null;
    this.activityChangedAt = 0;
    this.lastExertionAt = -Infinity;
    this.intervals = [];
    this.baselines = {};
    for (const param of Object.keys(VITALS)) this.baselines[param] = {};
    for (const [param, byActivity] of Object.entries(baselines)) {
      for (const [activity, state] of Object.entries(byActivity)) this.baselines[param][activity] = new Baseline(param, state);
    }
    this.trends = { spo2: new Trend(5 * 60000), temp: new Trend(10 * 60000) };
    this.lastNews = null;
    this.lastRhythm = null;
    this.lastRmssd = null;
  }

  baselineFor(param, activity) {
    return (this.baselines[param][activity] ??= new Baseline(param));
  }

  serializeBaselines() {
    const out = {};
    for (const [param, byActivity] of Object.entries(this.baselines)) {
      out[param] = {};
      for (const [activity, b] of Object.entries(byActivity)) out[param][activity] = { n: b.n, mean: b.mean, variance: b.variance };
    }
    return out;
  }
}

/** A reading counts only if its sensor reports good contact and the value is physiologically possible. */
export function readValid(sample, param) {
  const value = sample[param];
  if (value === null || value === undefined) return null;
  const quality = sample.quality?.[VITALS[param].sensor] ?? 0;
  if (quality < QUALITY_MIN || !isPlausible(param, value)) return null;
  if (param === 'dia' && Number.isFinite(sample.sys) && value >= sample.sys) return null;
  return value;
}

const fmt = (v, decimals = 0) => Number(v).toFixed(decimals);

/**
 * Evaluates one sample. Returns [key, condition] pairs covering every rule, so each
 * rule either fires, clears (null) or holds its last state when the data is unreadable.
 */
export function evaluateVitals(sample, crew, state, { overrides = {}, avpu = 'A', onOxygen = false, hasActiveClinical = false } = {}) {
  const now = sample.ts;
  const out = [];
  const id = crew.id;

  if (sample.activity !== state.activity) {
    state.activity = sample.activity;
    state.activityChangedAt = now;
    state.trends.spo2.reset();
    state.trends.temp.reset();
  }
  const exerting = sample.activity === 'exercise' || sample.activity === 'eva';
  if (exerting) state.lastExertionAt = now;
  const inRecovery = !exerting && now - state.lastExertionAt < RECOVERY_MS;
  const effective = inRecovery ? 'exercise' : sample.activity;
  const stable = now - state.activityChangedAt >= STABLE_MS && !inRecovery && !exerting;

  const valid = {};
  for (const param of Object.keys(VITALS)) valid[param] = readValid(sample, param);

  // Threshold bands
  for (const [param, meta] of Object.entries(VITALS)) {
    const key = `vital:${id}:${param}`;
    const value = valid[param];
    if (value === null) {
      out.push([key, HOLD]);
      continue;
    }
    const hit = evaluateBand(value, limitsFor(param, effective, crew, overrides));
    if (!hit) {
      out.push([key, null]);
      continue;
    }
    out.push([key, {
      category: 'clinical', crewId: id, param, severity: hit.severity, direction: hit.direction, value, unit: meta.unit,
      title: `${meta.label} ${hit.direction}`,
      message: `${crew.name}: ${meta.label} ${fmt(value, meta.decimals)} ${meta.unit} (limit ${hit.limit}, ${effective})`,
      protocol: PROTOCOL_FOR[param]?.(hit.direction) ?? null,
    }]);
  }

  // Sensor faults stay technical, so a detached lead is never mistaken for a clinical event
  const sensors = {};
  for (const [param, meta] of Object.entries(VITALS)) {
    sensors[meta.sensor] = sensors[meta.sensor] === false ? false : valid[param] !== null;
  }
  for (const [sensor, ok] of Object.entries(sensors)) {
    out.push([`sensor:${id}:${sensor}`, ok ? null : {
      category: 'technical', crewId: id, severity: SEVERITY.CAUTION, persistMs: 10000, title: `Sensor fault: ${sensor}`,
      message: `${crew.name}: ${sensor} signal lost or unreliable. Check sensor contact.`,
    }]);
  }
  const lifeSignsLost = !sensors.ecg && !sensors.pulseox;
  out.push([`sensor:${id}:lifesigns`, lifeSignsLost ? {
    category: 'technical', crewId: id, severity: SEVERITY.WARNING, persistMs: 10000, title: 'Heart monitoring lost',
    message: `${crew.name}: ECG and pulse oximeter are both unavailable. Verify crew member condition directly.`,
  } : null]);
  out.push([`battery:${id}`, Number.isFinite(sample.battery) && sample.battery < LOW_BATTERY ? {
    category: 'technical', crewId: id, severity: SEVERITY.ADVISORY, persistMs: 1000, title: 'Wearable battery low',
    message: `${crew.name}: wearable at ${fmt(sample.battery)}%`,
  } : null]);

  // NEWS2 is not valid during or just after exertion
  const news = computeNews2({ rr: valid.rr, spo2: valid.spo2, sys: valid.sys, hr: valid.hr, temp: valid.temp, avpu, onOxygen });
  news.valid = effective !== 'exercise' && sample.activity !== 'eva';
  state.lastNews = news;
  let newsCond = null;
  if (news.valid && news.score >= 5) {
    const severity = news.score >= 7 ? SEVERITY.WARNING : SEVERITY.CAUTION;
    newsCond = {
      category: 'clinical', crewId: id, severity, value: news.score, unit: 'pts', direction: 'high', persistMs: 15000,
      title: `NEWS2 ${severity === SEVERITY.WARNING ? 'high' : 'medium'} risk`,
      message: `${crew.name}: NEWS2 score ${news.score}. Clinical review ${severity === SEVERITY.WARNING ? 'immediately' : 'urgently'}.`,
    };
  }
  out.push([`news2:${id}`, newsCond]);
  out.push([`avpu:${id}`, avpu !== 'A' ? {
    category: 'clinical', crewId: id, severity: avpu === 'U' ? SEVERITY.EMERGENCY : SEVERITY.WARNING, persistMs: 0, value: null,
    title: `Reduced consciousness (${avpu})`, message: `${crew.name}: last check recorded AVPU = ${avpu}.`,
    protocol: avpu === 'U' ? 'cardiac-arrest' : 'hypotension-syncope',
  } : null]);

  // Rhythm screening
  if (Array.isArray(sample.intervals) && (sample.quality?.ecg ?? 0) >= QUALITY_MIN) {
    state.intervals.push(...sample.intervals);
    if (state.intervals.length > 30) state.intervals.splice(0, state.intervals.length - 30);
    const result = classifyRhythm(state.intervals);
    state.lastRhythm = result.rhythm;
    state.lastRmssd = computeRmssd(state.intervals);
    let cond = null;
    if (result.rhythm === 'pause') {
      cond = { severity: SEVERITY.WARNING, persistMs: 0, title: 'Cardiac pause detected', message: `${crew.name}: beat interval over 3 s. Review ECG now.` };
    } else if (result.rhythm === 'irregular') {
      cond = { severity: SEVERITY.CAUTION, persistMs: 30000, title: 'Irregular rhythm', message: `${crew.name}: irregular beat intervals (CV ${result.cv.toFixed(2)}). Review ECG; possible arrhythmia.` };
    }
    out.push([`rhythm:${id}`, cond ? { ...cond, category: 'clinical', crewId: id, protocol: 'arrhythmia' } : null]);
  } else {
    state.lastRhythm = null;
    state.lastRmssd = null;
    out.push([`rhythm:${id}`, HOLD]);
  }

  // Slow trends, ahead of hard limits
  if (valid.spo2 !== null) state.trends.spo2.add(now, valid.spo2);
  if (valid.temp !== null) state.trends.temp.add(now, valid.temp);
  const spo2Slope = state.trends.spo2.slopePerMin();
  out.push([`trend:${id}:spo2`, stable && spo2Slope !== null && spo2Slope < -0.5 && state.trends.spo2.change() <= -2 ? {
    category: 'clinical', crewId: id, param: 'spo2', severity: SEVERITY.ADVISORY, persistMs: 0, title: 'SpO2 trending down',
    message: `${crew.name}: SpO2 falling ${Math.abs(spo2Slope).toFixed(1)} %/min over 5 min.`, protocol: 'hypoxia',
  } : null]);
  const tempSlope = state.trends.temp.slopePerMin();
  out.push([`trend:${id}:temp`, stable && tempSlope !== null && tempSlope > 0.05 && state.trends.temp.change() >= 0.5 ? {
    category: 'clinical', crewId: id, param: 'temp', severity: SEVERITY.ADVISORY, persistMs: 0, title: 'Temperature trending up',
    message: `${crew.name}: core temperature rising ${tempSlope.toFixed(2)} °C/min over 10 min.`, protocol: 'fever-sepsis',
  } : null]);

  // Deviation from this person's own baseline; disease must not be learned as "normal"
  for (const [param, meta] of Object.entries(VITALS)) {
    const key = `baseline:${id}:${param}`;
    const value = valid[param];
    if (value === null || !LEARNED_ACTIVITIES.has(sample.activity)) {
      out.push([key, value === null ? HOLD : null]);
      continue;
    }
    const baseline = state.baselineFor(param, sample.activity);
    const z = stable ? baseline.zscore(value) : null;
    out.push([key, z !== null && Math.abs(z) >= BASELINE_Z ? {
      category: 'clinical', crewId: id, param, severity: SEVERITY.ADVISORY, value, unit: meta.unit,
      title: `${meta.label} off personal baseline`,
      message: `${crew.name}: ${meta.label} ${fmt(value, meta.decimals)} ${meta.unit} vs personal ${sample.activity} baseline ${fmt(baseline.mean, meta.decimals)}.`,
    } : null]);
    if (stable && !hasActiveClinical) baseline.learn(value);
  }

  return out;
}

/** Cabin atmosphere rules, including rate of pressure loss from a rolling trend. */
export function evaluateEnvironment(env, pressureTrend) {
  const out = [];
  for (const [param, meta] of Object.entries(ENV_PARAMS)) {
    const value = env[param];
    const key = `env:${param}`;
    if (!Number.isFinite(value)) {
      out.push([key, HOLD]);
      continue;
    }
    const hit = evaluateBand(value, meta.band);
    out.push([key, hit ? {
      category: 'environment', param, severity: hit.severity, direction: hit.direction, value, unit: meta.unit, protocol: meta.protocol,
      title: `${meta.label} ${hit.direction}`,
      message: `Cabin ${meta.label} ${fmt(value, meta.decimals)} ${meta.unit} (limit ${hit.limit}).`,
    } : null]);
  }
  const slope = pressureTrend.slopePerMin();
  let leak = null;
  if (slope !== null && slope < -0.2) {
    leak = {
      category: 'environment', param: 'pressure', severity: slope < -1 ? SEVERITY.EMERGENCY : SEVERITY.WARNING, persistMs: 3000, value: slope, unit: 'kPa/min',
      title: 'Cabin pressure falling', message: `Cabin pressure falling ${Math.abs(slope).toFixed(2)} kPa/min. Possible leak.`, protocol: 'depressurization',
    };
  }
  out.push(['env:leak', leak]);
  return out;
}

/** Several people affected together points at a shared cause, not individual illness. */
export function evaluateCorrelations({ lowSpo2Count, staleCount, rrHighCount, co2Alarm }) {
  return [
    ['crew:hypoxia', lowSpo2Count >= 2 ? {
      category: 'environment', severity: SEVERITY.EMERGENCY, persistMs: 5000, title: 'Crew-wide desaturation',
      message: `${lowSpo2Count} crew members have low SpO2 together. Suspect cabin atmosphere. Don oxygen and check ppO2 and pressure.`, protocol: 'hypoxia',
    } : null],
    ['crew:hypercapnia', rrHighCount >= 2 && co2Alarm ? {
      category: 'environment', severity: SEVERITY.WARNING, persistMs: 5000, title: 'Crew symptoms match high CO2',
      message: `${rrHighCount} crew members are breathing fast while ppCO2 is alarming. Suspect CO2 removal failure.`, protocol: 'toxic-atmosphere',
    } : null],
    ['crew:dataloss', staleCount >= 2 ? {
      category: 'technical', severity: SEVERITY.WARNING, persistMs: 5000, title: 'Multiple telemetry streams lost',
      message: `${staleCount} crew telemetry streams are stale. Suspect the on-board network. Check crew directly.`,
    } : null],
  ];
}

export function staleCondition(crew, ageMs) {
  if (ageMs < STALE_CAUTION_MS) return null;
  const warning = ageMs >= STALE_WARNING_MS;
  return {
    category: 'technical', crewId: crew.id, severity: warning ? SEVERITY.WARNING : SEVERITY.CAUTION, persistMs: 0,
    title: 'No telemetry received',
    message: `${crew.name}: no data for ${Math.round(ageMs / 1000)} s. Verify crew member condition directly.`,
  };
}
