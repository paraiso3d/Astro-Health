import { randomUUID } from 'node:crypto';
import { SEVERITY } from './limits.js';

/** Pass as a condition when a signal is unreadable: never clear or raise on missing data. */
export const HOLD = Symbol('hold');

const DEFAULT_PERSIST_MS = { 1: 60000, 2: 15000, 3: 5000, 4: 2000 };
const DEFAULT_CLEAR_MS = 10000;
const ESCALATE_MS = { 3: 60000, 4: 30000 };
const RECURRENCE_WINDOW_MS = 10 * 60000;

/**
 * Alarm state machine:
 * - persistence: a condition must hold for its severity's time, rejecting one-sample spikes
 * - hysteresis: an alert clears only after the condition has stayed false for clearMs
 * - latching: warning/emergency alerts stay visible until a human acknowledges them
 * - no auto-downgrade: an alert keeps its worst severity until it resolves
 * - escalation: an unacknowledged warning/emergency is escalated after a timeout
 */
export class AlertEngine {
  constructor({ onEvent = () => {} } = {}) {
    this.onEvent = onEvent;
    this.states = new Map();
    this.alerts = new Map();
    this.lastResolved = new Map();
  }

  restore(alerts) {
    for (const alert of alerts) {
      this.alerts.set(alert.id, alert);
      this.states.set(alert.key, { since: {}, clearSince: null, alert });
    }
  }

  update(key, cond, now) {
    if (cond === HOLD) return;
    let s = this.states.get(key);
    if (!s) {
      if (!cond) return;
      s = { since: {}, clearSince: null, alert: null };
      this.states.set(key, s);
    }
    if (cond) this.#onTrue(key, s, cond, now);
    else this.#onFalse(s, now, key);
  }

  #sustainedSeverity(s, cond, now) {
    for (const level of [1, 2, 3, 4]) {
      if (level > cond.severity) delete s.since[level];
      else s.since[level] ??= now;
    }
    for (const level of [4, 3, 2, 1]) {
      const since = s.since[level];
      const persist = cond.persistMs ?? DEFAULT_PERSIST_MS[level];
      if (since !== undefined && now - since >= persist) return level;
    }
    return 0;
  }

  #onTrue(key, s, cond, now) {
    s.clearSince = null;
    const sustained = this.#sustainedSeverity(s, cond, now);
    if (!s.alert) {
      if (sustained) this.#raise(key, s, cond, sustained, now);
      return;
    }
    const a = s.alert;
    a.value = cond.value ?? a.value;
    a.updatedAt = now;
    if (cond.direction === 'low' && cond.value < a.worstValue) a.worstValue = cond.value;
    if (cond.direction === 'high' && cond.value > a.worstValue) a.worstValue = cond.value;
    if (a.clearedAt) {
      a.clearedAt = null;
      this.onEvent('recurred', a);
    }
    if (sustained > a.severity) {
      a.severity = sustained;
      a.title = cond.title;
      a.message = cond.message;
      a.status = 'active';
      a.ackedBy = null;
      a.ackedAt = null;
      a.escalated = false;
      a.shelvedUntil = null;
      a.severityRaisedAt = now;
      this.onEvent('worsened', a);
    }
  }

  #onFalse(s, now, key) {
    for (const level of Object.keys(s.since)) delete s.since[level];
    const a = s.alert;
    if (!a) {
      this.states.delete(key);
      return;
    }
    s.clearSince ??= now;
    const clearMs = a.clearMs ?? DEFAULT_CLEAR_MS;
    if (now - s.clearSince < clearMs || a.clearedAt) return;
    a.clearedAt = now;
    a.updatedAt = now;
    if (a.status === 'acknowledged' || a.severity < SEVERITY.WARNING) this.#resolve(s, a, now);
    else this.onEvent('cleared', a);
  }

  #raise(key, s, cond, severity, now) {
    const previous = this.lastResolved.get(key);
    const recurring = previous && now - previous.at < RECURRENCE_WINDOW_MS;
    s.alert = {
      id: randomUUID(),
      key,
      category: cond.category,
      crewId: cond.crewId ?? null,
      param: cond.param ?? null,
      protocol: cond.protocol ?? null,
      severity,
      title: cond.title,
      message: cond.message,
      value: cond.value ?? null,
      unit: cond.unit ?? null,
      worstValue: cond.value ?? null,
      clearMs: cond.clearMs,
      raisedAt: now,
      severityRaisedAt: now,
      updatedAt: now,
      status: 'active',
      ackedBy: null,
      ackedAt: null,
      escalated: false,
      escalatedAt: null,
      clearedAt: null,
      resolvedAt: null,
      shelvedUntil: null,
      occurrences: recurring ? previous.occurrences + 1 : 1,
    };
    this.alerts.set(s.alert.id, s.alert);
    this.onEvent('raised', s.alert);
  }

  #resolve(s, a, now) {
    a.status = 'resolved';
    a.resolvedAt = now;
    a.updatedAt = now;
    this.alerts.delete(a.id);
    this.lastResolved.set(a.key, { at: now, occurrences: a.occurrences });
    this.states.delete(a.key);
    this.onEvent('resolved', a);
  }

  checkEscalations(now) {
    for (const a of this.alerts.values()) {
      const timeout = ESCALATE_MS[a.severity];
      if (timeout && a.status === 'active' && !a.escalated && now - a.severityRaisedAt >= timeout) {
        a.escalated = true;
        a.escalatedAt = now;
        a.updatedAt = now;
        this.onEvent('escalated', a);
      }
    }
  }

  acknowledge(id, by, now) {
    const a = this.alerts.get(id);
    if (!a) return null;
    if (a.status === 'active') {
      a.status = 'acknowledged';
      a.ackedBy = by;
      a.ackedAt = now;
      a.updatedAt = now;
      this.onEvent('acknowledged', a);
    }
    if (a.clearedAt) this.#resolve(this.states.get(a.key), a, now);
    return a;
  }

  /** Silences the audible tone only. Emergencies can never be shelved. */
  shelve(id, minutes, now) {
    const a = this.alerts.get(id);
    if (!a) return { error: 'not found' };
    if (a.severity >= SEVERITY.EMERGENCY) return { error: 'emergency alerts cannot be silenced' };
    a.shelvedUntil = now + minutes * 60000;
    a.updatedAt = now;
    this.onEvent('shelved', a);
    return { alert: a };
  }

  active() {
    return [...this.alerts.values()].sort((x, y) => y.severity - x.severity || y.raisedAt - x.raisedAt);
  }

  get(id) {
    return this.alerts.get(id) ?? null;
  }
}
