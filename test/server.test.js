import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePassword } from '../src/auth.js';
import { USERS } from '../src/crew.js';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { MissionSystem } from '../src/system.js';

describe('HTTP API', () => {
  let store, system, server, base, creds, webRoot;
  const cookies = {};

  const call = async (path, { method = 'GET', body, as, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(as ? { Cookie: cookies[as] } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };

  const login = async (username) => {
    const r = await call('/api/login', { method: 'POST', body: { username, password: creds[username] } });
    assert.equal(r.status, 200);
    cookies[username] = r.headers.get('set-cookie').split(';')[0];
    return r;
  };

  before(async () => {
    store = new Store(':memory:');
    creds = Object.fromEntries(USERS.map((u) => [u.username, generatePassword()]));
    const directory = {
      authenticate: async (username, password) => {
        if (username === 'outage') throw new Error('network down');
        const u = USERS.find((x) => x.username === username);
        return u && creds[username] === password ? u : null;
      },
    };
    system = new MissionSystem({ store, delaySec: 1 });
    webRoot = mkdtempSync(join(tmpdir(), 'astrohealth-web-'));
    const dist = join(webRoot, 'dist');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<!doctype html>');
    writeFileSync(join(dist, 'assets', 'app.js'), 'export {};');
    writeFileSync(join(dist, 'assets', 'app.css'), 'body {}');
    writeFileSync(join(webRoot, 'secret.txt'), 'outside the web root');
    server = createApp({ system, store, ingestToken: 'device-token', staticDir: dist, directory });
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${server.address().port}`;
    for (const u of ['surgeon', 'ops', 'okafor', 'tanaka', 'moreau', 'silva']) await login(u);
  });
  after(() => {
    server.closeAllConnections();
    server.close();
    store.close();
    rmSync(webRoot, { recursive: true, force: true });
  });

  test('generated passwords are long and unique', () => {
    const list = Object.values(creds);
    assert.equal(new Set(list).size, list.length);
    assert.ok(list.every((p) => p.length >= 16));
  });
  test('a sign-in service outage is reported, not treated as a wrong password', async () => {
    const r = await call('/api/login', { method: 'POST', body: { username: 'outage', password: 'x' } });
    assert.equal(r.status, 503);
    assert.equal(store.auditEntries().some((e) => e.action === 'login.failed' && e.actor === 'outage'), false);
  });
  test('session cookies are HttpOnly and SameSite=Strict', async () => {
    const r = await call('/api/login', { method: 'POST', body: { username: 'ops', password: creds.ops } });
    assert.match(r.headers.get('set-cookie'), /HttpOnly/);
    assert.match(r.headers.get('set-cookie'), /SameSite=Strict/);
  });
  test('everything except login, health and static files requires sign-in', async () => {
    for (const path of ['/api/me', '/api/state', '/api/reference', '/api/stream', '/api/audit', '/api/pharmacy', '/api/crew/moreau/record', '/api/nope']) {
      assert.equal((await call(path)).status, 401, path);
    }
    assert.equal((await call('/api/alerts/x/ack', { method: 'POST', body: {} })).status, 401);
    assert.equal((await call('/api/health')).status, 200);
  });
  test('a forged session token is rejected', async () => {
    assert.equal((await call('/api/me', { headers: { Cookie: 'astrohealth_session=deadbeef' } })).status, 401);
  });
  test('wrong passwords fail the same way as unknown users, then lock out', async () => {
    const wrong = await call('/api/login', { method: 'POST', body: { username: 'silva', password: 'wrong' } });
    const unknown = await call('/api/login', { method: 'POST', body: { username: 'nobody', password: 'wrong' } });
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.data, unknown.data);
    for (let i = 0; i < 5; i++) await call('/api/login', { method: 'POST', body: { username: 'lockme', password: 'x' } });
    const locked = await call('/api/login', { method: 'POST', body: { username: 'lockme', password: 'x' } });
    assert.equal(locked.status, 429);
  });
  test('failed logins are audited', () => {
    assert.ok(store.auditEntries().some((e) => e.action === 'login.failed' && e.actor === 'silva'));
  });
  test('logout ends the session', async () => {
    const r = await call('/api/login', { method: 'POST', body: { username: 'ops', password: creds.ops } });
    const cookie = r.headers.get('set-cookie').split(';')[0];
    assert.equal((await call('/api/me', { headers: { Cookie: cookie } })).status, 200);
    await call('/api/logout', { method: 'POST', body: {}, headers: { Cookie: cookie } });
    assert.equal((await call('/api/me', { headers: { Cookie: cookie } })).status, 401);
  });
  test('role enforcement over HTTP', async () => {
    assert.equal((await call('/api/crew/moreau/record', { as: 'silva' })).status, 403);
    assert.equal((await call('/api/crew/moreau/record', { as: 'moreau' })).status, 200);
    assert.equal((await call('/api/crew/moreau/report', { as: 'ops' })).status, 403);
    assert.equal((await call('/api/crew/moreau/export.csv', { as: 'okafor' })).status, 403);
    assert.equal((await call('/api/audit', { as: 'moreau' })).status, 403);
    assert.equal((await call('/api/audit', { as: 'surgeon' })).status, 200);
    assert.equal((await call('/api/audit/verify', { as: 'tanaka' })).data.ok, true);
    assert.equal((await call('/api/training/scenarios', { method: 'POST', as: 'moreau', body: { type: 'spe' } })).status, 403);
    assert.equal((await call('/api/training/link', { method: 'POST', as: 'ops', body: { los: true } })).status, 403);
  });
  test('a restricted user gets no medical data from /api/state', async () => {
    const r = await call('/api/state', { as: 'ops' });
    assert.equal(r.status, 200);
    assert.equal(r.data.crew[0].vitals, undefined);
    assert.equal(r.data.node, 'ground');
  });
  test('prototype names do not crash routes', async () => {
    assert.equal((await call('/api/crew/constructor/record', { as: 'surgeon' })).status, 404);
    assert.equal((await call('/api/crew/moreau/history?param=constructor', { as: 'surgeon' })).status, 400);
    assert.equal((await call('/api/crew/moreau/history', { as: 'surgeon' })).status, 400);
    assert.equal((await call('/api/crew/moreau/limits', { method: 'POST', as: 'surgeon', body: { param: '__proto__', reason: 'x', override: { high: [1, 2, 3] } } })).status, 400);
  });
  test('malformed requests get 4xx, not 500', async () => {
    const raw = (body, type = 'application/json') => fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': type }, body });
    assert.equal((await raw('{bad')).status, 400);
    assert.equal((await raw('[1,2]')).status, 400);
    assert.equal((await raw('null')).status, 400);
    assert.equal((await raw('{}', 'text/plain')).status, 415);
    assert.equal((await raw('x'.repeat(2 * 1024 * 1024))).status, 413);
    assert.equal((await call('/api/login', { method: 'POST', body: { username: 1, password: {} } })).status, 400);
    assert.equal((await fetch(`${base}/%E0%A4%A`)).status, 400);
  });
  test('path traversal cannot reach files outside public', async () => {
    const paths = ['/../secret.txt', '/..%2fsecret.txt', '/%2e%2e/secret.txt', '/..%5csecret.txt', '/../../package.json'];
    for (const p of paths) {
      const res = await new Promise((ok, fail) => {
        import('node:http').then(({ request }) => {
          const req = request({ host: '127.0.0.1', port: server.address().port, path: p }, (r) => { r.resume(); ok(r); });
          req.on('error', fail);
          req.end();
        });
      });
      assert.equal(res.statusCode, 404, p);
    }
  });
  test('static files carry security headers', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    for (const file of ['/assets/app.js', '/assets/app.css']) assert.equal((await fetch(base + file)).status, 200, file);
  });
  test('the ingest endpoint needs the device token, and a session is no substitute', async () => {
    const body = { samples: [] };
    assert.equal((await call('/api/ingest', { method: 'POST', body })).status, 401);
    assert.equal((await call('/api/ingest', { method: 'POST', body, as: 'surgeon' })).status, 401);
    assert.equal((await call('/api/ingest', { method: 'POST', body, headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await call('/api/ingest', { method: 'POST', body, headers: { Authorization: 'Bearer device-token' } })).status, 409, 'simulator mode refuses ingest');
  });
  test('a full workflow over HTTP: symptom, alert, acknowledge', async () => {
    const report = await call('/api/crew/moreau/symptoms', { method: 'POST', as: 'moreau', body: { code: 'palpitations', severity: 4 } });
    assert.equal(report.status, 200);
    assert.equal(report.data.triage, 'urgent');
    const state = await call('/api/state', { as: 'tanaka' });
    const alert = state.data.alerts.find((a) => a.key === `symptom:${report.data.id}`);
    assert.ok(alert);
    assert.equal((await call(`/api/alerts/${alert.id}/ack`, { method: 'POST', as: 'silva', body: {} })).status, 403);
    assert.equal((await call(`/api/alerts/${alert.id}/ack`, { method: 'POST', as: 'tanaka', body: {} })).data.applied, true);
  });
  test('the live stream sends role-filtered state on each tick', async () => {
    const res = await fetch(`${base}/api/stream`, { headers: { Cookie: cookies.ops } });
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const reader = res.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    const state = JSON.parse(first.replace(/^data: /, ''));
    assert.equal(state.crew[0].vitals, undefined);
    const listeners = system.listenerCount('tick');
    assert.ok(listeners >= 1);
    system.tick(Date.now());
    const next = new TextDecoder().decode((await reader.read()).value);
    assert.match(next, /^data: /);
    await reader.cancel();
    await new Promise((ok) => setTimeout(ok, 50));
    assert.equal(system.listenerCount('tick'), listeners - 1, 'closed streams are unsubscribed');
  });
});
