import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AlertEngine, HOLD } from '../src/clinical/alertEngine.js';
import { CrewSignalState, evaluateEnvironment, evaluateVitals, readValid, staleCondition } from '../src/clinical/evaluators.js';
import { SEVERITY, evaluateBand, hrMaxBand, limitsFor, validateOverride } from '../src/clinical/limits.js';
import { boneEstimate, doseCondition, doseStatus, evaluateLongitudinal, evaluateOcularExam, fatigueStatus } from '../src/clinical/longterm.js';
import { computeNews2 } from '../src/clinical/news2.js';
import { FORMULARY, checkAdministration, inventoryStatus } from '../src/clinical/pharmacy.js';
import { PROTOCOLS } from '../src/clinical/protocols.js';
import { computeReadiness } from '../src/clinical/readiness.js';
import { Baseline, Trend, classifyRhythm, computeRmssd } from '../src/clinical/signal.js';
import { SYMPTOMS, triageSymptom } from '../src/clinical/triage.js';
import { CREW, CREW_BY_ID } from '../src/crew.js';
import { DtnLink, PRIORITY } from '../src/link.js';

const crew = CREW_BY_ID.tanaka;
const normal = { rr: 16, spo2: 98, sys: 120, hr: 70, temp: 36.8 };

describe('NEWS2', () => {
  const single = (field, value) => computeNews2({ ...normal, [field]: value }).components[field];

  const tables = {
    rr: [[8, 3], [9, 1], [11, 1], [12, 0], [20, 0], [21, 2], [24, 2], [25, 3]],
    spo2: [[91, 3], [92, 2], [93, 2], [94, 1], [95, 1], [96, 0], [100, 0]],
    sys: [[90, 3], [91, 2], [100, 2], [101, 1], [110, 1], [111, 0], [219, 0], [220, 3]],
    hr: [[40, 3], [41, 1], [50, 1], [51, 0], [90, 0], [91, 1], [110, 1], [111, 2], [130, 2], [131, 3]],
    temp: [[35.0, 3], [35.1, 1], [36.0, 1], [36.1, 0], [38.0, 0], [38.1, 1], [39.0, 1], [39.1, 2]],
  };
  for (const [field, rows] of Object.entries(tables)) {
    for (const [value, expected] of rows) {
      test(`${field} ${value} scores ${expected}`, () => assert.equal(single(field, value), expected));
    }
  }

  test('all normal scores 0 and low risk', () => {
    const r = computeNews2(normal);
    assert.equal(r.score, 0);
    assert.equal(r.risk, 'low');
  });
  test('supplemental oxygen adds 2', () => assert.equal(computeNews2({ ...normal, onOxygen: true }).score, 2));
  test('any non-alert AVPU adds 3 and gives low-medium risk', () => {
    for (const avpu of ['C', 'V', 'P', 'U']) {
      const r = computeNews2({ ...normal, avpu });
      assert.equal(r.score, 3);
      assert.equal(r.risk, 'low-medium');
    }
  });
  test('5 is medium and 7 is high', () => {
    assert.equal(computeNews2({ ...normal, rr: 25, onOxygen: true }).risk, 'medium');
    assert.equal(computeNews2({ ...normal, rr: 25, onOxygen: true, sys: 95 }).risk, 'high');
  });
  test('missing vitals are never reported as low risk', () => {
    const r = computeNews2({ ...normal, spo2: null });
    assert.equal(r.complete, false);
    assert.deepEqual(r.missing, ['spo2']);
    assert.equal(r.risk, 'unknown');
  });
  test('a high partial score still reports high risk', () => {
    const r = computeNews2({ rr: 30, spo2: null, sys: 80, hr: 140, temp: null });
    assert.equal(r.risk, 'high');
    assert.equal(r.complete, false);
  });
});

describe('alarm limits', () => {
  test('bands report the worst level breached', () => {
    const band = { low: [94, 90, 85], high: [null, null, null] };
    assert.equal(evaluateBand(94, band), null);
    assert.equal(evaluateBand(93, band).severity, SEVERITY.CAUTION);
    assert.equal(evaluateBand(89, band).severity, SEVERITY.WARNING);
    assert.equal(evaluateBand(84, band).severity, SEVERITY.EMERGENCY);
  });
  test('exercise limits scale with age', () => {
    assert.deepEqual(hrMaxBand(40), [166, 180, 198]);
    assert.deepEqual(limitsFor('hr', 'exercise', { age: 40 }).high, [166, 180, 198]);
    assert.deepEqual(limitsFor('hr', 'rest', { age: 40 }).high, [110, 130, 180]);
  });
  test('crew overrides apply at rest and not during exertion', () => {
    const overrides = { hr: { high: [100, 120, 170] } };
    assert.deepEqual(limitsFor('hr', 'rest', crew, overrides).high, [100, 120, 170]);
    assert.notDeepEqual(limitsFor('hr', 'exercise', crew, overrides).high, [100, 120, 170]);
  });
  test('overrides are validated', () => {
    assert.equal(validateOverride('hr', { high: [100, 120, 170] }), null);
    assert.match(validateOverride('hr', { high: [120, 100, 170] }), /more extreme/);
    assert.match(validateOverride('hr', { low: [50, 40] }), /caution, warning, emergency/);
    assert.match(validateOverride('hr', { high: [100, 120, 900] }), /within/);
    assert.match(validateOverride('nope', { high: [1, 2, 3] }), /unknown/);
    assert.match(validateOverride('constructor', { high: [1, 2, 3] }), /unknown/);
    assert.match(validateOverride('__proto__', { high: [1, 2, 3] }), /unknown/);
    assert.match(validateOverride('hr', {}), /provide/);
    assert.match(validateOverride('hr', null), /must be an object/);
  });
});

describe('alert engine', () => {
  const cond = (severity, value = 1, extra = {}) => ({ category: 'clinical', crewId: 'x', severity, title: 't', message: 'm', value, direction: 'low', ...extra });
  const make = () => {
    const events = [];
    return { engine: new AlertEngine({ onEvent: (t, a) => events.push([t, a.severity]) }), events };
  };

  test('a one-sample spike does not raise an alarm', () => {
    const { engine } = make();
    engine.update('k', cond(SEVERITY.WARNING), 0);
    engine.update('k', null, 1000);
    for (let t = 2000; t < 30000; t += 1000) engine.update('k', null, t);
    assert.equal(engine.active().length, 0);
  });
  test('a sustained condition raises after its persistence time', () => {
    const { engine } = make();
    engine.update('k', cond(SEVERITY.WARNING), 0);
    engine.update('k', cond(SEVERITY.WARNING), 4000);
    assert.equal(engine.active().length, 0);
    engine.update('k', cond(SEVERITY.WARNING), 5000);
    assert.equal(engine.active().length, 1);
  });
  test('noise between levels still raises the sustained lower level', () => {
    const { engine } = make();
    for (let t = 0; t <= 15000; t += 1000) engine.update('k', cond(t % 2000 ? SEVERITY.WARNING : SEVERITY.CAUTION), t);
    assert.equal(engine.active()[0].severity, SEVERITY.CAUTION);
  });
  test('it does not escalate severity on one sample', () => {
    const { engine } = make();
    for (let t = 0; t <= 16000; t += 1000) engine.update('k', cond(SEVERITY.CAUTION), t);
    engine.update('k', cond(SEVERITY.EMERGENCY), 17000);
    assert.equal(engine.active()[0].severity, SEVERITY.CAUTION);
    engine.update('k', cond(SEVERITY.EMERGENCY), 19000);
    assert.equal(engine.active()[0].severity, SEVERITY.EMERGENCY);
  });
  test('HOLD never clears or raises: lost sensors must not clear an alarm', () => {
    const { engine } = make();
    for (let t = 0; t <= 5000; t += 1000) engine.update('k', cond(SEVERITY.WARNING), t);
    for (let t = 6000; t < 120000; t += 1000) engine.update('k', HOLD, t);
    assert.equal(engine.active().length, 1);
    assert.equal(engine.active()[0].clearedAt, null);
    const { engine: other } = make();
    other.update('k', HOLD, 0);
    other.update('k', HOLD, 60000);
    assert.equal(other.active().length, 0);
  });
  test('warnings latch until acknowledged, then resolve', () => {
    const { engine, events } = make();
    for (let t = 0; t <= 5000; t += 1000) engine.update('k', cond(SEVERITY.WARNING), t);
    for (let t = 6000; t <= 20000; t += 1000) engine.update('k', null, t);
    const a = engine.active()[0];
    assert.ok(a.clearedAt);
    assert.equal(a.status, 'active');
    engine.acknowledge(a.id, 'cmo', 21000);
    assert.equal(engine.active().length, 0);
    assert.ok(events.some(([t]) => t === 'resolved'));
  });
  test('cautions self-resolve after hysteresis', () => {
    const { engine } = make();
    for (let t = 0; t <= 15000; t += 1000) engine.update('k', cond(SEVERITY.CAUTION), t);
    engine.update('k', null, 16000);
    assert.equal(engine.active().length, 1, 'still active during hysteresis');
    engine.update('k', null, 26000);
    assert.equal(engine.active().length, 0);
  });
  test('hysteresis restarts if the condition returns', () => {
    const { engine } = make();
    for (let t = 0; t <= 15000; t += 1000) engine.update('k', cond(SEVERITY.CAUTION), t);
    engine.update('k', null, 16000);
    engine.update('k', cond(SEVERITY.CAUTION), 20000);
    engine.update('k', null, 21000);
    engine.update('k', null, 26000);
    assert.equal(engine.active().length, 1);
  });
  test('alerts do not downgrade, and worst value is kept', () => {
    const { engine } = make();
    for (let t = 0; t <= 5000; t += 1000) engine.update('k', cond(SEVERITY.WARNING, 85), t);
    engine.update('k', cond(SEVERITY.CAUTION, 92), 6000);
    const a = engine.active()[0];
    assert.equal(a.severity, SEVERITY.WARNING);
    assert.equal(a.value, 92);
    assert.equal(a.worstValue, 85);
  });
  test('unacknowledged warnings and emergencies escalate; acknowledged ones do not', () => {
    const { engine } = make();
    for (let t = 0; t <= 5000; t += 1000) engine.update('k', cond(SEVERITY.WARNING), t);
    engine.checkEscalations(60000);
    assert.equal(engine.active()[0].escalated, false);
    engine.checkEscalations(65000);
    assert.equal(engine.active()[0].escalated, true);
    const { engine: other } = make();
    for (let t = 0; t <= 5000; t += 1000) other.update('k', cond(SEVERITY.WARNING), t);
    other.acknowledge(other.active()[0].id, 'cmo', 6000);
    other.checkEscalations(100000);
    assert.equal(other.active()[0].escalated, false);
  });
  test('worsening reopens an acknowledged alert', () => {
    const { engine } = make();
    for (let t = 0; t <= 5000; t += 1000) engine.update('k', cond(SEVERITY.WARNING), t);
    engine.acknowledge(engine.active()[0].id, 'cmo', 6000);
    for (let t = 7000; t <= 9000; t += 1000) engine.update('k', cond(SEVERITY.EMERGENCY), t);
    const a = engine.active()[0];
    assert.equal(a.severity, SEVERITY.EMERGENCY);
    assert.equal(a.status, 'active');
    assert.equal(a.ackedBy, null);
  });
  test('emergencies cannot be silenced', () => {
    const { engine } = make();
    for (let t = 0; t <= 2000; t += 1000) engine.update('k', cond(SEVERITY.EMERGENCY), t);
    assert.match(engine.shelve(engine.active()[0].id, 15, 3000).error, /cannot be silenced/);
  });
  test('recurrences are counted', () => {
    const { engine } = make();
    const cycle = (start) => {
      for (let t = start; t <= start + 15000; t += 1000) engine.update('k', cond(SEVERITY.CAUTION), t);
      engine.update('k', null, start + 16000);
      engine.update('k', null, start + 27000);
    };
    cycle(0);
    cycle(30000);
    for (let t = 60000; t <= 75000; t += 1000) engine.update('k', cond(SEVERITY.CAUTION), t);
    assert.equal(engine.active()[0].occurrences, 3);
  });
});

describe('signal analytics', () => {
  const steady = (ms, n = 20) => Array(n).fill(ms);
  test('rhythm classes', () => {
    assert.equal(classifyRhythm(steady(1000, 3)).rhythm, 'insufficient');
    assert.equal(classifyRhythm(steady(900)).rhythm, 'regular');
    assert.equal(classifyRhythm(steady(450)).rhythm, 'tachycardia');
    assert.equal(classifyRhythm(steady(1500)).rhythm, 'bradycardia');
    assert.equal(classifyRhythm([...steady(800, 15), 3500]).rhythm, 'pause');
    const irregular = Array.from({ length: 20 }, (_, i) => (i % 2 ? 500 : 1000));
    assert.equal(classifyRhythm(irregular).rhythm, 'irregular');
  });
  test('RMSSD', () => {
    assert.equal(computeRmssd([800, 800]), null);
    assert.equal(computeRmssd([800, 800, 800]), 0);
    assert.equal(computeRmssd([800, 810, 800, 810]), 10);
  });
  test('an untrained baseline cannot alarm', () => {
    const b = new Baseline('hr');
    for (let i = 0; i < 119; i++) b.learn(60);
    assert.equal(b.zscore(200), null);
    b.learn(60);
    assert.ok(b.zscore(200) > 4);
  });
  test('baseline z-score uses a variability floor', () => {
    const b = new Baseline('hr');
    for (let i = 0; i < 200; i++) b.learn(60);
    assert.ok(Math.abs(b.zscore(63) - 1) < 0.01);
  });
  test('trend slope needs window coverage and is correct', () => {
    const t = new Trend(60000);
    t.add(0, 100);
    t.add(10000, 99);
    t.add(20000, 98);
    assert.equal(t.slopePerMin(), null);
    for (let s = 30; s <= 60; s += 10) t.add(s * 1000, 100 - s / 10);
    assert.ok(Math.abs(t.slopePerMin() + 6) < 1e-9);
  });
});

describe('vital evaluation', () => {
  const sample = (over = {}) => ({
    ts: 1000000, crewId: crew.id, activity: 'work', hr: 70, rr: 16, spo2: 98, sys: 120, dia: 76, temp: 36.7, battery: 80,
    quality: { ecg: 1, resp: 1, pulseox: 1, bp: 1, temp: 1 }, intervals: [], ...over,
  });
  const find = (results, key) => results.find(([k]) => k === key)?.[1];

  test('invalid readings: low quality, missing, impossible, diastolic above systolic', () => {
    assert.equal(readValid(sample({ hr: 80, quality: { ecg: 0.2 } }), 'hr'), null);
    assert.equal(readValid(sample({ hr: null }), 'hr'), null);
    assert.equal(readValid(sample({ hr: 500 }), 'hr'), null);
    assert.equal(readValid(sample({ sys: 80, dia: 90 }), 'dia'), null);
    assert.equal(readValid(sample(), 'hr'), 70);
  });
  test('normal sample raises nothing', () => {
    const results = evaluateVitals(sample(), crew, new CrewSignalState());
    assert.ok(results.every(([, c]) => !c || c === HOLD));
  });
  test('low SpO2 raises a clinical alert with the hypoxia protocol', () => {
    const c = find(evaluateVitals(sample({ spo2: 88 }), crew, new CrewSignalState()), `vital:${crew.id}:spo2`);
    assert.equal(c.severity, SEVERITY.WARNING);
    assert.equal(c.protocol, 'hypoxia');
  });
  test('a dropped sensor holds the clinical alarm and raises a technical fault', () => {
    const results = evaluateVitals(sample({ spo2: 40, quality: { ecg: 1, resp: 1, pulseox: 0, bp: 1, temp: 1 } }), crew, new CrewSignalState());
    assert.equal(find(results, `vital:${crew.id}:spo2`), HOLD);
    assert.equal(find(results, `sensor:${crew.id}:pulseox`).category, 'technical');
  });
  test('losing ECG and pulse oximeter together is a warning', () => {
    const results = evaluateVitals(sample({ hr: null, spo2: null, quality: { ecg: 0, resp: 1, pulseox: 0, bp: 1, temp: 1 } }), crew, new CrewSignalState());
    assert.equal(find(results, `sensor:${crew.id}:lifesigns`).severity, SEVERITY.WARNING);
  });
  test('exercise heart rate is normal during exertion and for 5 min afterward', () => {
    const state = new CrewSignalState();
    let results = evaluateVitals(sample({ activity: 'exercise', hr: 140, ts: 0 }), crew, state);
    assert.equal(find(results, `vital:${crew.id}:hr`), null);
    results = evaluateVitals(sample({ activity: 'rest', hr: 125, ts: 60000 }), crew, state);
    assert.equal(find(results, `vital:${crew.id}:hr`), null);
    results = evaluateVitals(sample({ activity: 'rest', hr: 125, ts: 301000 }), crew, state);
    assert.equal(find(results, `vital:${crew.id}:hr`).severity, SEVERITY.CAUTION);
  });
  test('NEWS2 is marked invalid and cannot alarm during exertion', () => {
    const state = new CrewSignalState();
    const results = evaluateVitals(sample({ activity: 'exercise', hr: 150, rr: 30 }), crew, state);
    assert.equal(state.lastNews.valid, false);
    assert.equal(find(results, `news2:${crew.id}`), null);
  });
  test('high NEWS2 at rest raises a warning', () => {
    const medium = evaluateVitals(sample({ hr: 135, rr: 26 }), crew, new CrewSignalState());
    assert.equal(find(medium, `news2:${crew.id}`).severity, SEVERITY.CAUTION, 'a score of 6 is medium risk');
    const high = evaluateVitals(sample({ hr: 135, rr: 26, sys: 95 }), crew, new CrewSignalState());
    assert.equal(find(high, `news2:${crew.id}`).severity, SEVERITY.WARNING, 'a score of 8 is high risk');
  });
  test('AVPU below Alert alarms, and Unresponsive is an emergency', () => {
    assert.equal(find(evaluateVitals(sample(), crew, new CrewSignalState(), { avpu: 'V' }), `avpu:${crew.id}`).severity, SEVERITY.WARNING);
    assert.equal(find(evaluateVitals(sample(), crew, new CrewSignalState(), { avpu: 'U' }), `avpu:${crew.id}`).severity, SEVERITY.EMERGENCY);
  });
  test('baselines do not learn from active illness', () => {
    const state = new CrewSignalState();
    const base = { activity: 'work' };
    for (let i = 0; i < 300; i++) evaluateVitals(sample({ ...base, ts: i * 1000, hr: 70 }), crew, state, { hasActiveClinical: i > 200 });
    const n = state.baselineFor('hr', 'work').n;
    evaluateVitals(sample({ ...base, ts: 301000, hr: 120 }), crew, state, { hasActiveClinical: true });
    assert.equal(state.baselineFor('hr', 'work').n, n);
  });
  test('deviation from personal baseline raises an advisory, even inside fixed limits', () => {
    const state = new CrewSignalState();
    for (let i = 0; i < 400; i++) evaluateVitals(sample({ ts: i * 1000, hr: 60 }), crew, state);
    const results = evaluateVitals(sample({ ts: 401000, hr: 90 }), crew, state);
    assert.equal(find(results, `vital:${crew.id}:hr`), null);
    assert.equal(find(results, `baseline:${crew.id}:hr`).severity, SEVERITY.ADVISORY);
  });
  test('a slow SpO2 decline raises a trend advisory before any limit', () => {
    const state = new CrewSignalState();
    let found = null;
    for (let i = 0; i <= 420; i++) {
      const spo2 = i < 120 ? 99 : 99 - (i - 120) * (4 / 300);
      const r = evaluateVitals(sample({ ts: i * 1000, spo2 }), crew, state);
      found = find(r, `trend:${crew.id}:spo2`) ?? found;
    }
    assert.equal(found.severity, SEVERITY.ADVISORY);
  });
  test('stale data escalates from caution to warning', () => {
    assert.equal(staleCondition(crew, 5000), null);
    assert.equal(staleCondition(crew, 10000).severity, SEVERITY.CAUTION);
    assert.equal(staleCondition(crew, 60000).severity, SEVERITY.WARNING);
  });
  test('cabin rules cover all parameters, and a missing reading holds', () => {
    const trend = new Trend(60000);
    const env = { co2: 2, o2: 21, pressure: 101, cabinTemp: 22, humidity: 45, radiation: 75 };
    assert.ok(evaluateEnvironment(env, trend).every(([, c]) => c === null));
    assert.equal(evaluateEnvironment({ ...env, co2: 11 }, trend).find(([k]) => k === 'env:co2')[1].severity, SEVERITY.EMERGENCY);
    assert.equal(evaluateEnvironment({ ...env, o2: null }, trend).find(([k]) => k === 'env:o2')[1], HOLD);
  });
  test('falling pressure is detected from its rate before low limits', () => {
    const trend = new Trend(60000);
    for (let s = 0; s <= 60; s++) trend.add(s * 1000, 101.3 - (0.6 * s) / 60);
    const leak = evaluateEnvironment({ co2: 2, o2: 21, pressure: 100.7, cabinTemp: 22, humidity: 45, radiation: 75 }, trend).find(([k]) => k === 'env:leak')[1];
    assert.equal(leak.severity, SEVERITY.WARNING);
  });
});

describe('readiness', () => {
  const healthy = {
    news: { valid: true, score: 0, complete: true, missing: [] }, activeAlerts: [], fatigue: { level: 'low', lastSleepH: 7.5 }, sedationActive: false,
    sedationWithin24h: false, openSymptoms: [], dose: { pct: 20 }, dataAgeMs: 1000, hold: null, env: {}, ocularRestricted: false,
  };
  test('healthy crew is GO for duty and EVA', () => {
    const r = computeReadiness(healthy);
    assert.equal(r.duty.status, 'GO');
    assert.equal(r.eva.status, 'GO');
  });
  test('no telemetry is UNKNOWN and never GO', () => {
    for (const dataAgeMs of [null, 61000]) {
      const r = computeReadiness({ ...healthy, dataAgeMs });
      assert.equal(r.duty.status, 'UNKNOWN');
      assert.equal(r.eva.status, 'UNKNOWN');
    }
  });
  test('no sleep log means EVA is not cleared', () => {
    const r = computeReadiness({ ...healthy, fatigue: { level: 'unknown', lastSleepH: null } });
    assert.equal(r.eva.status, 'UNKNOWN');
  });
  test('a clinical warning is NO-GO; caution restricts and also blocks EVA', () => {
    assert.equal(computeReadiness({ ...healthy, activeAlerts: [{ category: 'clinical', severity: 3, title: 'x', key: 'vital:a:hr' }] }).duty.status, 'NO-GO');
    const caution = computeReadiness({ ...healthy, activeAlerts: [{ category: 'clinical', severity: 2, title: 'x', key: 'vital:a:hr' }] });
    assert.equal(caution.duty.status, 'RESTRICTED');
    assert.equal(caution.eva.status, 'NO-GO');
  });
  test('a routine advisory such as hydration does not block EVA, but an unexplained trend does', () => {
    assert.equal(computeReadiness({ ...healthy, activeAlerts: [{ category: 'clinical', severity: 1, title: 'x', key: 'long:a:hydration' }] }).eva.status, 'GO');
    assert.equal(computeReadiness({ ...healthy, activeAlerts: [{ category: 'clinical', severity: 1, title: 'x', key: 'trend:a:spo2' }] }).eva.status, 'NO-GO');
  });
  test('medical hold, sedation and poor sleep', () => {
    assert.equal(computeReadiness({ ...healthy, hold: { reason: 'x' } }).duty.status, 'NO-GO');
    assert.equal(computeReadiness({ ...healthy, sedationActive: true, sedationWithin24h: true }).duty.status, 'RESTRICTED');
    const sedated = computeReadiness({ ...healthy, sedationWithin24h: true });
    assert.equal(sedated.duty.status, 'GO');
    assert.equal(sedated.eva.status, 'NO-GO');
    assert.equal(computeReadiness({ ...healthy, fatigue: { level: 'moderate', lastSleepH: 5 } }).eva.status, 'NO-GO');
  });
  test('symptom triage feeds readiness', () => {
    assert.equal(computeReadiness({ ...healthy, openSymptoms: [{ triage: 'emergency', label: 'x' }] }).duty.status, 'NO-GO');
    assert.equal(computeReadiness({ ...healthy, openSymptoms: [{ triage: 'urgent', label: 'x' }] }).duty.status, 'RESTRICTED');
    const routine = computeReadiness({ ...healthy, openSymptoms: [{ triage: 'routine', label: 'x' }] });
    assert.equal(routine.duty.status, 'GO');
    assert.equal(routine.eva.status, 'NO-GO');
  });
  test('radiation and atmosphere alarms block EVA', () => {
    assert.equal(computeReadiness({ ...healthy, env: { radiationAlarm: true } }).eva.status, 'NO-GO');
    assert.equal(computeReadiness({ ...healthy, env: { atmosphereAlarm: true } }).eva.status, 'NO-GO');
    assert.equal(computeReadiness({ ...healthy, dose: { pct: 96 } }).eva.status, 'NO-GO');
  });
  test('NEWS2 thresholds', () => {
    const news = (score, complete = true) => ({ valid: true, score, complete, missing: complete ? [] : ['spo2'] });
    assert.equal(computeReadiness({ ...healthy, news: news(3) }).eva.status, 'NO-GO');
    assert.equal(computeReadiness({ ...healthy, news: news(3) }).duty.status, 'GO');
    assert.equal(computeReadiness({ ...healthy, news: news(5) }).duty.status, 'RESTRICTED');
    assert.equal(computeReadiness({ ...healthy, news: news(7) }).duty.status, 'NO-GO');
    assert.equal(computeReadiness({ ...healthy, news: news(0, false) }).eva.status, 'UNKNOWN');
  });
});

describe('long-term health', () => {
  const log = (over = {}) => ({ sleepH: 8, exerciseMin: 120, waterL: 2.5, kcal: 2700, mood: 8, stress: 3, pvtLapses: 0, weightKg: 76, ...over });
  test('radiation dose status and projection', () => {
    const d = doseStatus({ cumulativeMsv: 300, avgMsvPerDay: 2, daysRemaining: 100 });
    assert.equal(d.pct, 50);
    assert.equal(d.projectedMsv, 500);
    assert.equal(d.daysToLimit, 150);
    assert.equal(doseCondition(crew, d), null);
    assert.equal(doseCondition(crew, doseStatus({ cumulativeMsv: 500, avgMsvPerDay: 2, daysRemaining: 100 })).severity, SEVERITY.ADVISORY);
    assert.equal(doseCondition(crew, doseStatus({ cumulativeMsv: 545, avgMsvPerDay: 0, daysRemaining: 0 })).severity, SEVERITY.CAUTION);
    assert.equal(doseCondition(crew, doseStatus({ cumulativeMsv: 601, avgMsvPerDay: 0, daysRemaining: 0 })).severity, SEVERITY.WARNING);
  });
  test('fatigue levels from sleep debt', () => {
    assert.equal(fatigueStatus([]).level, 'unknown');
    assert.equal(fatigueStatus([log(), log(), log()]).level, 'low');
    assert.equal(fatigueStatus([log({ sleepH: 5 }), log({ sleepH: 5 }), log({ sleepH: 5 })]).level, 'high');
    assert.equal(fatigueStatus([log({ sleepH: 4, pvtLapses: 4 }), log({ sleepH: 4, pvtLapses: 4 }), log({ sleepH: 4, pvtLapses: 4 })]).level, 'severe');
  });
  test('bone estimate rewards exercise', () => {
    const none = boneEstimate(Array(30).fill(log({ exerciseMin: 0 })));
    const full = boneEstimate(Array(30).fill(log({ exerciseMin: 120 })));
    assert.equal(none.estLossPct, 1.25);
    assert.equal(full.estLossPct, 0.625);
    assert.equal(boneEstimate([]).estLossPct, null);
  });
  test('findings detect hydration, exercise, weight, mood and stress problems', () => {
    const codes = (logs) => evaluateLongitudinal(crew, logs, 76).map((f) => f.code);
    assert.deepEqual(codes(Array(14).fill(log())), []);
    assert.ok(codes(Array(7).fill(log({ waterL: 1.5 }))).includes('hydration'));
    assert.ok(codes(Array(7).fill(log({ exerciseMin: 60 }))).includes('exercise'));
    assert.ok(codes(Array(7).fill(log({ kcal: 1500 }))).includes('nutrition'));
    assert.ok(codes(Array(7).fill(log({ weightKg: 71 }))).includes('weight'));
    assert.ok(codes(Array(7).fill(log({ stress: 8 }))).includes('stress'));
    assert.ok(codes([...Array(7).fill(log({ mood: 8 })), ...Array(7).fill(log({ mood: 6 }))]).includes('mood'));
    assert.deepEqual(codes([]), []);
  });
  test('ocular exam grades', () => {
    assert.deepEqual(evaluateOcularExam({ frisenGrade: 0, acuityChange: 0 }), []);
    assert.equal(evaluateOcularExam({ frisenGrade: 1, acuityChange: 0 })[0].severity, SEVERITY.ADVISORY);
    assert.equal(evaluateOcularExam({ frisenGrade: 3, acuityChange: 0 })[0].severity, SEVERITY.WARNING);
    assert.equal(evaluateOcularExam({ frisenGrade: 0, acuityChange: 2 })[0].severity, SEVERITY.CAUTION);
  });
});

describe('pharmacy', () => {
  const now = 1000 * 3600000;
  const med = (id, over = {}) => ({ ...FORMULARY.find((m) => m.id === id), expiresAt: now + 1e10, initialQty: 100, ...over });
  const check = (m, c = CREW_BY_ID.tanaka, history = []) => checkAdministration({ med: m, crew: c, history, now });
  const dose = (m, hoursAgo) => ({ medId: m.id, drugClass: m.drugClass, name: m.name, sedationH: m.sedationH, ts: now - hoursAgo * 3600000 });

  test('an allergy blocks the dose', () => {
    const r = check(med('amoxicillin'), CREW_BY_ID.okafor);
    assert.equal(r.allowed, false);
    assert.match(r.blocks[0], /ALLERGY/);
    assert.equal(check(med('ibuprofen'), CREW_BY_ID.silva).allowed, false);
    assert.equal(check(med('aspirin'), CREW_BY_ID.silva).allowed, false, 'allergy applies to the whole class');
  });
  test('penicillin allergy warns about cephalosporin cross-reactivity', () => {
    assert.ok(check(med('ceftriaxone'), CREW_BY_ID.okafor).warnings.some((w) => /cross-reactivity/.test(w)));
  });
  test('expired drugs are blocked, but expired emergency drugs only warn', () => {
    assert.equal(check(med('acetaminophen', { expiresAt: now - 1 })).allowed, false);
    const r = check(med('epinephrine', { expiresAt: now - 1 }));
    assert.equal(r.allowed, true);
    assert.ok(r.warnings.some((w) => /Expired/.test(w)));
  });
  test('out of stock is a hard stop', () => {
    const r = check(med('acetaminophen', { qty: 0 }));
    assert.equal(r.allowed, false);
    assert.deepEqual(r.hardStops, ['Out of stock']);
  });
  test('minimum interval and daily maximum', () => {
    const m = med('acetaminophen');
    assert.equal(check(m, crew, [dose(m, 5)]).allowed, false);
    assert.equal(check(m, crew, [dose(m, 6)]).allowed, true);
    const many = [dose(m, 23), dose(m, 17), dose(m, 12), dose(m, 7)];
    assert.ok(check(m, crew, many).blocks.some((b) => /Daily maximum/.test(b)));
  });
  test('repeat epinephrine is never blocked', () => {
    const m = med('epinephrine');
    const r = check(m, crew, [dose(m, 1 / 60)]);
    assert.equal(r.allowed, true);
    assert.ok(r.warnings.some((w) => /Too soon/.test(w)));
  });
  test('interactions and sedation warnings', () => {
    const asp = med('aspirin');
    assert.ok(check(med('ibuprofen'), crew, [dose(asp, 2)]).warnings.some((w) => /NSAID/.test(w)));
    const zol = med('zolpidem');
    assert.ok(check(med('promethazine'), crew, [dose(zol, 1)]).warnings.some((w) => /Additive sedation/.test(w)));
  });
  test('inventory flags', () => {
    assert.deepEqual(inventoryStatus(med('aspirin', { qty: 50 }), now), []);
    assert.ok(inventoryStatus(med('aspirin', { expiresAt: now }), now).includes('expired'));
    assert.ok(inventoryStatus(med('aspirin', { expiresAt: now + 86400000 }), now).includes('expiring'));
    assert.ok(inventoryStatus(med('aspirin', { qty: 5 }), now).includes('low'));
    assert.ok(inventoryStatus(med('aspirin', { qty: 0 }), now).includes('out'));
  });
});

describe('triage and protocols', () => {
  test('red flags are emergencies regardless of the reported score', () => {
    assert.equal(triageSymptom('chest-pain', 1).triage, 'emergency');
    assert.equal(triageSymptom('joint-pain-eva', 0).protocol, 'dcs');
  });
  test('urgency and severity', () => {
    assert.equal(triageSymptom('vision-change', 1).triage, 'urgent');
    assert.equal(triageSymptom('headache', 3).triage, 'routine');
    assert.equal(triageSymptom('headache', 7).triage, 'urgent');
  });
  test('unknown codes are refused', () => {
    assert.throws(() => triageSymptom('nope', 1), RangeError);
    assert.throws(() => triageSymptom('constructor', 1), RangeError);
  });
  test('every protocol referenced by rules and symptoms exists', () => {
    const ids = new Set(PROTOCOLS.map((p) => p.id));
    for (const s of Object.values(SYMPTOMS)) if (s.protocol) assert.ok(ids.has(s.protocol), s.protocol);
    assert.equal(ids.size, PROTOCOLS.length, 'protocol ids are unique');
    for (const p of PROTOCOLS) assert.ok(p.steps.length >= 3, p.id);
    for (const id of ['hypoxia', 'arrhythmia', 'hypotension-syncope', 'hyperthermia', 'fever-sepsis', 'toxic-atmosphere', 'depressurization', 'solar-particle-event', 'behavioral', 'sans', 'cardiac-arrest']) {
      assert.ok(ids.has(id), id);
    }
  });
  test('crew data is well formed', () => {
    assert.equal(new Set(CREW.map((c) => c.id)).size, CREW.length);
    for (const c of CREW) for (const p of ['hr', 'rr', 'spo2', 'sys', 'dia', 'temp']) assert.ok(Number.isFinite(c.baseline[p]));
  });
});

describe('space-ground link', () => {
  const make = (opts) => new DtnLink({ delaySec: 10, ratePerTick: 2, ...opts });
  test('bundles arrive after the one-way delay', () => {
    const link = make();
    link.send('down', 't', 1, PRIORITY.MESSAGE, 0);
    assert.deepEqual(link.tick(0), []);
    assert.deepEqual(link.tick(9999), []);
    assert.equal(link.tick(10000).length, 1);
  });
  test('loss of signal holds bundles, then sends the highest priority first', () => {
    const link = make();
    link.los = true;
    link.send('down', 'telemetry', 1, PRIORITY.TELEMETRY, 0);
    link.send('down', 'message', 2, PRIORITY.MESSAGE, 0);
    link.send('down', 'alert', 3, PRIORITY.EMERGENCY, 0);
    assert.deepEqual(link.tick(100000), []);
    link.los = false;
    link.tick(200000);
    const delivered = link.tick(210000);
    assert.deepEqual(delivered.map((b) => b.type), ['alert', 'message']);
    link.tick(211000);
    assert.equal(link.tick(221000)[0].type, 'telemetry');
  });
  test('bundles already in flight still arrive during loss of signal', () => {
    const link = make();
    link.send('down', 'x', 1, PRIORITY.MESSAGE, 0);
    link.tick(0);
    link.los = true;
    assert.equal(link.tick(10000).length, 1);
  });
  test('overflow sheds only the oldest telemetry, never alerts or messages', () => {
    const link = make({ telemetryCapacity: 2 });
    link.los = true;
    link.send('down', 'alert', 'a', PRIORITY.ALERT, 0);
    for (let i = 0; i < 5; i++) link.send('down', 'telemetry', i, PRIORITY.TELEMETRY, i);
    assert.equal(link.stats.shed, 3);
    assert.deepEqual(link.queues.down.map((b) => b.payload), ['a', 3, 4]);
  });
  test('rate limit paces backlog delivery', () => {
    const link = make();
    for (let i = 0; i < 5; i++) link.send('down', 'x', i, PRIORITY.MESSAGE, 0);
    link.tick(0);
    assert.equal(link.queues.down.length, 3);
    assert.equal(link.inFlight.down.length, 2);
  });
});
