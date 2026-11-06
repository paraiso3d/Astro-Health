import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SupabaseDirectory, SupabaseSync, hydrateFromCloud } from '../src/cloud.js';
import { Store } from '../src/store.js';

const PK = { kv: ['k'], vitals: ['crew_id', 'ts'], env_readings: ['ts'], alerts: ['id'], records: ['id'], medications: ['id'], bundles: ['id'], audit: ['seq'] };

/** Minimal in-memory stand-in for the Supabase client, with switchable outages. */
function fakeClient() {
  const tables = Object.fromEntries(Object.keys(PK).map((t) => [t, new Map()]));
  const state = { down: false, calls: [] };
  const key = (table, row) => PK[table].map((c) => row[c]).join('|');
  const from = (table) => ({
    upsert: async (rows, options = {}) => {
      state.calls.push(['upsert', table, rows.length]);
      if (state.down) return { error: { message: 'network down' } };
      const seen = new Set();
      for (const row of rows) {
        const k = key(table, row);
        if (seen.has(k)) return { error: { message: 'ON CONFLICT DO UPDATE command cannot affect row a second time' } };
        seen.add(k);
        if (table === 'audit' && !options.ignoreDuplicates && tables.audit.has(k)) return { error: { message: 'the audit log is append-only' } };
        if (!(options.ignoreDuplicates && tables[table].has(k))) tables[table].set(k, row);
      }
      return { error: null };
    },
    delete: () => ({
      in: async (column, ids) => {
        if (state.down) return { error: { message: 'network down' } };
        for (const id of ids) tables[table].delete(String(id));
        return { error: null };
      },
      lt: async (column, cutoff) => {
        if (state.down) return { error: { message: 'network down' } };
        for (const [k, row] of tables[table]) if (row[column] < cutoff) tables[table].delete(k);
        return { error: null };
      },
    }),
    select: () => ({
      eq: (column, value) => ({
        maybeSingle: async () => ({ data: [...tables[table].values()].find((r) => r[column] === value) ?? null, error: null }),
      }),
      order: (column) => ({
        range: async (a, b) => ({ data: [...tables[table].values()].sort((x, y) => (x[column] > y[column] ? 1 : -1)).slice(a, b + 1), error: null }),
      }),
    }),
  });
  return { from, tables, state };
}

const mirrored = () => new Store(':memory:', { mirror: true });

describe('Supabase sync', () => {
  test('changes reach Supabase with the right shape', async () => {
    const store = mirrored();
    const client = fakeClient();
    const sync = new SupabaseSync({ store, client, clock: () => 1000 });
    store.kvSet('dose:a', 12.5);
    store.saveAlert({ id: 'a1', raisedAt: 5, status: 'active', severity: 3, crewId: 'x', title: 'SpO2 low' });
    store.saveRecord({ id: 'r1', kind: 'message', crewId: 'ops', ts: 9, data: { text: 'hi' }, visOnboard: true, visGround: false });
    store.saveMedication({ id: 'm1', qty: 3 });
    store.audit({ ts: 1, actor: 'a', action: 'x', detail: { n: 1 } });
    await sync.flush();
    assert.deepEqual(client.tables.kv.get('dose:a').v, 12.5);
    assert.equal(client.tables.alerts.get('a1').data.title, 'SpO2 low');
    assert.equal(client.tables.records.get('r1').vis_ground, false);
    assert.equal(client.tables.medications.get('m1').data.qty, 3);
    assert.equal(client.tables.audit.get('1').actor, 'a');
    assert.equal(sync.status().pending, 0);
    assert.equal(sync.status().lastSyncAt, 1000);
    store.close();
  });
  test('an outage loses nothing, keeps order, and reports itself', async () => {
    const store = mirrored();
    const client = fakeClient();
    const sync = new SupabaseSync({ store, client });
    client.state.down = true;
    store.kvSet('a', 1);
    store.kvSet('a', 2);
    store.audit({ ts: 1, actor: 'a', action: 'x' });
    await sync.flush();
    assert.match(sync.status().error, /network down/);
    assert.equal(sync.status().pending, 3);
    assert.equal(client.tables.kv.size, 0);
    client.state.down = false;
    await sync.flush();
    assert.equal(sync.status().error, null);
    assert.equal(sync.status().pending, 0);
    assert.equal(client.tables.kv.get('a').v, 2, 'the latest value wins');
    assert.equal(client.tables.audit.size, 1);
    store.close();
  });
  test('repeated changes to one row in a batch do not fail the upsert', async () => {
    const store = mirrored();
    const client = fakeClient();
    const sync = new SupabaseSync({ store, client });
    for (let i = 0; i < 20; i++) store.saveAlert({ id: 'a1', raisedAt: 5, status: 'active', severity: 3, crewId: 'x', n: i });
    await sync.flush();
    assert.equal(sync.status().error, null);
    assert.equal(client.tables.alerts.get('a1').data.n, 19);
    store.close();
  });
  test('resending audit rows after a lost reply does not hit the append-only rule', async () => {
    const store = mirrored();
    const client = fakeClient();
    const sync = new SupabaseSync({ store, client });
    store.audit({ ts: 1, actor: 'a', action: 'x' });
    const row = store.outboxRows(10)[0].row;
    client.tables.audit.set(String(row.seq), row);
    await sync.flush();
    assert.equal(sync.status().error, null);
    assert.equal(sync.status().pending, 0);
    store.close();
  });
  test('vitals are thinned to one per minute per person, all kept locally', async () => {
    const store = mirrored();
    const client = fakeClient();
    const sync = new SupabaseSync({ store, client, clock: () => 600000 });
    const row = (ts, crewId) => ({ ts, crewId, hr: 60, rr: 14, spo2: 98, sys: 120, dia: 80, temp: 36.7, rmssd: 30, news: 0, activity: 'work' });
    for (let t = 0; t < 600000; t += 5000) store.addVitals([row(t, 'a'), row(t, 'b')]);
    await sync.flush();
    assert.equal(client.tables.vitals.size, 20);
    assert.equal(store.vitalsRows('a', 0, 600000).length, 120);
    store.close();
  });
  test('delivered bundles are removed from Supabase too', async () => {
    const store = mirrored();
    const client = fakeClient();
    const sync = new SupabaseSync({ store, client });
    store.persistBundle({ id: 'b1', createdAt: 1, type: 'alert' });
    await sync.flush();
    assert.equal(client.tables.bundles.size, 1);
    store.removeBundle('b1');
    await sync.flush();
    assert.equal(client.tables.bundles.size, 0);
    store.close();
  });
  test('record visibility changes are sent', async () => {
    const store = mirrored();
    const client = fakeClient();
    const sync = new SupabaseSync({ store, client });
    store.saveRecord({ id: 'r1', kind: 'message', crewId: 'ops', ts: 9, data: { text: 'hi' }, visOnboard: true, visGround: false });
    store.setVisible('r1', 'ground');
    await sync.flush();
    assert.equal(client.tables.records.get('r1').vis_ground, true);
    store.close();
  });
  test('overlapping flushes do not send anything twice', async () => {
    const store = mirrored();
    const client = fakeClient();
    const sync = new SupabaseSync({ store, client });
    store.kvSet('a', 1);
    await Promise.all([sync.flush(), sync.flush(), sync.flush()]);
    assert.equal(client.state.calls.filter(([op]) => op === 'upsert').length, 1);
    store.close();
  });
  test('old telemetry is pruned from Supabase', async () => {
    const store = mirrored();
    const client = fakeClient();
    const now = 100 * 86400000;
    const sync = new SupabaseSync({ store, client, clock: () => now });
    client.tables.env_readings.set('1', { ts: 1 });
    client.tables.env_readings.set(String(now), { ts: now });
    await sync.flush();
    assert.equal(client.tables.env_readings.size, 1);
    store.close();
  });
  test('stores without mirroring queue nothing', () => {
    const store = new Store(':memory:');
    store.kvSet('a', 1);
    assert.equal(store.outboxCount(), 0);
    store.close();
  });
});

describe('restoring from Supabase', () => {
  test('a new machine gets everything back, and the audit chain still verifies', async () => {
    const source = mirrored();
    const client = fakeClient();
    const sync = new SupabaseSync({ store: source, client, clock: () => 1000 });
    source.kvSet('mission', { name: 'Meridian-1' });
    source.saveAlert({ id: 'a1', raisedAt: 5, status: 'active', severity: 3, crewId: 'x' });
    source.saveRecord({ id: 'r1', kind: 'daily', crewId: 'x', ts: 9, data: { sleepH: 7 }, visOnboard: true, visGround: true });
    source.saveMedication({ id: 'm1', qty: 3 });
    source.persistBundle({ id: 'b1', createdAt: 1, direction: 'up', type: 'command' });
    for (let i = 0; i < 5; i++) source.audit({ ts: i, actor: 'a', action: 'x', detail: { i } });
    source.addVitals([{ ts: 0, crewId: 'x', hr: 60, rr: 14, spo2: 98, sys: 120, dia: 80, temp: 36.7, rmssd: 30, news: 0, activity: 'work' }]);
    source.addEnv({ ts: 0, co2: 2, o2: 21, pressure: 101, cabinTemp: 22, humidity: 45, radiation: 75 });
    await sync.flush();

    const fresh = mirrored();
    assert.equal(await hydrateFromCloud(fresh, client), true);
    assert.deepEqual(fresh.kvGet('mission'), { name: 'Meridian-1' });
    assert.equal(fresh.openAlerts()[0].id, 'a1');
    assert.equal(fresh.getRecord('r1').sleepH, 7);
    assert.equal(fresh.medication('m1').qty, 3);
    assert.equal(fresh.pendingBundles()[0].id, 'b1');
    assert.equal(fresh.vitalsRows('x', 0, 10).length, 1);
    assert.equal(fresh.verifyAudit().ok, true);
    assert.equal(fresh.verifyAudit().count, 5);
    assert.equal(fresh.outboxCount(), 0, 'restored data is not sent back');
    fresh.audit({ ts: 9, actor: 'a', action: 'y' });
    assert.equal(fresh.verifyAudit().ok, true, 'the chain continues after a restore');
    assert.equal(fresh.outboxRows(1)[0].row.seq, 6);
    source.close();
    fresh.close();
  });
  test('an existing local copy is never overwritten', async () => {
    const client = fakeClient();
    client.tables.kv.set('mission', { k: 'mission', v: { name: 'cloud' } });
    const store = mirrored();
    store.kvSet('mission', { name: 'local' });
    assert.equal(await hydrateFromCloud(store, client), false);
    assert.equal(store.kvGet('mission').name, 'local');
    store.close();
  });
  test('an empty project starts fresh', async () => {
    const store = mirrored();
    assert.equal(await hydrateFromCloud(store, fakeClient()), false);
    store.close();
  });
});

describe('Supabase Auth directory', () => {
  test('unusual usernames are refused without calling Supabase', async () => {
    const directory = new SupabaseDirectory({ url: 'http://127.0.0.1:9', publishableKey: 'x', adminClient: null });
    assert.equal(await directory.authenticate('a@b/c', 'pw'), null);
    assert.equal(await directory.authenticate('', 'pw'), null);
  });
});
