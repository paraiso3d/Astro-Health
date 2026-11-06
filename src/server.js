import { timingSafeEqual } from 'node:crypto';
import { chmodSync, createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canAudit, canRunTraining } from './access.js';
import { Auth, generatePassword, hashPassword } from './auth.js';
import { ENV_PARAMS, SEVERITY_NAME, VITALS } from './clinical/limits.js';
import { FORMULARY } from './clinical/pharmacy.js';
import { PROTOCOLS } from './clinical/protocols.js';
import { SYMPTOMS } from './clinical/triage.js';
import { USERS } from './crew.js';
import { LINK_PRESETS } from './link.js';
import { Store } from './store.js';
import { ApiError, MissionSystem } from './system.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');
const MAX_BODY = 1024 * 1024;
const COOKIE = 'astrohealth_session';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

const json = (res, status, body) => {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

const readJson = (req) => new Promise((ok, fail) => {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
    fail(new ApiError(415, 'content type must be application/json'));
    req.resume();
    return;
  }
  const chunks = [];
  let size = 0;
  let tooBig = false;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY) tooBig = true;
    else chunks.push(chunk);
  });
  req.on('end', () => {
    if (tooBig) return fail(new ApiError(413, 'request body too large'));
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (body === null || typeof body !== 'object' || Array.isArray(body)) return fail(new ApiError(400, 'body must be a JSON object'));
      ok(body);
    } catch {
      fail(new ApiError(400, 'invalid JSON'));
    }
  });
  req.on('error', fail);
});

const readCookie = (req, name) => {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === name) return v;
  }
  return null;
};

const requireRole = (condition) => {
  if (!condition) throw new ApiError(403, 'your role does not permit this');
};

/** Builds the HTTP server. Authentication is checked for every route except login, health and device ingest. */
export function createApp({ system, store, ingestToken = null, clock = Date.now }) {
  const auth = new Auth(store, clock);

  const routes = [
    ['GET', /^\/api\/me$/, (c) => ({ user: c.user })],
    ['GET', /^\/api\/state$/, (c) => system.stateFor(c.user)],
    ['GET', /^\/api\/reference$/, () => ({
      vitals: VITALS, envParams: ENV_PARAMS, severities: SEVERITY_NAME, protocols: PROTOCOLS, symptoms: SYMPTOMS,
      linkPresets: LINK_PRESETS, scenarios: system.scenarioCatalog(), formularyCount: FORMULARY.length,
    })],

    ['GET', /^\/api\/crew\/([\w-]+)\/history$/, (c, id) => system.history(c.user, id, c.query.get('param'), Number(c.query.get('minutes') ?? 30))],
    ['GET', /^\/api\/crew\/([\w-]+)\/longterm$/, (c, id) => system.longTerm(c.user, id)],
    ['GET', /^\/api\/crew\/([\w-]+)\/record$/, (c, id) => system.clinicalRecord(c.user, id)],
    ['GET', /^\/api\/crew\/([\w-]+)\/report$/, (c, id) => system.report(c.user, id)],
    ['POST', /^\/api\/crew\/([\w-]+)\/daily$/, (c, id) => system.saveDailyLog(c.user, id, c.body)],
    ['POST', /^\/api\/crew\/([\w-]+)\/symptoms$/, (c, id) => system.reportSymptom(c.user, id, c.body)],
    ['POST', /^\/api\/crew\/([\w-]+)\/encounters$/, (c, id) => system.addEncounter(c.user, id, c.body)],
    ['POST', /^\/api\/crew\/([\w-]+)\/exams$/, (c, id) => system.addOcularExam(c.user, id, c.body)],
    ['POST', /^\/api\/crew\/([\w-]+)\/checkin$/, (c, id) => system.checkIn(c.user, id, c.body)],
    ['POST', /^\/api\/crew\/([\w-]+)\/hold$/, (c, id) => system.setHold(c.user, id, c.body)],
    ['POST', /^\/api\/crew\/([\w-]+)\/limits$/, (c, id) => system.setLimits(c.user, id, c.body)],
    ['POST', /^\/api\/symptoms\/([\w-]+)\/resolve$/, (c, id) => system.resolveSymptom(c.user, id)],

    ['GET', /^\/api\/alerts\/history$/, (c) => system.alertHistory(c.user)],
    ['POST', /^\/api\/alerts\/([\w-]+)\/ack$/, (c, id) => system.acknowledgeAlert(c.user, id)],
    ['POST', /^\/api\/alerts\/([\w-]+)\/silence$/, (c, id) => system.silenceAlert(c.user, id, c.body)],

    ['GET', /^\/api\/environment\/history$/, (c) => system.environmentHistory(c.user, c.query.get('param'), Number(c.query.get('minutes') ?? 30))],
    ['POST', /^\/api\/environment\/shelter$/, (c) => system.setShelter(c.user, c.body.on)],

    ['GET', /^\/api\/pharmacy$/, (c) => system.pharmacy(c.user)],
    ['POST', /^\/api\/pharmacy\/check$/, (c) => system.checkDose(c.user, c.body)],
    ['POST', /^\/api\/pharmacy\/administer$/, (c) => system.administer(c.user, c.body)],

    ['GET', /^\/api\/channels$/, (c) => system.channels(c.user)],
    ['GET', /^\/api\/messages$/, (c) => system.messages(c.user, c.query.get('channel'))],
    ['POST', /^\/api\/messages$/, (c) => system.sendMessage(c.user, c.body)],

    ['POST', /^\/api\/training\/scenarios$/, (c) => { requireRole(canRunTraining(c.user)); return system.startScenario(c.user, c.body); }],
    ['POST', /^\/api\/training\/scenarios\/stop$/, (c) => { requireRole(canRunTraining(c.user)); return system.stopScenario(c.user, c.body.id); }],
    ['POST', /^\/api\/training\/link$/, (c) => { requireRole(canRunTraining(c.user)); return system.setLink(c.user, c.body); }],

    ['GET', /^\/api\/audit$/, (c) => { requireRole(canAudit(c.user)); return store.auditEntries(); }],
    ['GET', /^\/api\/audit\/verify$/, (c) => { requireRole(canAudit(c.user)); return store.verifyAudit(); }],
  ];

  const stream = (req, res, user, token) => {
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
    const push = () => {
      if (!auth.userFor(token)) {
        res.write('event: expired\ndata: {}\n\n');
        res.end();
        return;
      }
      res.write(`data: ${JSON.stringify(system.stateFor(user))}\n\n`);
    };
    push();
    system.on('tick', push);
    const stop = () => system.off('tick', push);
    req.on('close', stop);
    res.on('close', stop);
  };

  const serveStatic = (res, pathname) => {
    const requested = pathname === '/' ? '/index.html' : pathname;
    const file = resolve(PUBLIC_DIR, `.${normalize(decodeURIComponent(requested))}`);
    if (!file.startsWith(PUBLIC_DIR + sep) || !existsSync(file) || !statSync(file).isFile()) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  };

  const validIngestToken = (req) => {
    const given = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    const expected = Buffer.from(ingestToken ?? '');
    return ingestToken && given.length === expected.length && timingSafeEqual(given, expected);
  };

  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;

    if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, system.health(clock()));

    if (req.method === 'POST' && pathname === '/api/ingest') {
      if (!validIngestToken(req)) throw new ApiError(401, 'invalid device token');
      return json(res, 200, system.ingest(await readJson(req)));
    }

    if (req.method === 'POST' && pathname === '/api/login') {
      const body = await readJson(req);
      const result = auth.login(body.username, body.password);
      if (result.error) return json(res, result.status, { error: result.error });
      res.setHeader('Set-Cookie', `${COOKIE}=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
      return json(res, 200, { user: result.user });
    }

    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET') throw new ApiError(405, 'method not allowed');
      return serveStatic(res, pathname);
    }

    const token = readCookie(req, COOKIE);
    const user = auth.userFor(token);
    if (!user) throw new ApiError(401, 'please sign in');

    if (req.method === 'POST' && pathname === '/api/logout') {
      auth.logout(token);
      res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && pathname === '/api/stream') return stream(req, res, user, token);

    const csv = pathname.match(/^\/api\/crew\/([\w-]+)\/export\.csv$/);
    if (req.method === 'GET' && csv) {
      const body = system.exportVitalsCsv(user, csv[1], Number(url.searchParams.get('hours') ?? 24));
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${csv[1]}-vitals.csv"` });
      return res.end(body);
    }

    for (const [method, pattern, handler] of routes) {
      if (method !== req.method) continue;
      const match = pathname.match(pattern);
      if (!match) continue;
      const body = method === 'POST' ? await readJson(req) : null;
      return json(res, 200, handler({ user, body, query: url.searchParams }, ...match.slice(1)));
    }
    throw new ApiError(404, 'not found');
  };

  return createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) return res.end();
      if (err instanceof ApiError) return json(res, err.status, { error: err.message, ...err.extra });
      if (err instanceof URIError) return json(res, 400, { error: 'malformed URL' });
      console.error(err);
      json(res, 500, { error: 'internal error' });
    });
  });
}

/** Creates user accounts with random passwords on first run and writes them to a private file. */
export function provisionUsers(store, credentialsFile = null) {
  if (store.userCount() > 0) return null;
  const lines = ['# AstroHealth initial credentials. Delete this file once they are distributed.', ''];
  const credentials = {};
  for (const u of USERS) {
    const password = generatePassword();
    store.addUser({ ...u, ...hashPassword(password) });
    credentials[u.username] = password;
    lines.push(`${u.username.padEnd(10)} ${password}   (${u.role})`);
  }
  if (credentialsFile) {
    writeFileSync(credentialsFile, `${lines.join('\n')}\n`, { mode: 0o600 });
    chmodSync(credentialsFile, 0o600);
  }
  return credentials;
}

function main() {
  const dataDir = resolve(process.env.DATA_DIR ?? join(ROOT, 'data'));
  mkdirSync(dataDir, { recursive: true });
  const dataSource = process.env.DATA_SOURCE === 'ingest' ? 'ingest' : 'simulator';
  const ingestToken = process.env.INGEST_TOKEN ?? null;
  if (dataSource === 'ingest' && !ingestToken) {
    console.error('DATA_SOURCE=ingest requires INGEST_TOKEN to be set.');
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? '127.0.0.1';

  const store = new Store(join(dataDir, 'astrohealth.db'));
  const credentialsFile = join(dataDir, 'initial-credentials.txt');
  const created = provisionUsers(store, credentialsFile);
  if (created) console.log(`First run: created user accounts. Credentials are in ${credentialsFile}`);

  const system = new MissionSystem({ store, dataSource });
  const server = createApp({ system, store, ingestToken });

  const timer = setInterval(() => {
    try {
      system.tick(Date.now());
    } catch (err) {
      console.error('tick failed', err);
    }
  }, 1000);

  server.listen(port, host, () => {
    console.log(`AstroHealth is running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port} (data source: ${dataSource})`);
  });

  const shutdown = () => {
    clearInterval(timer);
    server.close();
    server.closeAllConnections();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
