import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SEVERITY } from '../src/clinical/limits.js';
import { CREW } from '../src/crew.js';
import { SCENARIOS } from '../src/simulator.js';
import { Store } from '../src/store.js';
import { ApiError, MissionSystem } from '../src/system.js';

const T0 = 1_800_000_000_000;
const users = {
  surgeon: { username: 'surgeon', displayName: 'Flight Surgeon', role: 'flight_surgeon', crewId: null },
  ops: { username: 'ops', displayName: 'Mission Ops', role: 'mission_ops', crewId: null },
  okafor: { username: 'okafor', displayName: 'A. Okafor', role: 'commander', crewId: 'okafor' },
  tanaka: { username: 'tanaka', displayName: 'K. Tanaka', role: 'cmo', crewId: 'tanaka' },
  moreau: { username: 'moreau', displayName: 'L. Moreau', role: 'astronaut', crewId: 'moreau' },
  silva: { username: 'silva', displayName: 'R. Silva', role: 'astronaut', crewId: 'silva' },
};

function make({ delaySec = 15, now = T0, seed = 1, dataSource = 'simulator' } = {}) {
  const store = new Store(':memory:');
  const system = new MissionSystem({ store, now, delaySec, seed, dataSource });
  const clock = { now };
  const run = (seconds) => {
    for (let i = 0; i < seconds; i++) {
      clock.now += 1000;
      system.tick(clock.now);
    }
  };
  return { store, system, run, clock };
}

const active = (system, predicate = () => true) => system.engine.active().filter(predicate);
const denies = (fn, status = 403) => assert.throws(fn, (e) => e instanceof ApiError && e.status === status);

describe('false alarm rate', () => {
  test('8 simulated hours of nominal physiology raise no clinical alarm of caution or above', () => {
    const { system, run } = make();
    const raised = [];
    system.engine.onEvent = ((orig) => (type, a) => {
      if (type === 'raised') raised.push(a);
      orig(type, a);
    })(system.engine.onEvent);
    run(8 * 3600);
    const bad = raised.filter((a) => a.severity >= SEVERITY.CAUTION && !a.key.startsWith('long:'));
    assert.deepEqual(bad.map((a) => `${a.key}: ${a.message}`), []);
  });
});

describe('training scenarios produce the expected alarms', () => {
  const crewId = 'moreau';
  const expectations = {
    hypoxia: { seconds: 240, match: (a) => a.key === `vital:${crewId}:spo2` && a.severity >= SEVERITY.WARNING },
    arrhythmia: { seconds: 120, match: (a) => a.key === `rhythm:${crewId}` || a.key === `vital:${crewId}:hr` },
    'cardiac-pause': { seconds: 400, match: (a) => a.key === `rhythm:${crewId}` && a.severity === SEVERITY.WARNING },
    syncope: { seconds: 180, match: (a) => a.key === `vital:${crewId}:sys` && a.severity >= SEVERITY.WARNING },
    fever: { seconds: 420, match: (a) => a.key === `news2:${crewId}` || a.key === `vital:${crewId}:temp` },
    'heat-stress': { seconds: 300, match: (a) => a.key === `vital:${crewId}:temp` && a.severity >= SEVERITY.WARNING },
    'sensor-dropout': { seconds: 30, match: (a) => a.key === `sensor:${crewId}:lifesigns` && a.category === 'technical' },
    'data-loss': { seconds: 30, match: (a) => a.key === `stale:${crewId}` },
    spe: { seconds: 240, match: (a) => a.key === 'env:radiation' && a.severity >= SEVERITY.WARNING },
    co2: { seconds: 240, match: (a) => a.key === 'env:co2' && a.severity >= SEVERITY.WARNING },
    depress: { seconds: 120, match: (a) => a.key === 'env:leak' },
    'cabin-heat': { seconds: 400, match: (a) => a.key === 'env:cabinTemp' && a.severity >= SEVERITY.WARNING },
  };
  test('every scenario has an expectation', () => {
    assert.deepEqual(Object.keys(expectations).sort(), Object.keys(SCENARIOS).sort());
  });
  for (const [type, { seconds, match }] of Object.entries(expectations)) {
    test(type, () => {
      const { system, run } = make();
      system.startScenario(users.surgeon, { type, crewId }, T0);
      run(seconds);
      assert.ok(active(system).some(match), `alerts were: ${active(system).map((a) => a.key).join(', ')}`);
    });
  }
  test('alerts for one person do not spill over to crewmates', () => {
    const { system, run } = make();
    system.startScenario(users.surgeon, { type: 'hypoxia', crewId }, T0);
    run(240);
    assert.equal(active(system, (a) => /^vital:/.test(a.key) && a.param === 'spo2' && a.crewId !== crewId).length, 0);
    assert.equal(active(system, (a) => a.key === 'crew:hypoxia').length, 0);
  });
  test('a cabin leak is recognised as a crew-wide event', () => {
    const { system, run } = make();
    system.startScenario(users.surgeon, { type: 'depress' }, T0);
    run(900);
    const a = active(system, (x) => x.key === 'crew:hypoxia')[0];
    assert.equal(a?.severity, SEVERITY.EMERGENCY);
  });
  test('a CO2 failure is correlated with crew breathing', () => {
    const { system, run } = make();
    system.startScenario(users.surgeon, { type: 'co2' }, T0);
    run(400);
    assert.ok(active(system, (a) => a.key === 'crew:hypercapnia').length === 1);
  });
  test('sensor dropout does not clear an active hypoxia alarm', () => {
    const { system, run, clock } = make();
    system.startScenario(users.surgeon, { type: 'hypoxia', crewId }, T0);
    run(240);
    const before = active(system, (a) => a.key === `vital:${crewId}:spo2`)[0];
    assert.ok(before);
    system.startScenario(users.surgeon, { type: 'sensor-dropout', crewId }, clock.now);
    run(120);
    const still = active(system, (a) => a.key === `vital:${crewId}:spo2`)[0];
    assert.equal(still?.id, before.id);
    assert.equal(still.clearedAt, null);
  });
  test('telemetry loss makes readiness UNKNOWN rather than GO', () => {
    const { system, run } = make();
    system.startScenario(users.surgeon, { type: 'data-loss', crewId }, T0);
    run(70);
    const c = system.stateFor(users.tanaka).crew.find((x) => x.id === crewId);
    assert.equal(c.readiness.duty.status, 'UNKNOWN');
    assert.ok(active(system, (a) => a.key === `stale:${crewId}` && a.severity === SEVERITY.WARNING).length === 1);
  });
  test('stopping a scenario lets physiology and alarms recover', () => {
    const { system, run, clock } = make();
    system.startScenario(users.surgeon, { type: 'hypoxia', crewId }, T0);
    run(240);
    const alert = active(system, (a) => a.key === `vital:${crewId}:spo2`)[0];
    system.stopScenario(users.surgeon, 'all', clock.now);
    run(300);
    system.acknowledgeAlert(users.tanaka, alert.id, clock.now);
    assert.equal(active(system, (a) => a.key === `vital:${crewId}:spo2`).length, 0);
  });
});

describe('space-ground separation', () => {
  test('the ground sees telemetry only after the light-time delay', () => {
    const { system, run, clock } = make({ delaySec: 30 });
    run(60);
    assert.ok(Math.abs(system.stateFor(users.surgeon).snapshotAgeMs - 30000) <= 2000);
    assert.equal(system.stateFor(users.tanaka).snapshotAgeMs, 0);
    assert.equal(clock.now, system.lastTickAt);
  });
  test('light-time delay alone never marks crew data as stale', () => {
    const { system, run } = make({ delaySec: 600 });
    run(700);
    const ground = system.stateFor(users.surgeon);
    assert.ok(ground.snapshotAgeMs >= 598000);
    for (const c of ground.crew) assert.ok(c.dataAgeMs < 10000, `${c.id}: ${c.dataAgeMs}`);
  });
  test('an emergency reaches on-board crew first, then the ground', () => {
    const { system, run, clock } = make({ delaySec: 20 });
    system.startScenario(users.surgeon, { type: 'hypoxia', crewId: 'moreau' }, T0);
    const isSpo2 = (a) => a.key === 'vital:moreau:spo2';
    while (!system.stateFor(users.tanaka).alerts.some(isSpo2)) run(1);
    assert.equal(system.stateFor(users.surgeon).alerts.some(isSpo2), false);
    const seenOnboard = clock.now;
    while (!system.stateFor(users.surgeon).alerts.some(isSpo2)) run(1);
    assert.ok(clock.now - seenOnboard >= 20000);
    assert.ok(clock.now - seenOnboard <= 23000);
  });
  test('ground acknowledgement takes effect only after uplink delay', () => {
    const { system, run, clock } = make({ delaySec: 10 });
    system.startScenario(users.surgeon, { type: 'hypoxia', crewId: 'moreau' }, T0);
    run(240);
    const alert = active(system, (a) => a.key === 'vital:moreau:spo2')[0];
    const result = system.acknowledgeAlert(users.surgeon, alert.id, clock.now);
    assert.equal(result.applied, false);
    assert.equal(system.engine.get(alert.id).status, 'active');
    assert.equal(system.stateFor(users.surgeon).alerts.find((a) => a.id === alert.id).ackPending, true);
    run(13);
    assert.equal(system.engine.get(alert.id).status, 'acknowledged');
    assert.equal(system.engine.get(alert.id).ackedBy, 'Flight Surgeon');
  });
  test('messages are held during loss of signal and arrive after it ends', () => {
    const { system, run, clock } = make({ delaySec: 5 });
    system.setLink(users.surgeon, { los: true }, clock.now);
    const sent = system.sendMessage(users.moreau, { channel: 'pmc:moreau', text: 'Private: headaches' }, clock.now);
    assert.equal(sent.los, true);
    run(60);
    assert.equal(system.messages(users.surgeon, 'pmc:moreau').length, 0);
    assert.equal(system.messages(users.moreau, 'pmc:moreau').length, 1);
    system.setLink(users.surgeon, { los: false }, clock.now);
    run(10);
    assert.equal(system.messages(users.surgeon, 'pmc:moreau')[0].text, 'Private: headaches');
  });
  test('the crew keeps full alerting during loss of signal', () => {
    const { system, run, clock } = make();
    system.setLink(users.surgeon, { los: true }, clock.now);
    system.startScenario(users.tanaka, { type: 'hypoxia', crewId: 'moreau' }, clock.now);
    run(240);
    assert.ok(system.stateFor(users.tanaka).alerts.some((a) => a.key === 'vital:moreau:spo2'));
    assert.equal(system.stateFor(users.surgeon).alerts.some((a) => a.key === 'vital:moreau:spo2'), false);
    assert.ok(system.stateFor(users.surgeon).snapshotAgeMs >= 230000);
  });
  test('alerts queued during LOS reach the ground ahead of the telemetry backlog', () => {
    const { system, run, clock } = make({ delaySec: 1 });
    system.setLink(users.surgeon, { los: true }, clock.now);
    system.startScenario(users.tanaka, { type: 'hypoxia', crewId: 'moreau' }, clock.now);
    run(240);
    system.setLink(users.surgeon, { los: false }, clock.now);
    run(3);
    assert.ok(system.stateFor(users.surgeon).alerts.some((a) => a.key === 'vital:moreau:spo2'));
    assert.ok(system.stateFor(users.surgeon).snapshotAgeMs > 100000, 'telemetry backlog is still catching up');
    run(120);
    assert.ok(system.stateFor(users.surgeon).snapshotAgeMs < 5000, 'backlog has drained');
  });
  test('records reach the other node only on delivery', () => {
    const { system, run, clock } = make({ delaySec: 10 });
    system.reportSymptom(users.moreau, 'moreau', { code: 'headache', severity: 3 }, clock.now);
    assert.equal(system.clinicalRecord(users.surgeon, 'moreau').symptoms.length, 0);
    assert.equal(system.clinicalRecord(users.tanaka, 'moreau').symptoms.length, 1);
    run(13);
    assert.equal(system.clinicalRecord(users.surgeon, 'moreau').symptoms.length, 1);
    system.addEncounter(users.surgeon, 'moreau', { text: 'Advised rest.' }, clock.now);
    assert.equal(system.clinicalRecord(users.tanaka, 'moreau').encounters.length, 0);
    run(13);
    assert.equal(system.clinicalRecord(users.tanaka, 'moreau').encounters[0].text, 'Advised rest.');
  });
  test('ground-set medical hold takes effect after the delay', () => {
    const { system, run, clock } = make({ delaySec: 10 });
    system.setHold(users.surgeon, 'moreau', { reason: 'Pending review' }, clock.now);
    assert.equal(system.holds.moreau, null);
    run(13);
    assert.equal(system.holds.moreau.reason, 'Pending review');
    assert.equal(system.stateFor(users.tanaka).crew.find((c) => c.id === 'moreau').readiness.duty.status, 'NO-GO');
  });
  test('ops-channel messages travelling up do not disturb clinical state', () => {
    const { system, run, clock } = make({ delaySec: 1 });
    system.sendMessage(users.ops, { channel: 'ops', text: 'Status?' }, clock.now);
    run(4);
    assert.equal(system.messages(users.tanaka, 'ops')[0].text, 'Status?');
    assert.equal(system.clinical.ops, undefined);
  });
});

describe('medical confidentiality', () => {
  const setup = () => {
    const ctx = make({ delaySec: 0 });
    ctx.system.startScenario(users.surgeon, { type: 'hypoxia', crewId: 'moreau' }, T0);
    ctx.run(240);
    return ctx;
  };
  let ctx;
  before(() => { ctx = setup(); });

  test('commander and ops see status only, with no vitals or reasons', () => {
    for (const user of [users.ops, users.okafor]) {
      const c = ctx.system.stateFor(user).crew.find((x) => x.id === 'moreau');
      assert.equal(c.medicalAccess, false);
      for (const field of ['vitals', 'news', 'dose', 'allergies', 'baseline', 'fatigue', 'hold']) assert.equal(c[field], undefined, field);
      assert.equal(c.readiness.duty.status, 'NO-GO');
      assert.equal(c.readiness.duty.reasons, undefined);
    }
  });
  test('astronauts see their own data but not a crewmate\'s', () => {
    const s = ctx.system.stateFor(users.silva);
    assert.ok(s.crew.find((c) => c.id === 'silva').vitals);
    assert.equal(s.crew.find((c) => c.id === 'moreau').vitals, undefined);
  });
  test('the medical team sees everything', () => {
    for (const user of [users.surgeon, users.tanaka]) {
      const s = ctx.system.stateFor(user);
      for (const c of s.crew) assert.ok(c.vitals, c.id);
    }
  });
  test('no leak of clinical text anywhere in restricted state', () => {
    for (const user of [users.ops, users.okafor]) {
      const text = JSON.stringify(ctx.system.stateFor(user));
      assert.doesNotMatch(text, /SpO2 low/);
      assert.doesNotMatch(text, /sulfonamide/);
    }
    assert.doesNotMatch(JSON.stringify(ctx.system.stateFor(users.silva)), /sulfonamide/);
  });
  test('command is told of a serious alert in redacted form', () => {
    const alerts = ctx.system.stateFor(users.okafor).alerts.filter((a) => a.crewId === 'moreau');
    assert.ok(alerts.length > 0);
    for (const a of alerts) {
      assert.equal(a.redacted, true);
      assert.equal(a.title, 'Medical alert');
      assert.equal(a.value, undefined);
    }
  });
  test('API reads are denied without access', () => {
    const { system } = ctx;
    for (const user of [users.ops, users.okafor, users.silva]) {
      denies(() => system.history(user, 'moreau', 'hr', 30));
      denies(() => system.longTerm(user, 'moreau'));
      denies(() => system.clinicalRecord(user, 'moreau'));
      denies(() => system.report(user, 'moreau'));
      denies(() => system.exportVitalsCsv(user, 'moreau', 24));
    }
  });
  test('a private medical conference excludes the CMO and other crew', () => {
    const { system } = ctx;
    assert.ok(system.messages(users.surgeon, 'pmc:moreau'));
    assert.ok(system.messages(users.moreau, 'pmc:moreau'));
    denies(() => system.messages(users.tanaka, 'pmc:moreau'));
    denies(() => system.messages(users.silva, 'pmc:moreau'));
    denies(() => system.messages(users.ops, 'pmc:moreau'));
    denies(() => system.sendMessage(users.silva, { channel: 'pmc:moreau', text: 'x' }));
    denies(() => system.messages(users.ops, 'unknown'));
  });
  test('reading another person\'s record is audited; reading your own is not', () => {
    const { system, store } = ctx;
    const count = () => store.auditEntries(10000).filter((e) => e.action === 'record.read').length;
    const start = count();
    system.clinicalRecord(users.moreau, 'moreau');
    assert.equal(count(), start);
    system.clinicalRecord(users.tanaka, 'moreau');
    assert.equal(count(), start + 1);
  });
  test('only permitted people can acknowledge', () => {
    const { system } = ctx;
    const emergency = active(system, (a) => a.key === 'vital:moreau:spo2')[0];
    assert.equal(emergency.severity, SEVERITY.EMERGENCY);
    assert.ok(system.stateFor(users.silva).alerts.find((a) => a.id === emergency.id).canAck, 'anyone aboard can respond to an emergency');
    denies(() => system.acknowledgeAlert(users.ops, emergency.id));
    const { id } = system.reportSymptom(users.moreau, 'moreau', { code: 'headache', severity: 2 });
    const minor = active(system, (a) => a.key === `symptom:${id}`)[0];
    denies(() => system.acknowledgeAlert(users.silva, minor.id));
    denies(() => system.acknowledgeAlert(users.okafor, minor.id));
    assert.equal(system.acknowledgeAlert(users.moreau, minor.id).applied, true);
  });
  test('write permissions', () => {
    const { system } = ctx;
    denies(() => system.saveDailyLog(users.silva, 'moreau', {}));
    denies(() => system.saveDailyLog(users.surgeon, 'moreau', {}));
    denies(() => system.reportSymptom(users.silva, 'moreau', { code: 'headache', severity: 1 }));
    denies(() => system.addEncounter(users.moreau, 'moreau', { text: 'x' }));
    denies(() => system.addOcularExam(users.surgeon, 'moreau', { frisenGrade: 0, iopMmHg: 15 }));
    denies(() => system.setHold(users.okafor, 'moreau', { reason: 'x' }));
    denies(() => system.setLimits(users.tanaka, 'moreau', { param: 'hr', reason: 'x', override: { high: [100, 120, 170] } }));
    denies(() => system.checkIn(users.surgeon, 'moreau', { avpu: 'A', onOxygen: false }));
    denies(() => system.setShelter(users.moreau, true));
    denies(() => system.setShelter(users.ops, true));
    denies(() => system.pharmacy(users.ops));
  });
  after(() => ctx.store.close());
});

describe('clinical workflows', () => {
  test('a symptom raises an alert, feeds readiness, and resolves', () => {
    const { system, run, clock } = make();
    const r = system.reportSymptom(users.moreau, 'moreau', { code: 'chest-pain', severity: 2 }, clock.now);
    assert.equal(r.triage, 'emergency');
    run(1);
    assert.equal(system.stateFor(users.moreau).crew.find((c) => c.id === 'moreau').readiness.duty.status, 'NO-GO');
    const alert = active(system, (a) => a.key === `symptom:${r.id}`)[0];
    assert.equal(alert.severity, SEVERITY.WARNING);
    assert.equal(alert.protocol, 'chest-pain');
    system.acknowledgeAlert(users.tanaka, alert.id, clock.now);
    system.resolveSymptom(users.tanaka, r.id, clock.now);
    run(1);
    assert.equal(active(system, (a) => a.key === `symptom:${r.id}`).length, 0);
    assert.notEqual(system.stateFor(users.moreau).crew.find((c) => c.id === 'moreau').readiness.duty.reasons.includes('Symptom: Chest pain or pressure'), true);
  });
  test('allergy blocks a dose until the CMO overrides with a recorded reason', () => {
    const { system, store, clock } = make();
    const body = { crewId: 'silva', medId: 'ibuprofen' };
    assert.equal(system.checkDose(users.tanaka, body, clock.now).allowed, false);
    assert.throws(() => system.administer(users.tanaka, body, clock.now), (e) => e.status === 409 && e.extra.check.blocks.length === 1);
    const qty = store.medication('ibuprofen').qty;
    const r = system.administer(users.tanaka, { ...body, overrideReason: 'Flight surgeon approved after allergy review' }, clock.now);
    assert.ok(r.ok);
    assert.equal(store.medication('ibuprofen').qty, qty - 1);
    assert.ok(store.auditEntries().some((e) => e.action === 'medication.override'));
  });
  test('an astronaut cannot override or self-give CMO-only drugs', () => {
    const { system, clock } = make();
    denies(() => system.administer(users.moreau, { crewId: 'moreau', medId: 'zolpidem' }, clock.now));
    denies(() => system.administer(users.moreau, { crewId: 'silva', medId: 'acetaminophen' }, clock.now));
    assert.throws(() => system.administer(users.silva, { crewId: 'silva', medId: 'ibuprofen', overrideReason: 'please' }, clock.now), (e) => e.status === 409);
    assert.ok(system.administer(users.moreau, { crewId: 'moreau', medId: 'acetaminophen' }, clock.now).ok);
  });
  test('any crew member can give emergency epinephrine to a crewmate', () => {
    const { system, clock } = make();
    assert.ok(system.administer(users.silva, { crewId: 'moreau', medId: 'epinephrine' }, clock.now).ok);
  });
  test('ground staff cannot record a dose; expired stock is blocked', () => {
    const { system, clock } = make();
    denies(() => system.administer(users.surgeon, { crewId: 'moreau', medId: 'acetaminophen' }, clock.now));
    assert.equal(system.checkDose(users.tanaka, { crewId: 'tanaka', medId: 'ceftriaxone' }, clock.now).blocks.some((b) => /Expired/.test(b)), true);
  });
  test('a sedating dose changes readiness', () => {
    const { system, run, clock } = make();
    system.administer(users.tanaka, { crewId: 'moreau', medId: 'promethazine' }, clock.now);
    run(1);
    const c = system.stateFor(users.tanaka).crew.find((x) => x.id === 'moreau');
    assert.equal(c.readiness.duty.status, 'RESTRICTED');
    assert.ok(c.readiness.eva.reasons.includes('Sedating medication within 24 h'));
  });
  test('daily logs are validated and update fatigue', () => {
    const { system, run, clock } = make();
    assert.throws(() => system.saveDailyLog(users.moreau, 'moreau', { sleepH: 30 }, clock.now), /sleepH/);
    assert.throws(() => system.saveDailyLog(users.moreau, 'moreau', { sleepH: 'x' }, clock.now), /sleepH/);
    system.saveDailyLog(users.moreau, 'moreau', { sleepH: 3, exerciseMin: 100, waterL: 2.5, kcal: 2300, mood: 7, stress: 3, weightKg: 60 }, clock.now);
    run(1);
    const c = system.stateFor(users.moreau).crew.find((x) => x.id === 'moreau');
    assert.equal(c.fatigue.lastSleepH, 3);
    assert.equal(c.readiness.eva.status, 'NO-GO');
  });
  test('old logs do not count as recent sleep data', () => {
    const { system, run } = make();
    run(1);
    system.lastClinicalAt = 0;
    system.tick(T0 + 5 * 86400000);
    const c = system.stateFor(users.tanaka).crew.find((x) => x.id === 'tanaka');
    assert.equal(c.fatigue.lastSleepH, null);
    assert.ok(['UNKNOWN', 'NO-GO'].includes(c.readiness.eva.status));
  });
  test('AVPU check-in feeds NEWS2 and alarms', () => {
    const { system, run, clock } = make();
    system.checkIn(users.tanaka, 'moreau', { avpu: 'U', onOxygen: true }, clock.now);
    run(1);
    const c = system.stateFor(users.tanaka).crew.find((x) => x.id === 'moreau');
    if (c.news.valid) assert.ok(c.news.score >= 5);
    assert.equal(active(system, (a) => a.key === 'avpu:moreau')[0].severity, SEVERITY.EMERGENCY);
    assert.throws(() => system.checkIn(users.tanaka, 'moreau', { avpu: 'X', onOxygen: true }, clock.now), /avpu/);
  });
  test('storm shelter reduces accumulated dose', () => {
    const open = make();
    const sheltered = make();
    sheltered.system.setShelter(users.tanaka, true, sheltered.clock.now);
    const start = open.system.dose.moreau;
    open.run(600);
    sheltered.run(600);
    const a = open.system.dose.moreau - start;
    const b = sheltered.system.dose.moreau - start;
    assert.ok(Math.abs(b / a - 0.4) < 0.02, `ratio ${b / a}`);
  });
  test('background dose rate is about 1.8 mSv/day', () => {
    const { system, run } = make();
    const start = system.dose.moreau;
    run(3600);
    const perDay = (system.dose.moreau - start) * 24;
    assert.ok(Math.abs(perDay - 1.8) < 0.1, `${perDay} mSv/day`);
  });
  test('an emergency alert cannot be silenced through the API', () => {
    const { system, run, clock } = make();
    system.checkIn(users.tanaka, 'moreau', { avpu: 'U', onOxygen: false }, clock.now);
    run(1);
    const alert = active(system, (a) => a.key === 'avpu:moreau')[0];
    assert.throws(() => system.silenceAlert(users.tanaka, alert.id, { minutes: 5, reason: 'x' }, clock.now), (e) => e.status === 409);
  });
  test('silencing needs a reason and keeps the alert active', () => {
    const { system, run, clock } = make();
    system.startScenario(users.tanaka, { type: 'syncope', crewId: 'moreau' }, clock.now);
    run(180);
    const alert = active(system, (a) => a.key === 'vital:moreau:sys')[0];
    assert.equal(alert.severity, SEVERITY.WARNING);
    assert.throws(() => system.silenceAlert(users.tanaka, alert.id, { minutes: 5 }, clock.now), /reason/);
    system.silenceAlert(users.tanaka, alert.id, { minutes: 5, reason: 'Treating patient' }, clock.now);
    const silenced = system.engine.get(alert.id);
    assert.equal(silenced.status, 'active');
    assert.equal(silenced.shelvedUntil, clock.now + 5 * 60000);
  });
  test('crew-specific limits change when alarms fire, and are audited', () => {
    const { system, run, store, clock } = make({ delaySec: 1 });
    run(5);
    system.setLimits(users.surgeon, 'moreau', { param: 'hr', override: { low: [55, 40, 30] }, reason: 'Athlete baseline' }, clock.now);
    run(4);
    assert.deepEqual(system.overrides.moreau.hr, { low: [55, 40, 30] });
    assert.ok(store.auditEntries().some((e) => e.action === 'limits.change'));
    assert.throws(() => system.setLimits(users.surgeon, 'moreau', { param: 'hr', override: { low: [30, 40, 50] }, reason: 'x' }, clock.now), /more extreme/);
    assert.throws(() => system.setLimits(users.surgeon, 'moreau', { param: 'hr', override: { low: [55, 40, 30] } }, clock.now), /reason/);
  });
  test('seeded mission demonstrates long-term findings', () => {
    const { system } = make();
    const silva = system.longTerm(users.surgeon, 'silva');
    assert.equal(silva.logs.length, 42);
    assert.ok(silva.findings.some((f) => f.code === 'mood'));
    assert.ok(system.longTerm(users.surgeon, 'moreau').findings.some((f) => f.code === 'hydration'));
  });
  test('report and CSV export contain the data and are audited', () => {
    const { system, run, store } = make();
    run(30);
    const report = system.report(users.tanaka, 'moreau');
    assert.equal(report.crew.id, 'moreau');
    assert.ok(report.vitals.hr.n > 300);
    const csv = system.exportVitalsCsv(users.tanaka, 'moreau', 24);
    const [header, first] = csv.split('\n');
    assert.equal(header, 'ts,hr,rr,spo2,sys,dia,temp,rmssd,news,activity');
    assert.equal(first.split(',').length, 10);
    assert.ok(store.auditEntries().some((e) => e.action === 'data.export'));
  });
  test('unknown crew, prototype names and bad parameters are rejected', () => {
    const { system } = make();
    denies(() => system.history(users.surgeon, 'constructor', 'hr', 30), 404);
    denies(() => system.history(users.surgeon, '__proto__', 'hr', 30), 404);
    denies(() => system.history(users.surgeon, 'moreau', 'constructor', 30), 400);
    denies(() => system.history(users.surgeon, 'moreau', 'hr; DROP TABLE vitals', 30), 400);
    denies(() => system.environmentHistory(users.surgeon, 'constructor', 30), 400);
    denies(() => system.startScenario(users.surgeon, { type: 'constructor' }), 400);
    denies(() => system.reportSymptom(users.moreau, 'moreau', { code: 'constructor', severity: 1 }), 400);
  });
});

function expectCrewDataLoss(system, clock) {
  clock.now += 6000;
  system.tick(clock.now);
  assert.equal(active(system, (a) => a.key === 'crew:dataloss').length, 1, 'several lost streams point at the network');
}

describe('device ingest', () => {
  const sample = (over = {}) => ({ crewId: 'moreau', activity: 'rest', hr: 62, rr: 14, spo2: 98, sys: 115, dia: 72, temp: 36.7, quality: { ecg: 1, resp: 1, pulseox: 1, bp: 1, temp: 1 }, ...over });

  test('real device data goes through the same clinical pipeline', () => {
    const { system, clock } = make({ dataSource: 'ingest' });
    const send = (over) => {
      clock.now += 1000;
      system.ingest({ samples: [sample(over)], env: { co2: 2, o2: 21, pressure: 101, cabinTemp: 22, humidity: 45, radiation: 75 } }, clock.now);
      system.tick(clock.now);
    };
    for (let i = 0; i < 12; i++) send({ spo2: 85 });
    assert.ok(active(system, (a) => a.key === 'vital:moreau:spo2').length === 1);
  });
  test('no data means stale alarms and UNKNOWN readiness', () => {
    const { system, clock } = make({ dataSource: 'ingest' });
    clock.now += 15000;
    system.tick(clock.now);
    assert.ok(active(system, (a) => a.key === 'stale:moreau').length === 1);
    expectCrewDataLoss(system, clock);
    assert.equal(system.stateFor(users.tanaka).crew[0].readiness.duty.status, 'UNKNOWN');
  });
  test('ingest input is validated', () => {
    const { system } = make({ dataSource: 'ingest' });
    denies(() => system.ingest({ samples: 'x' }), 400);
    denies(() => system.ingest({ env: null }), 400);
    denies(() => system.ingest({ samples: [null] }), 404);
    denies(() => system.ingest({ samples: [sample({ crewId: 'nobody' })] }), 404);
    denies(() => system.ingest({ samples: [sample({ hr: 'fast' })] }), 400);
    denies(() => system.ingest({ samples: [sample({ activity: 'dancing' })] }), 400);
  });
  test('ingest is refused in simulator mode, and scenarios in ingest mode', () => {
    denies(() => make().system.ingest({}), 409);
    denies(() => make({ dataSource: 'ingest' }).system.startScenario(users.surgeon, { type: 'spe' }), 409);
  });
});

describe('durability', () => {
  const dir = mkdtempSync(join(tmpdir(), 'astrohealth-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('alerts, dose, holds, limits, records and queued uplinks survive a restart', () => {
    const path = join(dir, 'a.db');
    let store = new Store(path);
    let system = new MissionSystem({ store, now: T0, delaySec: 5 });
    let now = T0;
    const run = (s) => { for (let i = 0; i < s; i++) { now += 1000; system.tick(now); } };
    system.startScenario(users.tanaka, { type: 'hypoxia', crewId: 'moreau' }, now);
    run(240);
    const alert = active(system, (a) => a.key === 'vital:moreau:spo2')[0];
    system.setHold(users.tanaka, 'silva', { reason: 'Back pain' }, now);
    system.setLink(users.surgeon, { los: true }, now);
    system.sendMessage(users.surgeon, { channel: 'ops', text: 'Held in custody' }, now);
    run(70);
    const dose = system.dose.moreau;
    store.close();

    store = new Store(path);
    system = new MissionSystem({ store, now, delaySec: 5 });
    assert.equal(system.mission.name, 'Meridian-1');
    assert.equal(system.engine.get(alert.id)?.key, 'vital:moreau:spo2');
    assert.equal(system.holds.silva.reason, 'Back pain');
    assert.equal(system.link.los, true);
    assert.ok(Math.abs(system.dose.moreau - dose) < 0.1);
    assert.equal(system.longTerm(users.surgeon, 'silva').logs.length, 42, 'history is not re-seeded');
    assert.equal(system.messages(users.tanaka, 'ops').length, 0);
    system.setLink(users.surgeon, { los: false }, now);
    run(10);
    assert.equal(system.messages(users.tanaka, 'ops')[0].text, 'Held in custody');
    store.close();
  });
  test('the audit chain verifies, and any tampering is detected', () => {
    const store = new Store(join(dir, 'b.db'));
    for (let i = 0; i < 20; i++) store.audit({ ts: T0 + i, actor: 'a', action: 'x', target: String(i), detail: { i } });
    assert.deepEqual(store.verifyAudit(), { ok: true, count: 20, brokenAt: null });
    store.db.prepare('UPDATE audit SET actor = ? WHERE seq = 7').run('mallory');
    assert.equal(store.verifyAudit().ok, false);
    assert.equal(store.verifyAudit().brokenAt, 7);
    store.close();
  });
  test('audit deletion is detected', () => {
    const store = new Store(join(dir, 'c.db'));
    for (let i = 0; i < 5; i++) store.audit({ ts: T0 + i, actor: 'a', action: 'x' });
    store.db.prepare('DELETE FROM audit WHERE seq = 3').run();
    assert.equal(store.verifyAudit().ok, false);
    store.close();
    const tail = new Store(join(dir, 'd.db'));
    for (let i = 0; i < 5; i++) tail.audit({ ts: T0 + i, actor: 'a', action: 'x' });
    tail.db.prepare('DELETE FROM audit WHERE seq = 5').run();
    assert.equal(tail.verifyAudit().ok, false);
    tail.close();
  });
  test('the audit chain continues correctly after a restart', () => {
    const path = join(dir, 'e.db');
    let store = new Store(path);
    store.audit({ ts: T0, actor: 'a', action: 'x' });
    store.close();
    store = new Store(path);
    store.audit({ ts: T0 + 1, actor: 'a', action: 'y' });
    assert.equal(store.verifyAudit().ok, true);
    store.close();
  });
  test('every crew member has seeded data', () => {
    const { system } = make();
    for (const c of CREW) assert.ok(system.longTerm(users.surgeon, c.id).logs.length === 42);
  });
});
