import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, display_name TEXT, role TEXT NOT NULL, crew_id TEXT, salt TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS vitals (ts INTEGER NOT NULL, crew_id TEXT NOT NULL, hr REAL, rr REAL, spo2 REAL, sys REAL, dia REAL, temp REAL, rmssd REAL, news INTEGER, activity TEXT);
CREATE INDEX IF NOT EXISTS vitals_crew_ts ON vitals (crew_id, ts);
CREATE TABLE IF NOT EXISTS env (ts INTEGER PRIMARY KEY, co2 REAL, o2 REAL, pressure REAL, cabin_temp REAL, humidity REAL, radiation REAL);
CREATE TABLE IF NOT EXISTS alerts (id TEXT PRIMARY KEY, raised_at INTEGER NOT NULL, status TEXT NOT NULL, severity INTEGER NOT NULL, crew_id TEXT, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS alerts_status ON alerts (status, raised_at);
CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, crew_id TEXT, ts INTEGER NOT NULL, data TEXT NOT NULL, vis_onboard INTEGER NOT NULL, vis_ground INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS records_kind ON records (kind, crew_id, ts);
CREATE TABLE IF NOT EXISTS medications (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bundles (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor TEXT NOT NULL, role TEXT, action TEXT NOT NULL, target TEXT, detail TEXT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL);
`;

const GENESIS = '0'.repeat(64);

const auditHash = (r, prev) => createHash('sha256')
  .update(JSON.stringify([r.ts, r.actor, r.role, r.action, r.target, r.detail, prev]))
  .digest('hex');

export class Store {
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
    this.lastHash = this.db.prepare('SELECT hash FROM audit ORDER BY seq DESC LIMIT 1').get()?.hash ?? GENESIS;
    this.stmt = {
      kvGet: this.db.prepare('SELECT v FROM kv WHERE k = ?'),
      kvSet: this.db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
      vitals: this.db.prepare('INSERT INTO vitals (ts, crew_id, hr, rr, spo2, sys, dia, temp, rmssd, news, activity) VALUES (?,?,?,?,?,?,?,?,?,?,?)'),
      env: this.db.prepare('INSERT OR REPLACE INTO env (ts, co2, o2, pressure, cabin_temp, humidity, radiation) VALUES (?,?,?,?,?,?,?)'),
      alert: this.db.prepare(`INSERT INTO alerts (id, raised_at, status, severity, crew_id, json) VALUES (?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET status = excluded.status, severity = excluded.severity, json = excluded.json`),
      record: this.db.prepare(`INSERT INTO records (id, kind, crew_id, ts, data, vis_onboard, vis_ground) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET ts = excluded.ts, data = excluded.data, vis_onboard = excluded.vis_onboard, vis_ground = excluded.vis_ground`),
      bundleAdd: this.db.prepare('INSERT OR REPLACE INTO bundles (id, created_at, json) VALUES (?,?,?)'),
      bundleDel: this.db.prepare('DELETE FROM bundles WHERE id = ?'),
      audit: this.db.prepare('INSERT INTO audit (ts, actor, role, action, target, detail, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?)'),
    };
  }

  close() {
    this.db.close();
  }

  transaction(fn) {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  kvGet(key, fallback = null) {
    const row = this.stmt.kvGet.get(key);
    return row ? JSON.parse(row.v) : fallback;
  }

  kvSet(key, value) {
    this.stmt.kvSet.run(key, JSON.stringify(value));
  }

  // Users
  addUser(u) {
    this.db.prepare('INSERT INTO users (username, display_name, role, crew_id, salt, hash) VALUES (?,?,?,?,?,?)')
      .run(u.username, u.displayName, u.role, u.crewId, u.salt, u.hash);
  }

  getUser(username) {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) ?? null;
  }

  userCount() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  }

  // Time series
  addVitals(rows) {
    this.transaction(() => {
      for (const r of rows) this.stmt.vitals.run(r.ts, r.crewId, r.hr, r.rr, r.spo2, r.sys, r.dia, r.temp, r.rmssd, r.news, r.activity);
    });
  }

  addEnv(e) {
    this.stmt.env.run(e.ts, e.co2, e.o2, e.pressure, e.cabinTemp, e.humidity, e.radiation);
  }

  /** Averaged into at most maxPoints buckets. param must come from a server-side whitelist. */
  vitalsSeries(crewId, param, from, to, maxPoints = 400) {
    const bucket = Math.max(1, Math.ceil((to - from) / maxPoints));
    return this.db.prepare(`SELECT (ts / ?) * ? AS t, AVG(${param}) AS v, MIN(${param}) AS lo, MAX(${param}) AS hi FROM vitals
      WHERE crew_id = ? AND ts >= ? AND ts <= ? AND ${param} IS NOT NULL GROUP BY t ORDER BY t`).all(bucket, bucket, crewId, from, to);
  }

  vitalsStats(crewId, param, from, to) {
    return this.db.prepare(`SELECT MIN(${param}) AS min, AVG(${param}) AS avg, MAX(${param}) AS max, COUNT(${param}) AS n FROM vitals
      WHERE crew_id = ? AND ts >= ? AND ts <= ?`).get(crewId, from, to);
  }

  vitalsRows(crewId, from, to) {
    return this.db.prepare('SELECT ts, hr, rr, spo2, sys, dia, temp, rmssd, news, activity FROM vitals WHERE crew_id = ? AND ts >= ? AND ts <= ? ORDER BY ts').all(crewId, from, to);
  }

  envSeries(column, from, to, maxPoints = 400) {
    const bucket = Math.max(1, Math.ceil((to - from) / maxPoints));
    return this.db.prepare(`SELECT (ts / ?) * ? AS t, AVG(${column}) AS v FROM env WHERE ts >= ? AND ts <= ? GROUP BY t ORDER BY t`).all(bucket, bucket, from, to);
  }

  prune(olderThan) {
    this.db.prepare('DELETE FROM vitals WHERE ts < ?').run(olderThan);
    this.db.prepare('DELETE FROM env WHERE ts < ?').run(olderThan);
  }

  // Alerts
  saveAlert(a) {
    this.stmt.alert.run(a.id, a.raisedAt, a.status, a.severity, a.crewId, JSON.stringify(a));
  }

  openAlerts() {
    return this.db.prepare("SELECT json FROM alerts WHERE status != 'resolved'").all().map((r) => JSON.parse(r.json));
  }

  alertHistory(limit = 200) {
    return this.db.prepare('SELECT json FROM alerts ORDER BY raised_at DESC LIMIT ?').all(limit).map((r) => JSON.parse(r.json));
  }

  // Records shared between the spacecraft and ground, with per-node visibility
  saveRecord({ id, kind, crewId, ts, data, visOnboard, visGround }) {
    this.stmt.record.run(id, kind, crewId, ts, JSON.stringify(data), visOnboard ? 1 : 0, visGround ? 1 : 0);
  }

  setVisible(id, node) {
    this.db.prepare(`UPDATE records SET ${node === 'ground' ? 'vis_ground' : 'vis_onboard'} = 1 WHERE id = ?`).run(id);
  }

  getRecord(id) {
    const r = this.db.prepare('SELECT * FROM records WHERE id = ?').get(id);
    return r ? this.#mapRecord(r) : null;
  }

  #mapRecord(r) {
    return { id: r.id, kind: r.kind, crewId: r.crew_id, ts: r.ts, visOnboard: !!r.vis_onboard, visGround: !!r.vis_ground, ...JSON.parse(r.data) };
  }

  /** Newest `limit` records, returned oldest first. */
  records({ kind, crewId, node, since = 0, limit = 200 }) {
    const parts = ['kind = ?', 'ts >= ?'];
    const args = [kind, since];
    if (crewId !== undefined) {
      parts.push('crew_id IS ?');
      args.push(crewId);
    }
    if (node) parts.push(node === 'ground' ? 'vis_ground = 1' : 'vis_onboard = 1');
    const rows = this.db.prepare(`SELECT * FROM records WHERE ${parts.join(' AND ')} ORDER BY ts DESC, id DESC LIMIT ?`).all(...args, limit);
    return rows.reverse().map((r) => this.#mapRecord(r));
  }

  // Medication inventory
  saveMedication(m) {
    this.db.prepare('INSERT INTO medications (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(m.id, JSON.stringify(m));
  }

  medications() {
    return this.db.prepare('SELECT data FROM medications ORDER BY id').all().map((r) => JSON.parse(r.data));
  }

  medication(id) {
    const r = this.db.prepare('SELECT data FROM medications WHERE id = ?').get(id);
    return r ? JSON.parse(r.data) : null;
  }

  // Link custody
  persistBundle(b) {
    this.stmt.bundleAdd.run(b.id, b.createdAt, JSON.stringify(b));
  }

  removeBundle(id) {
    this.stmt.bundleDel.run(id);
  }

  pendingBundles() {
    return this.db.prepare('SELECT json FROM bundles ORDER BY created_at').all().map((r) => JSON.parse(r.json));
  }

  // Tamper-evident audit log: each entry's hash covers the previous entry's hash
  audit({ ts, actor, role = null, action, target = null, detail = null }) {
    const detailText = detail === null ? null : JSON.stringify(detail);
    const row = { ts, actor, role, action, target, detail: detailText };
    const hash = auditHash(row, this.lastHash);
    this.stmt.audit.run(ts, actor, role, action, target, detailText, this.lastHash, hash);
    this.lastHash = hash;
  }

  auditEntries(limit = 300) {
    return this.db.prepare('SELECT * FROM audit ORDER BY seq DESC LIMIT ?').all(limit)
      .map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
  }

  verifyAudit() {
    let prev = GENESIS;
    let count = 0;
    for (const row of this.db.prepare('SELECT * FROM audit ORDER BY seq').iterate()) {
      count += 1;
      if (row.prev_hash !== prev || auditHash(row, prev) !== row.hash) return { ok: false, count, brokenAt: row.seq };
      prev = row.hash;
    }
    return { ok: prev === this.lastHash, count, brokenAt: null };
  }
}
