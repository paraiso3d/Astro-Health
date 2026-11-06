import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { alertViewFor, canAcknowledge, canSeeChannel, canViewMedical, channelsFor, isMedicalTeam, nodeOf } from './access.js';
import { AlertEngine } from './clinical/alertEngine.js';
import { CrewSignalState, evaluateCorrelations, evaluateEnvironment, evaluateVitals, readValid, staleCondition } from './clinical/evaluators.js';
import { SEVERITY, SEVERITY_NAME, VITALS, validateOverride } from './clinical/limits.js';
import { boneEstimate, doseCondition, doseStatus, evaluateLongitudinal, evaluateOcularExam, fatigueStatus } from './clinical/longterm.js';
import { FORMULARY, checkAdministration, inventoryStatus } from './clinical/pharmacy.js';
import { computeReadiness } from './clinical/readiness.js';
import { Trend } from './clinical/signal.js';
import { ALERT_SEVERITY_FOR_TRIAGE, triageSymptom } from './clinical/triage.js';
import { CREW, CREW_BY_ID } from './crew.js';
import { DtnLink, PRIORITY } from './link.js';
import { SCENARIOS, Simulator, generateDailyLog, mulberry32 } from './simulator.js';

const DAY = 86400000;
const HOUR = 3600000;
const SHELTER_FACTOR = 0.4;
const RETENTION_DAYS = 90;
const LONG_CODES = ['fatigue', 'hydration', 'exercise', 'nutrition', 'weight', 'mood', 'stress'];
const ACTIVITIES = new Set(['rest', 'work', 'sleep', 'exercise', 'eva']);
const ACTIVE_CLINICAL = /^(vital|news2|rhythm|avpu):/;

export class ApiError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const numberIn = (value, min, max, name) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new ApiError(400, `${name} must be a number from ${min} to ${max}`);
  }
  return value;
};

const textOf = (value, max, name, { required = true } = {}) => {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ApiError(400, `${name} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new ApiError(400, `${name} must be text`);
  const text = value.trim();
  if (required && !text) throw new ApiError(400, `${name} is required`);
  if (text.length > max) throw new ApiError(400, `${name} must be at most ${max} characters`);
  return text;
};

export class MissionSystem extends EventEmitter {
  constructor({ store, dataSource = 'simulator', seed = 1, now = Date.now(), delaySec = 15 }) {
    super();
    this.setMaxListeners(100);
    this.store = store;
    this.dataSource = dataSource;
    this.bootedAt = now;
    this.lastTickAt = now;
    this.lastPersistAt = 0;
    this.lastClinicalAt = 0;
    this.lastPruneAt = now;
    this.lastDoseSaveAt = now;

    const firstBoot = !store.kvGet('mission');
    if (firstBoot) this.#seedMission(now, seed);
    this.mission = store.kvGet('mission');

    this.engine = new AlertEngine({ onEvent: (type, alert) => this.#onAlertEvent(type, alert) });
    this.engine.restore(store.openAlerts());

    const linkConfig = store.kvGet('link', { delaySec, los: false });
    this.link = new DtnLink({
      delaySec: linkConfig.delaySec,
      onPersist: (b) => store.persistBundle(b),
      onDelivered: (b) => store.removeBundle(b.id),
    });
    this.link.los = linkConfig.los;
    this.link.restore(store.pendingBundles());

    this.signal = {};
    this.latest = {};
    this.dose = {};
    this.checkin = {};
    this.holds = {};
    this.overrides = {};
    this.clinical = {};
    const savedBaselines = store.kvGet('baselines', {});
    for (const c of CREW) {
      this.signal[c.id] = new CrewSignalState(savedBaselines[c.id] ?? {});
      this.latest[c.id] = null;
      this.dose[c.id] = store.kvGet(`dose:${c.id}`, c.priorDoseMsv);
      this.checkin[c.id] = store.kvGet(`checkin:${c.id}`, { avpu: 'A', onOxygen: false, ts: null, by: null });
      this.holds[c.id] = store.kvGet(`hold:${c.id}`, null);
      this.overrides[c.id] = store.kvGet(`limits:${c.id}`, {});
    }
    this.shelter = store.kvGet('shelter', false);
    this.env = null;
    this.pressureTrend = new Trend(60000);

    this.sim = dataSource === 'simulator' ? new Simulator(CREW, seed + 1) : null;
    if (this.sim && firstBoot) this.#backfill(now);

    for (const c of CREW) this.#refreshClinical(c.id, now);

    this.snapshot = null;
    this.ground = { snapshot: null, alerts: new Map(this.engine.active().map((a) => [a.id, a])), pendingAcks: new Set(), inventory: store.medications() };
    this.tick(now);
    this.ground.snapshot = this.snapshot;
  }

  // ---------- Seeding ----------

  #seedMission(now, seed) {
    const { store } = this;
    const elapsedDays = 42;
    const startedAt = now - elapsedDays * DAY;
    store.kvSet('mission', { name: 'Meridian-1', vehicle: 'Meridian Transit Vehicle', profile: 'Deep-space transit', startedAt, plannedDays: 300 });
    for (const med of FORMULARY) {
      const { expiryDays, ...rest } = med;
      store.saveMedication({ ...rest, initialQty: med.qty, expiresAt: now + expiryDays * DAY });
    }
    if (this.dataSource !== 'simulator') return;
    const random = mulberry32(seed);
    store.transaction(() => {
      for (const c of CREW) {
        store.kvSet(`dose:${c.id}`, c.priorDoseMsv + elapsedDays * 1.8);
        for (let day = 1; day <= elapsedDays; day++) {
          const data = generateDailyLog(c, day, elapsedDays, random);
          store.saveRecord({ id: `daily:${c.id}:${day}`, kind: 'daily', crewId: c.id, ts: startedAt + (day - 1) * DAY + 12 * HOUR, data, visOnboard: true, visGround: true });
        }
        const exam = { type: 'ocular', frisenGrade: c.id === 'tanaka' ? 1 : 0, acuityChange: 0, iopMmHg: 15, notes: 'Scheduled day-30 ocular exam.', authorName: 'K. Tanaka' };
        store.saveRecord({ id: `exam:${c.id}:30`, kind: 'exam', crewId: c.id, ts: startedAt + 29 * DAY, data: exam, visOnboard: true, visGround: true });
      }
    });
  }

  /** Runs the simulator over the past 30 minutes, so that charts and baselines start populated. */
  #backfill(now) {
    const rows = [];
    for (let t = now - 30 * 60000; t < now; t += 5000) {
      const { env, samples } = this.sim.step(t, 5);
      this.store.addEnv(env);
      for (const sample of samples) {
        const crew = CREW_BY_ID[sample.crewId];
        const state = this.signal[crew.id];
        evaluateVitals(sample, crew, state);
        rows.push(this.#vitalsRow(sample, state));
      }
    }
    this.store.addVitals(rows);
  }

  #vitalsRow(sample, state) {
    return {
      ts: sample.ts, crewId: sample.crewId,
      hr: readValid(sample, 'hr'), rr: readValid(sample, 'rr'), spo2: readValid(sample, 'spo2'),
      sys: readValid(sample, 'sys'), dia: readValid(sample, 'dia'), temp: readValid(sample, 'temp'),
      rmssd: state.lastRmssd, news: state.lastNews?.valid ? state.lastNews.score : null, activity: sample.activity,
    };
  }

  // ---------- Main loop ----------

  tick(now = Date.now()) {
    const dt = Math.min(10, Math.max(0, (now - this.lastTickAt) / 1000));
    this.lastTickAt = now;

    if (this.sim) {
      const { env, samples } = this.sim.step(now, dt || 1);
      this.env = env;
      for (const s of samples) this.latest[s.crewId] = { sample: s, receivedAt: now, evaluated: false };
    }

    this.#evaluateCrew(now);
    this.#evaluateCabin(now);
    this.#accumulateDose(dt, now);
    if (now - this.lastClinicalAt >= 30000) {
      for (const c of CREW) this.#refreshClinical(c.id, now);
      this.lastClinicalAt = now;
    }
    this.engine.checkEscalations(now);
    this.#persist(now);

    this.snapshot = this.#buildSnapshot(now);
    this.link.send('down', 'telemetry', this.snapshot, PRIORITY.TELEMETRY, now);
    for (const bundle of this.link.tick(now)) this.#applyBundle(bundle, now);

    this.emit('tick', now);
  }

  #evaluateCrew(now) {
    let lowSpo2Count = 0;
    let rrHighCount = 0;
    let staleCount = 0;
    for (const crew of CREW) {
      const entry = this.latest[crew.id];
      const age = entry ? now - entry.receivedAt : Infinity;
      this.engine.update(`stale:${crew.id}`, staleCondition(crew, age === Infinity ? now - this.bootedAt : age), now);
      if (age >= 10000) staleCount += 1;
      if (!entry) continue;
      if (!entry.evaluated) {
        entry.evaluated = true;
        const active = this.engine.active().some((a) => a.crewId === crew.id && a.severity >= SEVERITY.CAUTION && ACTIVE_CLINICAL.test(a.key));
        const results = evaluateVitals({ ...entry.sample, ts: now }, crew, this.signal[crew.id], {
          overrides: this.overrides[crew.id],
          avpu: this.checkin[crew.id].avpu,
          onOxygen: this.checkin[crew.id].onOxygen,
          hasActiveClinical: active,
        });
        for (const [key, cond] of results) this.engine.update(key, cond, now);
      }
      if (age < 10000) {
        const spo2 = readValid(entry.sample, 'spo2');
        const rr = readValid(entry.sample, 'rr');
        const exerting = entry.sample.activity === 'exercise' || entry.sample.activity === 'eva';
        if (spo2 !== null && spo2 < 94) lowSpo2Count += 1;
        if (rr !== null && rr > 24 && !exerting) rrHighCount += 1;
      }
    }
    for (const [key, cond] of evaluateCorrelations({ lowSpo2Count, rrHighCount, staleCount, co2Alarm: (this.env?.co2 ?? 0) > 3 })) {
      this.engine.update(key, cond, now);
    }
  }

  #evaluateCabin(now) {
    if (!this.env) return;
    this.pressureTrend.add(now, this.env.pressure);
    for (const [key, cond] of evaluateEnvironment(this.env, this.pressureTrend)) this.engine.update(key, cond, now);
  }

  #accumulateDose(dt, now) {
    const factor = this.shelter ? SHELTER_FACTOR : 1;
    const rate = this.env?.radiation ?? 0;
    for (const c of CREW) {
      this.dose[c.id] += (rate * factor * dt) / 3600 / 1000;
      this.engine.update(`dose:${c.id}`, doseCondition(c, this.#doseInfo(c, now)), now);
    }
    if (now - this.lastDoseSaveAt >= 60000) {
      this.lastDoseSaveAt = now;
      for (const c of CREW) this.store.kvSet(`dose:${c.id}`, this.dose[c.id]);
    }
  }

  #doseInfo(crew, now) {
    const elapsedDays = Math.max(1, (now - this.mission.startedAt) / DAY);
    const missionDose = Math.max(0, this.dose[crew.id] - crew.priorDoseMsv);
    return doseStatus({
      cumulativeMsv: this.dose[crew.id],
      avgMsvPerDay: missionDose / elapsedDays,
      daysRemaining: this.mission.plannedDays - elapsedDays,
    });
  }

  #persist(now) {
    if (now - this.lastPersistAt < 5000) return;
    this.lastPersistAt = now;
    const rows = [];
    for (const c of CREW) {
      const entry = this.latest[c.id];
      if (entry && now - entry.receivedAt < 10000) rows.push(this.#vitalsRow({ ...entry.sample, ts: now }, this.signal[c.id]));
    }
    if (rows.length) this.store.addVitals(rows);
    if (this.env) this.store.addEnv({ ...this.env, ts: now });
    if (now - this.lastPruneAt >= HOUR) {
      this.lastPruneAt = now;
      this.store.prune(now - RETENTION_DAYS * DAY);
      this.store.kvSet('baselines', Object.fromEntries(CREW.map((c) => [c.id, this.signal[c.id].serializeBaselines()])));
    }
  }

  /** Recomputes cached slow-moving clinical status for one crew member, and its alerts. */
  #refreshClinical(crewId, now) {
    const crew = CREW_BY_ID[crewId];
    const logs = this.store.records({ kind: 'daily', crewId, limit: 1000 });
    const fatigue = fatigueStatus(logs.filter((l) => now - l.ts < 3 * DAY));
    const findings = evaluateLongitudinal(crew, logs, crew.weightKg);
    const byCode = Object.fromEntries(findings.map((f) => [f.code, f]));
    for (const code of LONG_CODES) {
      const f = byCode[code];
      this.engine.update(`long:${crewId}:${code}`, f ? { category: 'clinical', crewId, severity: f.severity, title: f.title, message: `${crew.name}: ${f.message}`, persistMs: 0, clearMs: 0, protocol: code === 'mood' || code === 'stress' ? 'behavioral' : null } : null, now);
    }
    const lastExam = this.store.records({ kind: 'exam', crewId, limit: 1 }).at(-1) ?? null;
    const ocular = lastExam ? evaluateOcularExam(lastExam) : [];
    for (const [i, slot] of [0, 1].entries()) {
      const f = ocular[slot];
      this.engine.update(`ocular:${crewId}:${i}`, f ? { category: 'clinical', crewId, severity: f.severity, title: f.title, message: `${crew.name}: ${f.message}`, persistMs: 0, clearMs: 0, protocol: 'sans' } : null, now);
    }
    const doses = this.store.records({ kind: 'med_admin', crewId, since: now - DAY, limit: 100 });
    const sedationActive = doses.some((d) => d.sedationH && now - d.ts < d.sedationH * HOUR);
    const sedationWithin24h = doses.some((d) => d.sedationH);
    const openSymptoms = this.store.records({ kind: 'symptom', crewId, limit: 200 }).filter((s) => !s.resolvedAt);
    this.clinical[crewId] = { fatigue, findings, sedationActive, sedationWithin24h, openSymptoms, ocularRestricted: lastExam ? lastExam.frisenGrade >= 3 : false };
  }

  #onAlertEvent(type, alert) {
    this.store.saveAlert(alert);
    if (alert.severity >= SEVERITY.WARNING && (type === 'raised' || type === 'worsened' || type === 'escalated')) {
      this.store.audit({ ts: alert.updatedAt, actor: 'system', action: `alert.${type}`, target: alert.crewId ?? 'cabin', detail: { id: alert.id, title: alert.title, severity: SEVERITY_NAME[alert.severity] } });
    }
    const priority = alert.severity >= SEVERITY.EMERGENCY ? PRIORITY.EMERGENCY : PRIORITY.ALERT;
    this.link?.send('down', 'alert', structuredClone(alert), priority, alert.updatedAt);
  }

  #buildSnapshot(now) {
    const env = this.env ? { ...this.env } : null;
    const radiationAlarm = !!env && env.radiation > 200;
    const atmosphereAlarm = !!env && (env.co2 > 6 || env.o2 < 18 || env.pressure < 95);
    const crew = {};
    for (const c of CREW) {
      const entry = this.latest[c.id];
      const state = this.signal[c.id];
      const clinical = this.clinical[c.id];
      const sample = entry?.sample ?? null;
      const dataAgeMs = entry ? now - entry.receivedAt : null;
      const dose = this.#doseInfo(c, now);
      const vitals = {};
      if (sample) for (const p of Object.keys(VITALS)) vitals[p] = readValid(sample, p);
      const activeAlerts = this.engine.active().filter((a) => a.crewId === c.id);
      crew[c.id] = {
        vitals,
        lastSampleTs: entry?.receivedAt ?? null,
        activity: sample?.activity ?? null,
        battery: sample?.battery ?? null,
        quality: sample?.quality ?? null,
        rhythm: state.lastRhythm,
        rmssd: state.lastRmssd === null ? null : Math.round(state.lastRmssd),
        news: state.lastNews,
        dose,
        checkin: this.checkin[c.id],
        hold: this.holds[c.id],
        fatigue: clinical.fatigue,
        readiness: computeReadiness({
          news: state.lastNews, activeAlerts, fatigue: clinical.fatigue, sedationActive: clinical.sedationActive,
          sedationWithin24h: clinical.sedationWithin24h, openSymptoms: clinical.openSymptoms, dose, dataAgeMs,
          hold: this.holds[c.id], env: { radiationAlarm, atmosphereAlarm }, ocularRestricted: clinical.ocularRestricted,
        }),
      };
    }
    return { ts: now, env, shelter: this.shelter, crew };
  }

  // ---------- Space-ground link ----------

  #applyBundle(bundle, now) {
    const { type, payload } = bundle;
    if (type === 'telemetry') {
      this.ground.snapshot = payload;
    } else if (type === 'alert') {
      if (payload.status === 'resolved') this.ground.alerts.delete(payload.id);
      else this.ground.alerts.set(payload.id, payload);
      if (payload.status !== 'active') this.ground.pendingAcks.delete(payload.id);
    } else if (type === 'record') {
      this.store.setVisible(payload.id, bundle.direction === 'down' ? 'ground' : 'onboard');
      if (bundle.direction === 'up' && Object.hasOwn(CREW_BY_ID, payload.crewId ?? '')) this.#refreshClinical(payload.crewId, now);
    } else if (type === 'inventory') {
      this.ground.inventory = payload;
    } else if (type === 'command') {
      this.#executeCommand(payload, now);
    }
  }

  #addRecord(kind, crewId, data, origin, now, id = randomUUID(), priority = PRIORITY.MESSAGE) {
    this.store.saveRecord({ id, kind, crewId, ts: now, data, visOnboard: origin === 'onboard', visGround: origin === 'ground' });
    this.link.send(origin === 'onboard' ? 'down' : 'up', 'record', { id, crewId }, priority, now);
    return id;
  }

  /** Applies a command at once on board; ground commands take effect after light-time delay. */
  #dispatch(user, cmd, payload, now) {
    const command = { cmd, payload, by: user.displayName, username: user.username, role: user.role, issuedAt: now };
    if (nodeOf(user) === 'onboard') return { applied: true, ...this.#executeCommand(command, now) };
    this.link.send('up', 'command', command, PRIORITY.ALERT, now);
    this.store.audit({ ts: now, actor: user.username, role: user.role, action: `uplink.${cmd}`, target: payload.crewId ?? payload.id ?? null });
    return { applied: false, etaSec: this.link.delaySec, los: this.link.los };
  }

  #executeCommand({ cmd, payload, by, username, role }, now) {
    const audit = (action, target, detail = null) => this.store.audit({ ts: now, actor: username, role, action, target, detail });
    switch (cmd) {
      case 'ack': {
        const alert = this.engine.acknowledge(payload.id, by, now);
        if (alert) audit('alert.acknowledge', alert.crewId ?? 'cabin', { id: alert.id, title: alert.title });
        return {};
      }
      case 'shelve': {
        const result = this.engine.shelve(payload.id, payload.minutes, now);
        if (result.alert) audit('alert.silence', result.alert.crewId ?? 'cabin', { id: payload.id, minutes: payload.minutes, reason: payload.reason });
        return result.error ? { error: result.error } : {};
      }
      case 'hold': {
        const hold = payload.reason ? { reason: payload.reason, by, at: now } : null;
        this.holds[payload.crewId] = hold;
        this.store.kvSet(`hold:${payload.crewId}`, hold);
        audit(hold ? 'hold.set' : 'hold.release', payload.crewId, hold ? { reason: payload.reason } : null);
        return {};
      }
      case 'limits': {
        const limits = { ...this.overrides[payload.crewId] };
        if (payload.override) limits[payload.param] = payload.override;
        else delete limits[payload.param];
        this.overrides[payload.crewId] = limits;
        this.store.kvSet(`limits:${payload.crewId}`, limits);
        audit('limits.change', payload.crewId, { param: payload.param, override: payload.override ?? 'default', reason: payload.reason });
        return {};
      }
      case 'resolve-symptom': {
        const record = this.store.getRecord(payload.id);
        if (!record || record.kind !== 'symptom' || record.resolvedAt) return {};
        const { id, kind, crewId, ts, visOnboard, visGround, ...data } = record;
        this.store.saveRecord({ id, kind, crewId, ts, visOnboard, visGround, data: { ...data, resolvedAt: now, resolvedBy: by } });
        this.engine.update(`symptom:${id}`, null, now);
        this.#refreshClinical(crewId, now);
        audit('symptom.resolve', crewId, { id, label: data.label });
        return {};
      }
      default:
        throw new Error(`unknown command: ${cmd}`);
    }
  }

  // ---------- Read models ----------

  #crewId(id) {
    if (typeof id !== 'string' || !Object.hasOwn(CREW_BY_ID, id)) throw new ApiError(404, 'unknown crew member');
    return id;
  }

  requireMedical(user, crewId) {
    this.#crewId(crewId);
    if (!canViewMedical(user, crewId)) throw new ApiError(403, 'medical records are restricted to this crew member and the medical team');
  }

  #requireOnboard(user) {
    if (nodeOf(user) !== 'onboard') throw new ApiError(403, 'this action must be performed on board');
  }

  #selfOrCmo(user, crewId) {
    this.#crewId(crewId);
    this.#requireOnboard(user);
    if (user.crewId !== crewId && user.role !== 'cmo') throw new ApiError(403, 'only this crew member or the CMO may do this');
  }

  /** The state a given user is allowed to see, from the node where that user sits. */
  stateFor(user, now = this.lastTickAt) {
    const node = nodeOf(user);
    const snap = node === 'ground' ? this.ground.snapshot : this.snapshot;
    const list = node === 'ground'
      ? [...this.ground.alerts.values()].sort((a, b) => b.severity - a.severity || b.raisedAt - a.raisedAt)
      : this.engine.active();
    const alerts = [];
    for (const a of list) {
      const view = alertViewFor(user, a, CREW_BY_ID[a.crewId]?.name);
      if (view) {
        alerts.push({ ...view, canAck: canAcknowledge(user, a), ackPending: node === 'ground' && this.ground.pendingAcks.has(a.id) });
      }
    }
    const crew = CREW.map((c) => {
      const s = snap?.crew[c.id];
      const base = {
        id: c.id, name: c.name, role: c.role, medicalAccess: canViewMedical(user, c.id),
        readiness: s ? { duty: { status: s.readiness.duty.status }, eva: { status: s.readiness.eva.status } } : null,
        // Age at the spacecraft: light-time delay on the ground is reported by snapshotAgeMs
        dataAgeMs: s?.lastSampleTs ? snap.ts - s.lastSampleTs : null,
      };
      if (!base.medicalAccess || !s) return base;
      const { lastSampleTs, ...medical } = s;
      return { ...base, ...medical, age: c.age, sex: c.sex, bloodType: c.bloodType, allergies: c.allergies, conditions: c.conditions, baseline: c.baseline };
    });
    return {
      now,
      node,
      dataSource: this.dataSource,
      mission: { ...this.mission, day: Math.floor((now - this.mission.startedAt) / DAY) + 1 },
      link: this.link.status(),
      snapshotAgeMs: snap ? now - snap.ts : null,
      env: snap?.env ?? null,
      shelter: snap?.shelter ?? false,
      crew,
      alerts,
      scenarios: isMedicalTeam(user) ? (this.sim?.list() ?? []) : [],
    };
  }

  #horizon(node, now) {
    return node === 'ground' ? (this.ground.snapshot?.ts ?? 0) : now;
  }

  history(user, crewId, param, minutes, now = this.lastTickAt) {
    this.requireMedical(user, crewId);
    const columns = { ...Object.fromEntries(Object.keys(VITALS).map((p) => [p, p])), rmssd: 'rmssd', news: 'news' };
    const column = Object.hasOwn(columns, param ?? '') ? columns[param] : null;
    if (!column) throw new ApiError(400, 'unknown parameter');
    const range = numberIn(minutes, 1, 90 * 24 * 60, 'minutes');
    const to = this.#horizon(nodeOf(user), now);
    const crew = CREW_BY_ID[crewId];
    return { param, baseline: crew.baseline[param] ?? null, points: this.store.vitalsSeries(crewId, column, to - range * 60000, to) };
  }

  environmentHistory(user, param, minutes, now = this.lastTickAt) {
    const columns = { co2: 'co2', o2: 'o2', pressure: 'pressure', cabinTemp: 'cabin_temp', humidity: 'humidity', radiation: 'radiation' };
    const column = Object.hasOwn(columns, param ?? '') ? columns[param] : null;
    if (!column) throw new ApiError(400, 'unknown parameter');
    const range = numberIn(minutes, 1, 90 * 24 * 60, 'minutes');
    const to = this.#horizon(nodeOf(user), now);
    return { param, points: this.store.envSeries(column, to - range * 60000, to) };
  }

  longTerm(user, crewId, now = this.lastTickAt) {
    this.requireMedical(user, crewId);
    const node = nodeOf(user);
    const crew = CREW_BY_ID[crewId];
    const logs = this.store.records({ kind: 'daily', crewId, node, limit: 1000 });
    return {
      logs: logs.slice(-60),
      fatigue: fatigueStatus(logs.filter((l) => now - l.ts < 3 * DAY)),
      bone: boneEstimate(logs),
      findings: evaluateLongitudinal(crew, logs, crew.weightKg),
      exams: this.store.records({ kind: 'exam', crewId, node, limit: 50 }),
      preflightWeightKg: crew.weightKg,
      kcalTarget: crew.kcalTarget,
    };
  }

  clinicalRecord(user, crewId, now = this.lastTickAt) {
    this.requireMedical(user, crewId);
    const node = nodeOf(user);
    if (user.crewId !== crewId) this.store.audit({ ts: now, actor: user.username, role: user.role, action: 'record.read', target: crewId });
    return {
      symptoms: this.store.records({ kind: 'symptom', crewId, node, limit: 100 }),
      encounters: this.store.records({ kind: 'encounter', crewId, node, limit: 100 }),
      medications: this.store.records({ kind: 'med_admin', crewId, node, limit: 100 }),
      limits: this.overrides[crewId],
    };
  }

  report(user, crewId, now = this.lastTickAt) {
    this.requireMedical(user, crewId);
    const node = nodeOf(user);
    const crew = CREW_BY_ID[crewId];
    const horizon = this.#horizon(node, now);
    const vitals = {};
    for (const [param, meta] of Object.entries(VITALS)) {
      vitals[param] = { label: meta.label, unit: meta.unit, decimals: meta.decimals, ...this.store.vitalsStats(crewId, param, horizon - DAY, horizon) };
    }
    const snap = (node === 'ground' ? this.ground.snapshot : this.snapshot)?.crew[crewId];
    const since = now - 7 * DAY;
    this.store.audit({ ts: now, actor: user.username, role: user.role, action: 'report.generate', target: crewId });
    return {
      generatedAt: now,
      generatedBy: user.displayName,
      node,
      dataThrough: horizon,
      mission: { ...this.mission, day: Math.floor((now - this.mission.startedAt) / DAY) + 1 },
      crew: { id: crew.id, name: crew.name, role: crew.role, age: crew.age, sex: crew.sex, bloodType: crew.bloodType, allergies: crew.allergies, conditions: crew.conditions },
      readiness: snap?.readiness ?? null,
      dose: snap?.dose ?? null,
      news: snap?.news ?? null,
      vitals,
      longTerm: this.longTerm(user, crewId),
      alerts: this.store.alertHistory(1000).filter((a) => a.crewId === crewId && a.raisedAt >= since && a.raisedAt <= horizon),
      symptoms: this.store.records({ kind: 'symptom', crewId, node, since }),
      encounters: this.store.records({ kind: 'encounter', crewId, node, since }),
      medications: this.store.records({ kind: 'med_admin', crewId, node, since }),
    };
  }

  exportVitalsCsv(user, crewId, hours, now = this.lastTickAt) {
    this.requireMedical(user, crewId);
    const range = numberIn(hours, 1, 24 * 90, 'hours');
    const to = this.#horizon(nodeOf(user), now);
    const rows = this.store.vitalsRows(crewId, to - range * HOUR, to);
    this.store.audit({ ts: now, actor: user.username, role: user.role, action: 'data.export', target: crewId, detail: { hours: range, rows: rows.length } });
    const columns = ['ts', 'hr', 'rr', 'spo2', 'sys', 'dia', 'temp', 'rmssd', 'news', 'activity'];
    const lines = rows.map((r) => [new Date(r.ts).toISOString(), ...columns.slice(1).map((c) => r[c] ?? '')].join(','));
    return `${columns.join(',')}\n${lines.join('\n')}\n`;
  }

  // ---------- Crew and medical actions ----------

  saveDailyLog(user, crewId, body, now = this.lastTickAt) {
    this.#selfOrCmo(user, crewId);
    const day = Math.floor((now - this.mission.startedAt) / DAY) + 1;
    const data = {
      missionDay: day,
      sleepH: numberIn(body.sleepH, 0, 24, 'sleepH'),
      exerciseMin: numberIn(body.exerciseMin, 0, 600, 'exerciseMin'),
      waterL: numberIn(body.waterL, 0, 15, 'waterL'),
      kcal: numberIn(body.kcal, 0, 10000, 'kcal'),
      mood: numberIn(body.mood, 1, 10, 'mood'),
      stress: numberIn(body.stress, 1, 10, 'stress'),
      pvtLapses: numberIn(body.pvtLapses ?? 0, 0, 100, 'pvtLapses'),
      weightKg: numberIn(body.weightKg, 20, 250, 'weightKg'),
    };
    this.#addRecord('daily', crewId, data, 'onboard', now, `daily:${crewId}:${day}`);
    this.#refreshClinical(crewId, now);
    this.store.audit({ ts: now, actor: user.username, role: user.role, action: 'daily.log', target: crewId, detail: { missionDay: day } });
    return { ok: true, missionDay: day };
  }

  reportSymptom(user, crewId, body, now = this.lastTickAt) {
    this.#selfOrCmo(user, crewId);
    const severity = numberIn(body.severity, 0, 10, 'severity');
    let triage;
    try {
      triage = triageSymptom(body.code, severity);
    } catch (err) {
      throw new ApiError(400, err.message);
    }
    const crew = CREW_BY_ID[crewId];
    const notes = textOf(body.notes, 2000, 'notes', { required: false });
    const priority = triage.triage === 'emergency' ? PRIORITY.EMERGENCY : PRIORITY.ALERT;
    const id = this.#addRecord('symptom', crewId, { code: body.code, label: triage.label, severity, notes, triage: triage.triage, protocol: triage.protocol, reportedBy: user.displayName }, 'onboard', now, randomUUID(), priority);
    this.engine.update(`symptom:${id}`, {
      category: 'clinical', crewId, severity: ALERT_SEVERITY_FOR_TRIAGE[triage.triage], persistMs: 0, clearMs: 0, protocol: triage.protocol,
      title: `Symptom: ${triage.label}`, message: `${crew.name} reports ${triage.label.toLowerCase()} (severity ${severity}/10). Triage: ${triage.triage}.`,
    }, now);
    this.#refreshClinical(crewId, now);
    this.store.audit({ ts: now, actor: user.username, role: user.role, action: 'symptom.report', target: crewId, detail: { code: body.code, triage: triage.triage } });
    return { ok: true, id, triage: triage.triage, protocol: triage.protocol };
  }

  resolveSymptom(user, id, now = this.lastTickAt) {
    const record = this.store.getRecord(id);
    if (!record || record.kind !== 'symptom') throw new ApiError(404, 'symptom not found');
    this.requireMedical(user, record.crewId);
    return this.#dispatch(user, 'resolve-symptom', { id, crewId: record.crewId }, now);
  }

  addEncounter(user, crewId, body, now = this.lastTickAt) {
    this.#crewId(crewId);
    if (!isMedicalTeam(user)) throw new ApiError(403, 'only the medical team may write clinical notes');
    const data = { type: textOf(body.type ?? 'Note', 40, 'type'), text: textOf(body.text, 5000, 'text'), authorName: user.displayName, authorRole: user.role };
    const id = this.#addRecord('encounter', crewId, data, nodeOf(user), now);
    this.store.audit({ ts: now, actor: user.username, role: user.role, action: 'encounter.add', target: crewId });
    return { ok: true, id };
  }

  addOcularExam(user, crewId, body, now = this.lastTickAt) {
    this.#crewId(crewId);
    if (user.role !== 'cmo') throw new ApiError(403, 'exams are recorded by the CMO on board');
    const frisenGrade = numberIn(body.frisenGrade, 0, 5, 'frisenGrade');
    if (!Number.isInteger(frisenGrade)) throw new ApiError(400, 'frisenGrade must be a whole number');
    const data = {
      type: 'ocular', frisenGrade,
      acuityChange: numberIn(body.acuityChange ?? 0, 0, 10, 'acuityChange'),
      iopMmHg: numberIn(body.iopMmHg, 1, 80, 'iopMmHg'),
      notes: textOf(body.notes, 2000, 'notes', { required: false }),
      authorName: user.displayName,
    };
    const id = this.#addRecord('exam', crewId, data, 'onboard', now);
    this.#refreshClinical(crewId, now);
    this.store.audit({ ts: now, actor: user.username, role: user.role, action: 'exam.add', target: crewId, detail: { frisenGrade } });
    return { ok: true, id };
  }

  checkIn(user, crewId, body, now = this.lastTickAt) {
    this.#selfOrCmo(user, crewId);
    if (!['A', 'C', 'V', 'P', 'U'].includes(body.avpu)) throw new ApiError(400, 'avpu must be one of A, C, V, P, U');
    if (typeof body.onOxygen !== 'boolean') throw new ApiError(400, 'onOxygen must be true or false');
    const checkin = { avpu: body.avpu, onOxygen: body.onOxygen, ts: now, by: user.displayName };
    this.checkin[crewId] = checkin;
    this.store.kvSet(`checkin:${crewId}`, checkin);
    this.store.audit({ ts: now, actor: user.username, role: user.role, action: 'checkin', target: crewId, detail: { avpu: body.avpu, onOxygen: body.onOxygen } });
    return { ok: true };
  }

  setHold(user, crewId, body, now = this.lastTickAt) {
    this.#crewId(crewId);
    if (!isMedicalTeam(user)) throw new ApiError(403, 'only the medical team may set a medical hold');
    const reason = body.release ? null : textOf(body.reason, 300, 'reason');
    return this.#dispatch(user, 'hold', { crewId, reason }, now);
  }

  setLimits(user, crewId, body, now = this.lastTickAt) {
    this.#crewId(crewId);
    if (user.role !== 'flight_surgeon') throw new ApiError(403, 'only the flight surgeon may change alarm limits');
    const reason = textOf(body.reason, 300, 'reason');
    if (body.override) {
      const error = validateOverride(body.param, body.override);
      if (error) throw new ApiError(400, error);
    } else if (!Object.hasOwn(VITALS, body.param ?? '')) {
      throw new ApiError(400, 'unknown parameter');
    }
    return this.#dispatch(user, 'limits', { crewId, param: body.param, override: body.override ?? null, reason }, now);
  }

  acknowledgeAlert(user, id, now = this.lastTickAt) {
    const alert = this.#findAlert(user, id);
    if (!canAcknowledge(user, alert)) throw new ApiError(403, 'you may not acknowledge this alert');
    if (nodeOf(user) === 'ground') this.ground.pendingAcks.add(id);
    return this.#dispatch(user, 'ack', { id }, now);
  }

  silenceAlert(user, id, body, now = this.lastTickAt) {
    const alert = this.#findAlert(user, id);
    if (!canAcknowledge(user, alert)) throw new ApiError(403, 'you may not silence this alert');
    if (alert.severity >= SEVERITY.EMERGENCY) throw new ApiError(409, 'emergency alerts cannot be silenced');
    const minutes = numberIn(body.minutes, 1, 60, 'minutes');
    const reason = textOf(body.reason, 300, 'reason');
    const result = this.#dispatch(user, 'shelve', { id, minutes, reason }, now);
    if (result.error) throw new ApiError(409, result.error);
    return result;
  }

  #findAlert(user, id) {
    const alert = nodeOf(user) === 'ground' ? this.ground.alerts.get(id) : this.engine.get(id);
    if (!alert) throw new ApiError(404, 'alert not found or already resolved');
    return alert;
  }

  alertHistory(user, limit = 200) {
    const node = nodeOf(user);
    return this.store.alertHistory(limit)
      .map((a) => alertViewFor(user, a, CREW_BY_ID[a.crewId]?.name))
      .filter((a) => a && (node === 'onboard' || a.raisedAt <= this.#horizon('ground')));
  }

  setShelter(user, on, now = this.lastTickAt) {
    this.#requireOnboard(user);
    if (user.role !== 'cmo' && user.role !== 'commander') throw new ApiError(403, 'only the commander or CMO may set shelter status');
    if (typeof on !== 'boolean') throw new ApiError(400, 'on must be true or false');
    this.shelter = on;
    this.store.kvSet('shelter', on);
    this.store.audit({ ts: now, actor: user.username, role: user.role, action: 'shelter.set', target: 'crew', detail: { on } });
    return { ok: true };
  }

  // ---------- Pharmacy ----------

  #medHistory(crewId, now) {
    return this.store.records({ kind: 'med_admin', crewId, since: now - 2 * DAY, limit: 200 });
  }

  pharmacy(user, now = this.lastTickAt) {
    if (user.role === 'astronaut' || user.role === 'commander' || user.role === 'cmo' || user.role === 'flight_surgeon') {
      const list = nodeOf(user) === 'ground' ? this.ground.inventory : this.store.medications();
      return { inventory: list.map((m) => ({ ...m, flags: inventoryStatus(m, now) })) };
    }
    throw new ApiError(403, 'pharmacy data is restricted to crew and the medical team');
  }

  #checkDose(user, body, now) {
    this.#crewId(body.crewId);
    this.#requireOnboard(user);
    const med = this.store.medication(body.medId);
    if (!med) throw new ApiError(404, 'medication not found');
    if (user.role !== 'cmo' && !med.emergency) {
      if (user.crewId !== body.crewId) throw new ApiError(403, 'only the CMO may give medication to another crew member, except emergency drugs');
      if (!med.selfAdmin) throw new ApiError(403, 'this medication must be given by the CMO');
    }
    const crew = CREW_BY_ID[body.crewId];
    return { med, crew, result: checkAdministration({ med, crew, history: this.#medHistory(body.crewId, now), now }) };
  }

  checkDose(user, body, now = this.lastTickAt) {
    return this.#checkDose(user, body, now).result;
  }

  administer(user, body, now = this.lastTickAt) {
    const { med, crew, result } = this.#checkDose(user, body, now);
    if (result.hardStops.length) throw new ApiError(409, result.hardStops.join('; '), { check: result });
    const overrideReason = textOf(body.overrideReason, 300, 'overrideReason', { required: false });
    if (result.blocks.length) {
      if (user.role !== 'cmo') throw new ApiError(409, 'safety check failed; contact the CMO', { check: result });
      if (!overrideReason) throw new ApiError(409, 'safety check failed; a recorded reason is required to override', { check: result });
    }
    const updated = { ...med, qty: med.qty - 1 };
    this.store.saveMedication(updated);
    const data = {
      medId: med.id, name: med.name, dose: med.dose, drugClass: med.drugClass, sedationH: med.sedationH ?? null,
      givenBy: user.displayName, indication: textOf(body.indication, 300, 'indication', { required: false }),
      overrideReason: overrideReason || null, overriddenBlocks: overrideReason ? result.blocks : [],
    };
    const id = this.#addRecord('med_admin', crew.id, data, 'onboard', now);
    this.link.send('down', 'inventory', this.store.medications(), PRIORITY.MESSAGE, now);
    this.#refreshClinical(crew.id, now);
    this.store.audit({ ts: now, actor: user.username, role: user.role, action: overrideReason && result.blocks.length ? 'medication.override' : 'medication.give', target: crew.id, detail: { med: med.id, overrideReason: overrideReason || null, blocks: result.blocks } });
    return { ok: true, id, warnings: result.warnings };
  }

  // ---------- Messages ----------

  channels(user) {
    return channelsFor(user, CREW);
  }

  messages(user, channel) {
    if (typeof channel !== 'string' || !canSeeChannel(user, channel)) throw new ApiError(403, 'you may not read this channel');
    const node = nodeOf(user);
    return this.store.records({ kind: 'message', crewId: channel, limit: 200 })
      .filter((m) => (node === 'ground' ? m.visGround : m.visOnboard))
      .map((m) => ({ ...m, inTransit: !(m.visGround && m.visOnboard) }));
  }

  sendMessage(user, body, now = this.lastTickAt) {
    if (typeof body.channel !== 'string' || !canSeeChannel(user, body.channel)) throw new ApiError(403, 'you may not post to this channel');
    const urgent = body.urgent === true;
    const data = { text: textOf(body.text, 4000, 'text'), from: user.displayName, fromRole: user.role, urgent };
    const id = this.#addRecord('message', body.channel, data, nodeOf(user), now, randomUUID(), urgent ? PRIORITY.ALERT : PRIORITY.MESSAGE);
    this.store.audit({ ts: now, actor: user.username, role: user.role, action: 'message.send', target: body.channel, detail: { urgent } });
    return { ok: true, id, etaSec: this.link.delaySec, los: this.link.los };
  }

  // ---------- Training controls and data ingest ----------

  scenarioCatalog() {
    return SCENARIOS;
  }

  startScenario(user, body, now = this.lastTickAt) {
    if (!this.sim) throw new ApiError(409, 'training scenarios require simulator mode');
    if (!Object.hasOwn(SCENARIOS, body.type ?? '')) throw new ApiError(400, 'unknown scenario');
    if (SCENARIOS[body.type].scope === 'crew') this.#crewId(body.crewId);
    const scenario = this.sim.start(body.type, body.crewId, now);
    this.store.audit({ ts: now, actor: user.username, role: user.role, action: 'training.start', target: scenario.id });
    return scenario;
  }

  stopScenario(user, id, now = this.lastTickAt) {
    if (!this.sim) throw new ApiError(409, 'training scenarios require simulator mode');
    if (id === 'all') {
      for (const s of this.sim.list()) this.sim.stop(s.id);
    } else if (!this.sim.stop(id)) {
      throw new ApiError(404, 'scenario is not running');
    }
    this.store.audit({ ts: now, actor: user.username, role: user.role, action: 'training.stop', target: id });
    return { ok: true };
  }

  setLink(user, body, now = this.lastTickAt) {
    if (body.delaySec !== undefined) this.link.delaySec = numberIn(body.delaySec, 0, 3000, 'delaySec');
    if (body.los !== undefined) {
      if (typeof body.los !== 'boolean') throw new ApiError(400, 'los must be true or false');
      this.link.los = body.los;
    }
    this.store.kvSet('link', { delaySec: this.link.delaySec, los: this.link.los });
    this.store.audit({ ts: now, actor: user.username, role: user.role, action: 'link.configure', target: 'link', detail: { delaySec: this.link.delaySec, los: this.link.los } });
    return this.link.status();
  }

  /** Real wearable and life-support feeds enter here, through the same clinical pipeline. */
  ingest(body, now = this.lastTickAt) {
    if (this.sim) throw new ApiError(409, 'server is in simulator mode; start with DATA_SOURCE=ingest');
    let accepted = 0;
    if (body.samples !== undefined && !Array.isArray(body.samples)) throw new ApiError(400, 'samples must be a list');
    if (body.env !== undefined) {
      if (body.env === null || typeof body.env !== 'object') throw new ApiError(400, 'env must be an object');
      const env = { ts: now };
      for (const key of ['co2', 'o2', 'pressure', 'cabinTemp', 'humidity', 'radiation']) {
        env[key] = body.env[key] === null || body.env[key] === undefined ? (this.env?.[key] ?? null) : numberIn(body.env[key], -50, 100000, key);
      }
      this.env = env;
      accepted += 1;
    }
    for (const raw of body.samples ?? []) {
      this.#crewId(raw?.crewId);
      const activity = raw.activity ?? 'work';
      if (!ACTIVITIES.has(activity)) throw new ApiError(400, 'unknown activity');
      const sample = { ts: now, crewId: raw.crewId, activity, source: 'device', quality: {}, intervals: [] };
      for (const p of Object.keys(VITALS)) sample[p] = raw[p] === null || raw[p] === undefined ? null : numberIn(raw[p], -1000, 1000, p);
      for (const sensor of ['ecg', 'resp', 'pulseox', 'bp', 'temp']) sample.quality[sensor] = numberIn(raw.quality?.[sensor] ?? 0, 0, 1, `quality.${sensor}`);
      if (Array.isArray(raw.intervals)) sample.intervals = raw.intervals.slice(0, 600).map((v) => numberIn(v, 100, 60000, 'interval'));
      sample.battery = raw.battery === undefined || raw.battery === null ? null : numberIn(raw.battery, 0, 100, 'battery');
      this.latest[raw.crewId] = { sample, receivedAt: now, evaluated: false };
      accepted += 1;
    }
    return { ok: true, accepted };
  }

  health(now = Date.now()) {
    const lastTickAgeMs = now - this.lastTickAt;
    return { status: lastTickAgeMs < 5000 ? 'ok' : 'degraded', lastTickAgeMs, uptimeSec: Math.round((now - this.bootedAt) / 1000), dataSource: this.dataSource };
  }
}
