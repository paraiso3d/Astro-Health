import { chart, drawEcg } from './charts.js';

const $ = (selector, root = document) => root.querySelector(selector);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, d = 0) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(d));
const utc = (ts) => (ts ? new Date(ts).toISOString().slice(11, 19) : '—');
const utcFull = (ts) => (ts ? new Date(ts).toISOString().slice(0, 19).replace('T', ' ') : '—');

const SEV = { 1: ['advisory', 'ⓘ ADVISORY'], 2: ['caution', '▲ CAUTION'], 3: ['warning', '◆ WARNING'], 4: ['emergency', '✖ EMERGENCY'] };
const READY = { GO: ['good', '✓ GO'], RESTRICTED: ['caution', '▲ RESTRICTED'], 'NO-GO': ['bad', '✖ NO-GO'], UNKNOWN: ['advisory', '? UNKNOWN'] };
const VITAL_PARAMS = ['hr', 'spo2', 'rr', 'sys', 'dia', 'temp'];

const S = { user: null, state: null, ref: null, stream: null, live: null, lastTickSeen: 0, muted: false, charts: [], ecgStop: null, audio: null };
const app = $('#app');

// ---------- Helpers ----------

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && S.user && path !== '/api/login') {
    showLogin('Your session has ended. Please sign in again.');
    throw new Error('please sign in');
  }
  if (!res.ok) {
    const err = new Error(data.error ?? `request failed (${res.status})`);
    err.data = data;
    throw err;
  }
  return data;
}

function toast(message, isError = false) {
  const el = document.createElement('div');
  el.textContent = message;
  if (isError) el.className = 'err';
  $('#toast').append(el);
  setTimeout(() => el.remove(), isError ? 7000 : 4000);
}

const setHtml = (el, html) => {
  if (el && el.dataset.html !== html) {
    el.dataset.html = html;
    el.innerHTML = html;
  }
};

/** Updates only the rows that changed, so a button isn't replaced under the user's cursor. */
function setKeyed(parent, items) {
  if (!parent) return;
  const existing = new Map([...parent.children].map((c) => [c.dataset.key, c]));
  let previous = null;
  for (const { key, html } of items) {
    let el = existing.get(key);
    if (!el) {
      el = document.createElement('div');
      el.dataset.key = key;
    }
    if (el.dataset.html !== html) {
      el.dataset.html = html;
      el.innerHTML = html;
    }
    existing.delete(key);
    const next = previous ? previous.nextSibling : parent.firstChild;
    if (el !== next) parent.insertBefore(el, next);
    previous = el;
  }
  for (const el of existing.values()) el.remove();
}

const sevPill = (s) => `<span class="pill ${SEV[s][0]}">${SEV[s][1]}</span>`;
const readyPill = (status) => {
  const [cls, label] = READY[status] ?? READY.UNKNOWN;
  return `<span class="pill ${cls}">${label}</span>`;
};

const crewById = (id) => S.state?.crew.find((c) => c.id === id);
const isMedical = () => S.user.role === 'flight_surgeon' || S.user.role === 'cmo';
const isOnboard = () => S.state?.node === 'onboard';
const crewName = (id) => crewById(id)?.name ?? id;

const ack = (result) => {
  if (result.applied === false) toast(result.los ? 'Queued. The link is down, so this will send when signal returns.' : `Sent to the spacecraft. It takes effect in about ${fmt(result.etaSec)} s.`);
  else toast('Done.');
};

function worstAlertFor(crewId, param) {
  const alerts = S.state.alerts.filter((a) => a.crewId === crewId && a.param === param && !a.clearedAt);
  return alerts.reduce((m, a) => Math.max(m, a.severity), 0);
}

function tile(label, value, unit, severity = 0) {
  const flag = severity ? ` <span title="${SEV[severity][0]}" aria-label="${SEV[severity][0]}">${SEV[severity][1].split(' ')[0]}</span>` : '';
  return `<div class="tile ${severity ? `sev-${severity}` : ''}"><div class="label">${esc(label)}${flag}</div><div class="value">${value}<span class="unit">${esc(unit)}</span></div></div>`;
}

function vitalTiles(c, big = false) {
  const v = c.vitals ?? {};
  const bpSev = Math.max(worstAlertFor(c.id, 'sys'), worstAlertFor(c.id, 'dia'));
  const news = c.news;
  const newsText = !news ? '—' : news.valid ? `${news.score}${news.complete ? '' : '*'}` : 'n/a';
  const newsUnit = !news ? '' : news.valid ? (news.complete ? '' : ' partial') : ' exertion';
  const newsSev = news?.valid && news.score >= 7 ? 3 : news?.valid && news.score >= 5 ? 2 : 0;
  return `<div class="tiles ${big ? 'big' : ''}">
    ${tile('Heart rate', fmt(v.hr), ' bpm', worstAlertFor(c.id, 'hr'))}
    ${tile('SpO2', fmt(v.spo2), ' %', worstAlertFor(c.id, 'spo2'))}
    ${tile('Resp rate', fmt(v.rr), ' /min', worstAlertFor(c.id, 'rr'))}
    ${tile('Blood pressure', `${fmt(v.sys)}/${fmt(v.dia)}`, ' mmHg', bpSev)}
    ${tile('Core temp', fmt(v.temp, 1), ' °C', worstAlertFor(c.id, 'temp'))}
    ${tile('NEWS2', newsText, newsUnit, newsSev)}
  </div>`;
}

const groundBehind = () => S.state.node === 'ground' && S.state.snapshotAgeMs > (S.state.link.delaySec + 10) * 1000;

function staleTag(c) {
  if (c.dataAgeMs === null || c.dataAgeMs === undefined) return '<span class="pill bad">✖ NO DATA</span>';
  if (c.dataAgeMs >= 10000) return `<span class="pill bad">✖ STALE ${fmt(c.dataAgeMs / 1000)} s</span>`;
  if (groundBehind()) return '<span class="pill caution">▲ LAST KNOWN</span>';
  return '';
}

function crewCard(c) {
  const ready = c.readiness ?? { duty: { status: 'UNKNOWN' }, eva: { status: 'UNKNOWN' } };
  const head = `<header><div><h2>${c.medicalAccess ? `<a href="#/crew/${esc(c.id)}">${esc(c.name)}</a>` : esc(c.name)}</h2><div class="small muted">${esc(c.role)}</div></div><span class="spacer"></span>${staleTag(c)}</header>`;
  const status = `<div class="row small" style="margin-top:8px"><span class="muted">Duty</span> ${readyPill(ready.duty.status)} <span class="muted">EVA</span> ${readyPill(ready.eva.status)}</div>`;
  if (!c.medicalAccess) return `<div class="card crew-card">${head}<p class="small muted">Medical details are confidential to this crew member and the medical team.</p>${status}</div>`;
  const facts = [c.activity ? `Activity: ${c.activity}` : null, c.rhythm && c.rhythm !== 'insufficient' ? `Rhythm: ${c.rhythm}` : null, c.rmssd !== null && c.rmssd !== undefined ? `HRV ${c.rmssd} ms` : null, c.battery !== null && c.battery !== undefined ? `Battery ${c.battery}%` : null].filter(Boolean);
  const hold = c.hold ? `<div class="row small" style="margin-top:6px"><span class="pill bad">✖ MEDICAL HOLD</span> ${esc(c.hold.reason)}</div>` : '';
  return `<div class="card crew-card">${head}${vitalTiles(c)}<div class="small muted" style="margin-top:8px">${esc(facts.join(' · '))}</div>${hold}${status}</div>`;
}

function alertRow(a) {
  const buttons = [];
  if (a.protocol) buttons.push(`<a class="btn small" href="#/protocols/${esc(a.protocol)}">Protocol</a>`);
  if (a.ackPending) buttons.push('<span class="small muted">Acknowledgement in transit</span>');
  else if (a.canAck && a.status === 'active') buttons.push(`<button class="small primary" data-action="ack" data-id="${esc(a.id)}">Acknowledge</button>`);
  if (a.canAck && a.severity < 4 && !a.redacted && a.severity >= 2 && !a.clearedAt) buttons.push(`<button class="small" data-action="silence" data-id="${esc(a.id)}">Silence</button>`);
  const tags = [
    a.escalated ? '<span class="pill bad">✖ ESCALATED</span>' : '',
    a.status === 'acknowledged' ? `<span class="pill">✓ Ack by ${esc(a.ackedBy)}</span>` : '',
    a.clearedAt ? '<span class="pill">Condition cleared; awaiting acknowledgement</span>' : '',
    a.occurrences > 1 ? `<span class="pill">×${esc(a.occurrences)} recurring</span>` : '',
  ].join(' ');
  return `<div class="alert sev-${a.severity}">
    <div>${sevPill(a.severity)}</div>
    <div class="body"><strong>${esc(a.title)}</strong> ${tags}<div class="small secondary">${esc(a.message)}</div><div class="small muted">${utcFull(a.raisedAt)} UTC</div></div>
    <div class="row">${buttons.join('')}</div>
  </div>`;
}

const alertItems = (alerts) => alerts.map((a) => ({ key: a.id, html: alertRow(a) }));

function cleanupView() {
  for (const stop of S.charts) stop();
  S.charts = [];
  S.ecgStop?.();
  S.ecgStop = null;
  S.live = null;
  clearInterval(S.viewTimer);
}

function formValues(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'number' || el.dataset.number !== undefined) out[el.name] = el.value === '' ? undefined : Number(el.value);
    else out[el.name] = el.value;
  }
  return out;
}

// ---------- Sign in and shell ----------

function showLogin(message = '') {
  cleanupView();
  S.stream?.close();
  S.user = null;
  S.state = null;
  app.innerHTML = `<div class="login"><form class="card" data-form="login">
    <h1>AstroHealth</h1>
    <p class="secondary">Crew health monitoring system</p>
    <p class="small secondary note">Not a certified medical device. Thresholds and clinical content need flight-surgeon validation before operational use.</p>
    ${message ? `<p class="small" role="alert">${esc(message)}</p>` : ''}
    <label>Username<input name="username" autocomplete="username" required autofocus></label>
    <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
    <button class="primary" type="submit">Sign in</button>
  </form></div>`;
}

const NAV = [
  ['overview', 'Crew overview', () => true],
  ['me', 'My health', () => !!S.user.crewId],
  ['alerts', 'Alerts', () => true],
  ['readiness', 'Readiness', () => true],
  ['environment', 'Environment', () => true],
  ['pharmacy', 'Pharmacy', () => S.user.role !== 'mission_ops'],
  ['protocols', 'Protocols', () => S.user.role !== 'mission_ops'],
  ['comms', 'Comms', () => true],
  ['training', 'Training', isMedical],
  ['audit', 'Audit log', isMedical],
];

async function startSession(user) {
  S.user = user;
  S.ref = await api('/api/reference');
  S.state = await api('/api/state');
  S.lastTickSeen = Date.now();
  app.innerHTML = `
    <div class="topbar">
      <span class="brand">AstroHealth</span>
      <span id="mission" class="small secondary"></span>
      <span class="spacer"></span>
      <span id="link" class="small"></span>
      <button class="small" data-action="mute" id="mute">Sound on</button>
      <span class="small secondary">${esc(user.displayName)}</span>
      <button class="small" data-action="logout">Sign out</button>
    </div>
    <div id="training-banner"></div>
    <div id="banners"></div>
    <div class="layout">
      <nav class="side" id="nav" aria-label="Sections"></nav>
      <main id="view"></main>
    </div>`;
  connectStream();
  route();
}

function connectStream() {
  S.stream?.close();
  S.stream = new EventSource('/api/stream');
  S.stream.onmessage = (e) => {
    S.state = JSON.parse(e.data);
    S.lastTickSeen = Date.now();
    renderChrome();
    S.live?.();
  };
  S.stream.addEventListener('expired', () => showLogin('Your session has ended. Please sign in again.'));
}

function renderChrome() {
  const st = S.state;
  if (!st || !S.user) return;
  setHtml($('#mission'), `${esc(st.mission.name)} · ${esc(st.mission.profile)} · Mission day ${st.mission.day} of ${st.mission.plannedDays} · ${utc(st.now)} UTC`);
  const node = st.node === 'onboard' ? '<span class="pill good">● ON BOARD: live data</span>' : `<span class="pill advisory">◌ GROUND: data ${fmt((st.snapshotAgeMs ?? 0) / 1000)} s old</span>`;
  const link = st.link.los ? '<span class="pill bad">✖ LOSS OF SIGNAL</span>' : `<span class="pill">Link ${st.link.delaySec >= 60 ? `${fmt(st.link.delaySec / 60, 1)} min` : `${fmt(st.link.delaySec, 2).replace(/\.?0+$/, '')} s`} one-way</span>`;
  $('#link').innerHTML = `<span class="row">${node} ${link}</span>`;
  setHtml($('#training-banner'), st.dataSource === 'simulator' ? `<div class="training">▲ TRAINING SIMULATION: all crew and telemetry shown are simulated.${st.scenarios.length ? ` ${st.scenarios.length} training scenario(s) running.` : ''}</div>` : '');

  const banners = [];
  const emergencies = st.alerts.filter((a) => a.severity === 4 && !a.clearedAt);
  if (emergencies.length) banners.push(`<div class="banner critical">✖ EMERGENCY: ${esc(emergencies.map((a) => (a.crewId ? `${a.title}, ${crewName(a.crewId)}` : a.title)).join(' · '))} <a class="btn small" href="#/alerts">View alerts</a></div>`);
  if (st.link.los && st.node === 'ground') banners.push('<div class="banner warn">▲ Loss of signal. The ground view is out of date, and the crew is relying on on-board systems.</div>');
  else if (groundBehind()) banners.push(`<div class="banner warn">▲ Ground data is ${fmt(st.snapshotAgeMs / 1000)} s old, more than the link delay. The backlog is catching up.</div>`);
  setHtml($('#banners'), banners.join(''));
  renderNav();
  soundAlarm();
}

function renderNav() {
  const [section, sub] = currentRoute();
  const open = S.state.alerts.filter((a) => a.status === 'active').length;
  const html = NAV.filter(([, , allowed]) => allowed()).map(([id, label]) => {
    const on = section === id || (id === 'me' && section === 'crew' && sub === S.user.crewId) || (id === 'overview' && section === 'crew' && sub !== S.user.crewId);
    const count = id === 'alerts' && open ? `<span class="count">${open}</span>` : '';
    return `<a href="#/${id}" class="${on ? 'on' : ''}">${label}${count}</a>`;
  }).join('');
  setHtml($('#nav'), html);
}

// Audible alarm repeats while an unacknowledged, unsilenced warning or emergency is active
let alarmTimer = 0;
function soundAlarm() {
  const now = Date.now();
  const pending = S.state.alerts.filter((a) => a.status === 'active' && a.severity >= 3 && !(a.shelvedUntil > S.state.now));
  if (S.muted || !pending.length) return;
  const emergency = pending.some((a) => a.severity === 4);
  if (now - alarmTimer < (emergency ? 1000 : 4000)) return;
  alarmTimer = now;
  try {
    S.audio ??= new AudioContext();
    if (S.audio.state !== 'running') return;
    const osc = S.audio.createOscillator();
    const gain = S.audio.createGain();
    osc.frequency.value = emergency ? 960 : 660;
    gain.gain.value = 0.06;
    osc.connect(gain).connect(S.audio.destination);
    osc.start();
    osc.stop(S.audio.currentTime + 0.25);
  } catch { /* the visual alarm still shows if audio is unavailable */ }
}

// Watchdog: a frozen display must never pass for a stable patient
setInterval(() => {
  if (!S.user || !$('#banners')) return;
  const silent = Date.now() - S.lastTickSeen;
  const el = $('#watchdog');
  if (silent > 5000 && !el) {
    const div = document.createElement('div');
    div.id = 'watchdog';
    div.className = 'banner critical';
    div.textContent = '✖ DISPLAY NOT UPDATING: connection to the monitoring system is lost. Values on screen are out of date.';
    $('#banners').before(div);
  } else if (silent <= 5000 && el) {
    el.remove();
  }
}, 1000);

// ---------- Routing ----------

const currentRoute = () => location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);

function route() {
  if (!S.user) return;
  cleanupView();
  const [section = 'overview', a, b] = currentRoute();
  const view = $('#view');
  const views = { overview: viewOverview, me: () => viewCrew(S.user.crewId, a ?? 'live'), crew: () => viewCrew(a, b ?? 'live'), alerts: viewAlerts, readiness: viewReadiness, environment: viewEnvironment, pharmacy: viewPharmacy, protocols: () => viewProtocols(a), comms: viewComms, training: viewTraining, audit: viewAudit };
  (views[section] ?? viewOverview)(view);
  renderChrome();
  window.scrollTo(0, 0);
}

// ---------- Overview ----------

function envTiles() {
  const env = S.state.env;
  if (!env) return '<p class="muted small">No cabin data.</p>';
  const worst = (param) => S.state.alerts.filter((a) => a.category === 'environment' && a.param === param && !a.clearedAt).reduce((m, a) => Math.max(m, a.severity), 0);
  return `<div class="tiles big">${Object.entries(S.ref.envParams).map(([k, m]) => tile(m.label, fmt(env[k], m.decimals), ` ${m.unit}`, worst(k))).join('')}</div>`;
}

function viewOverview(view) {
  view.innerHTML = `
    <div class="page-head"><h1>Crew overview</h1></div>
    <div class="stack">
      <div class="crew-grid" id="crew-cards"></div>
      <section class="card"><h2>Active alerts</h2><div id="ov-alerts"></div><p class="small muted" id="ov-none"></p></section>
      <section class="card"><h2>Cabin environment</h2><div id="ov-env"></div></section>
    </div>`;
  S.live = () => {
    setKeyed($('#crew-cards'), S.state.crew.map((c) => ({ key: c.id, html: crewCard(c) })));
    setKeyed($('#ov-alerts'), alertItems(S.state.alerts));
    setHtml($('#ov-none'), S.state.alerts.length ? '' : 'No active alerts.');
    setHtml($('#ov-env'), envTiles());
  };
  S.live();
}

// ---------- Crew member ----------

function viewCrew(id, tab) {
  const view = $('#view');
  const c = crewById(id);
  if (!c?.medicalAccess) {
    view.innerHTML = '<div class="card"><h2>Restricted</h2><p class="secondary">Medical details are confidential to this crew member and the medical team.</p></div>';
    return;
  }
  const base = id === S.user.crewId ? '#/me' : `#/crew/${id}`;
  const tabs = [['live', 'Live'], ['longterm', 'Long-term health'], ['record', 'Clinical record'], ['report', 'Report']];
  view.innerHTML = `
    <div class="page-head"><h1>${esc(c.name)}</h1><span class="secondary">${esc(c.role)}</span></div>
    <div class="tabs">${tabs.map(([t, label]) => `<a href="${base}/${t}" class="${t === tab ? 'on' : ''}">${label}</a>`).join('')}</div>
    <div id="tab"></div>`;
  const body = $('#tab');
  ({ live: tabLive, longterm: tabLongTerm, record: tabRecord, report: tabReport }[tab] ?? tabLive)(body, id);
}

function tabLive(body, id) {
  const options = VITAL_PARAMS.map((p) => `<option value="${p}">${esc(S.ref.vitals[p].label)}</option>`).join('');
  const canCheck = isOnboard() && (S.user.crewId === id || S.user.role === 'cmo');
  body.innerHTML = `<div class="stack">
    <div id="live-tiles"></div>
    <section class="card"><div class="row"><h2>ECG monitor</h2><span class="small muted">Illustrative trace generated from reported rate and rhythm, not a raw clinical waveform.</span></div><canvas class="ecg" id="ecg"></canvas></section>
    <section class="card">
      <div class="row"><h2>Trend</h2><span class="spacer"></span>
        <select id="tr-param" style="width:auto" aria-label="Parameter">${options}</select>
        <select id="tr-range" style="width:auto" aria-label="Time range"><option value="30">30 min</option><option value="120">2 h</option><option value="1440">24 h</option></select>
      </div>
      <div id="trend"></div>
    </section>
    <div class="grid cols-2">
      <section class="card"><h2>Status</h2><div id="live-status"></div></section>
      <section class="card"><h2>Medical profile</h2><div id="live-profile"></div></section>
    </div>
    <section class="card"><h2>Alerts for this crew member</h2><div id="live-alerts"></div></section>
    ${canCheck ? `<section class="card"><h2>Consciousness and oxygen check</h2>
      <form data-form="checkin" data-id="${esc(id)}" class="form-grid">
        <label>AVPU<select name="avpu"><option value="A">A: Alert</option><option value="C">C: New confusion</option><option value="V">V: Responds to voice</option><option value="P">P: Responds to pain</option><option value="U">U: Unresponsive</option></select></label>
        <label class="check"><input type="checkbox" name="onOxygen"> On supplemental oxygen</label>
        <button class="primary" type="submit">Record check</button>
      </form></section>` : ''}
  </div>`;
  const loadTrend = async () => {
    const param = $('#tr-param').value;
    const data = await api(`/api/crew/${id}/history?param=${param}&minutes=${$('#tr-range').value}`);
    const meta = S.ref.vitals[param];
    chart($('#trend'), data.points.map((p) => ({ x: p.t, y: p.v })), { unit: meta.unit, decimals: meta.decimals, xType: 'time', ref: data.baseline, refLabel: 'Personal baseline', name: meta.label });
  };
  $('#tr-param').addEventListener('change', loadTrend);
  $('#tr-range').addEventListener('change', loadTrend);
  loadTrend().catch((e) => toast(e.message, true));
  S.viewTimer = setInterval(() => loadTrend().catch(() => {}), 15000);
  S.ecgStop = drawEcg($('#ecg'), () => crewById(id));

  S.live = () => {
    const x = crewById(id);
    setHtml($('#live-tiles'), `${staleTag(x)}${vitalTiles(x, true)}`);
    const r = x.readiness;
    const reasons = (list) => (list?.length ? `<ul class="small secondary" style="margin:4px 0 0;padding-left:18px">${list.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '');
    setHtml($('#live-status'), `
      <div class="stack">
        <div class="row">Fit for duty ${readyPill(r?.duty.status)}</div>${reasons(r?.duty.reasons)}
        <div class="row">EVA ${readyPill(r?.eva.status)}</div>${reasons(r?.eva.reasons)}
        <div class="small secondary">Activity: ${esc(x.activity ?? '—')} · Rhythm screen: ${esc(x.rhythm ?? '—')} · HRV (RMSSD): ${fmt(x.rmssd)} ms · Wearable battery: ${fmt(x.battery)}%</div>
        <div class="small secondary">Fatigue: ${esc(x.fatigue?.level ?? '—')} · Last check: AVPU ${esc(x.checkin?.avpu)}${x.checkin?.onOxygen ? ', on oxygen' : ''}${x.checkin?.by ? ` by ${esc(x.checkin.by)}` : ''}</div>
        <div class="small secondary">Radiation: ${fmt(x.dose?.cumulativeMsv, 1)} mSv of ${fmt(x.dose?.limitMsv)} mSv career limit; projected ${fmt(x.dose?.projectedMsv)} mSv by end of mission; about ${fmt(x.dose?.daysToLimit)} days to limit at the current rate</div>
      </div>`);
    setHtml($('#live-profile'), `<table>
      <tr><th>Age / sex</th><td>${esc(x.age)} / ${esc(x.sex)}</td></tr>
      <tr><th>Blood type</th><td>${esc(x.bloodType)}</td></tr>
      <tr><th>Allergies</th><td>${x.allergies?.length ? `<strong>${esc(x.allergies.join(', '))}</strong>` : 'None recorded'}</td></tr>
      <tr><th>Conditions</th><td>${esc(x.conditions?.join(', ') || 'None recorded')}</td></tr>
      <tr><th>Baseline</th><td class="tabular">HR ${esc(x.baseline?.hr)} · RR ${esc(x.baseline?.rr)} · SpO2 ${esc(x.baseline?.spo2)}% · BP ${esc(x.baseline?.sys)}/${esc(x.baseline?.dia)} · ${esc(x.baseline?.temp)} °C</td></tr>
    </table>`);
    const mine = S.state.alerts.filter((a) => a.crewId === id);
    setKeyed($('#live-alerts'), mine.length ? alertItems(mine) : [{ key: 'none', html: '<p class="small muted">No active alerts.</p>' }]);
  };
  S.live();
}

async function tabLongTerm(body, id) {
  body.innerHTML = '<p class="muted">Loading…</p>';
  const lt = await api(`/api/crew/${id}/longterm`);
  const canLog = isOnboard() && (S.user.crewId === id || S.user.role === 'cmo');
  const series = [
    ['sleepH', 'Sleep', 'h', 1, 8, 'Sleep need'],
    ['exerciseMin', 'Exercise', 'min', 0, 120, 'Prescription'],
    ['waterL', 'Fluid intake', 'L', 1, 2, 'Minimum'],
    ['kcal', 'Energy intake', 'kcal', 0, lt.kcalTarget, 'Target'],
    ['weightKg', 'Body mass', 'kg', 1, lt.preflightWeightKg, 'Pre-flight'],
    ['mood', 'Mood (1-10)', '', 1, null, ''],
    ['stress', 'Stress (1-10)', '', 1, null, ''],
    ['pvtLapses', 'Vigilance test lapses', '', 0, null, ''],
  ];
  const last = lt.logs.at(-1);
  body.innerHTML = `<div class="stack">
    <div class="tiles big">
      ${tile('Fatigue risk', esc(lt.fatigue.level), lt.fatigue.score === null ? '' : ` score ${lt.fatigue.score}`)}
      ${tile('3-day sleep debt', fmt(lt.fatigue.sleepDebtH, 1), ' h')}
      ${tile('Exercise adherence', fmt(lt.bone.adherencePct), ' %')}
      ${tile('Est. bone loss*', fmt(lt.bone.estLossPct, 1), ' %')}
    </div>
    <p class="small muted">*Illustrative model for weight-bearing bone (about 1.25 %/month, halved at full exercise adherence). Use it to prompt a scan, never in place of one.</p>
    <section class="card"><h2>Findings</h2>${lt.findings.length ? lt.findings.map((f) => `<div class="alert sev-${f.severity}"><div>${sevPill(f.severity)}</div><div class="body"><strong>${esc(f.title)}</strong><div class="small secondary">${esc(f.message)}</div></div></div>`).join('') : '<p class="small muted">No long-term findings.</p>'}</section>
    <div class="grid cols-2" id="lt-charts">${series.map(([k, label]) => `<section class="card"><h2>${esc(label)}</h2><div data-chart="${k}"></div></section>`).join('')}</div>
    <section class="card"><h2>Eye exams (SANS screening)</h2>
      <div class="table-wrap"><table><thead><tr><th>Date</th><th>Frisén grade</th><th class="num">Near acuity change</th><th class="num">IOP (mmHg)</th><th>Notes</th></tr></thead>
      <tbody>${lt.exams.map((e) => `<tr><td>${utcFull(e.ts).slice(0, 10)}</td><td>${esc(e.frisenGrade)}</td><td class="num">${esc(e.acuityChange)}</td><td class="num">${esc(e.iopMmHg)}</td><td>${esc(e.notes)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No exams.</td></tr>'}</tbody></table></div>
      ${S.user.role === 'cmo' ? `<form data-form="exam" data-id="${esc(id)}" class="form-grid" style="margin-top:12px">
        <label>Frisén grade (0-5)<input type="number" name="frisenGrade" min="0" max="5" step="1" required></label>
        <label>Acuity change (lines)<input type="number" name="acuityChange" min="0" max="10" value="0"></label>
        <label>IOP (mmHg)<input type="number" name="iopMmHg" min="1" max="80" step="0.1" required></label>
        <label class="full">Notes<input name="notes" maxlength="2000"></label>
        <button class="primary" type="submit">Record exam</button></form>` : ''}
    </section>
    ${canLog ? `<section class="card"><h2>Today's daily log</h2>
      <form data-form="daily" data-id="${esc(id)}" class="form-grid">
        <label>Sleep (h)<input type="number" name="sleepH" min="0" max="24" step="0.1" required value="${esc(last?.sleepH ?? '')}"></label>
        <label>Exercise (min)<input type="number" name="exerciseMin" min="0" max="600" required value="${esc(last?.exerciseMin ?? '')}"></label>
        <label>Fluids (L)<input type="number" name="waterL" min="0" max="15" step="0.1" required value="${esc(last?.waterL ?? '')}"></label>
        <label>Energy (kcal)<input type="number" name="kcal" min="0" max="10000" required value="${esc(last?.kcal ?? '')}"></label>
        <label>Body mass (kg)<input type="number" name="weightKg" min="20" max="250" step="0.1" required value="${esc(last?.weightKg ?? '')}"></label>
        <label>Mood (1-10)<input type="number" name="mood" min="1" max="10" step="0.5" required value="${esc(last?.mood ?? '')}"></label>
        <label>Stress (1-10)<input type="number" name="stress" min="1" max="10" step="0.5" required value="${esc(last?.stress ?? '')}"></label>
        <label>Vigilance lapses<input type="number" name="pvtLapses" min="0" max="100" value="${esc(last?.pvtLapses ?? 0)}"></label>
        <button class="primary" type="submit">Save log</button>
      </form></section>` : ''}
  </div>`;
  for (const [key, label, unit, decimals, ref, refLabel] of series) {
    chart($(`[data-chart="${key}"]`), lt.logs.map((l) => ({ x: l.missionDay, y: l[key] })), { unit, decimals, xType: 'day', ref, refLabel, name: label, height: 170 });
  }
}

async function tabRecord(body, id) {
  body.innerHTML = '<p class="muted">Loading…</p>';
  const rec = await api(`/api/crew/${id}/record`);
  const canReport = isOnboard() && (S.user.crewId === id || S.user.role === 'cmo');
  const symptomOptions = Object.entries(S.ref.symptoms).map(([k, s]) => `<option value="${esc(k)}">${esc(s.label)}</option>`).join('');
  const symptomRow = (s) => `<tr><td>${utcFull(s.ts)}</td><td>${esc(s.label)}${s.notes ? `<div class="small muted">${esc(s.notes)}</div>` : ''}</td><td class="num">${esc(s.severity)}/10</td><td>${esc(s.triage)}</td><td>${s.resolvedAt ? `Resolved by ${esc(s.resolvedBy)}` : `<button class="small" data-action="resolve-symptom" data-id="${esc(s.id)}">Mark resolved</button>`}</td></tr>`;
  const limitRows = Object.entries(rec.limits ?? {}).map(([p, o]) => `<tr><td>${esc(S.ref.vitals[p]?.label ?? p)}</td><td class="tabular">low ${esc(JSON.stringify(o.low ?? 'default'))}, high ${esc(JSON.stringify(o.high ?? 'default'))}</td></tr>`).join('');
  body.innerHTML = `<div class="stack">
    ${canReport ? `<section class="card"><h2>Report a symptom</h2>
      <form data-form="symptom" data-id="${esc(id)}" class="form-grid">
        <label class="full">Symptom<select name="code">${symptomOptions}</select></label>
        <label>Severity (0-10)<input type="number" name="severity" min="0" max="10" required value="3"></label>
        <label class="full">Notes<input name="notes" maxlength="2000"></label>
        <button class="primary" type="submit">Report</button>
      </form></section>` : ''}
    <section class="card"><h2>Symptoms</h2><div class="table-wrap"><table><thead><tr><th>Reported (UTC)</th><th>Symptom</th><th class="num">Severity</th><th>Triage</th><th>Status</th></tr></thead><tbody>${rec.symptoms.slice().reverse().map(symptomRow).join('') || '<tr><td colspan="5" class="muted">No symptoms recorded.</td></tr>'}</tbody></table></div></section>
    <section class="card"><h2>Medication record</h2><div class="table-wrap"><table><thead><tr><th>Given (UTC)</th><th>Medication</th><th>By</th><th>Indication / override</th></tr></thead><tbody>${rec.medications.slice().reverse().map((m) => `<tr><td>${utcFull(m.ts)}</td><td>${esc(m.name)} ${esc(m.dose)}</td><td>${esc(m.givenBy)}</td><td>${esc(m.indication)}${m.overrideReason ? `<div class="small"><span class="pill caution">▲ OVERRIDE</span> ${esc(m.overrideReason)}</div>` : ''}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No doses recorded.</td></tr>'}</tbody></table></div></section>
    <section class="card"><h2>Clinical notes</h2>
      ${rec.encounters.slice().reverse().map((n) => `<div class="msg"><div class="small muted">${utcFull(n.ts)} UTC · ${esc(n.type)} · ${esc(n.authorName)}${n.visGround && n.visOnboard ? '' : ' · in transit'}</div>${esc(n.text)}</div>`).join('') || '<p class="small muted">No notes.</p>'}
      ${isMedical() ? `<form data-form="encounter" data-id="${esc(id)}" class="form-grid" style="margin-top:8px">
        <label>Type<select name="type"><option>Note</option><option>Private medical conference</option><option>Exam</option><option>Procedure</option><option>Plan</option></select></label>
        <label class="full">Note<textarea name="text" maxlength="5000" required></textarea></label>
        <button class="primary" type="submit">Add note</button></form>` : ''}
    </section>
    ${isMedical() ? `<section class="card"><h2>Medical hold</h2><form data-form="hold" data-id="${esc(id)}" class="form-grid">
        <label class="full">Reason<input name="reason" maxlength="300"></label>
        <button class="danger" type="submit">Set hold</button>
        <button type="button" data-action="release-hold" data-id="${esc(id)}">Release hold</button></form></section>` : ''}
    <section class="card"><h2>Crew-specific alarm limits</h2>
      <div class="table-wrap"><table><tbody>${limitRows || '<tr><td class="muted">Using mission defaults.</td></tr>'}</tbody></table></div>
      ${S.user.role === 'flight_surgeon' ? `<form data-form="limits" data-id="${esc(id)}" class="form-grid" style="margin-top:8px">
        <label>Parameter<select name="param">${VITAL_PARAMS.map((p) => `<option value="${p}">${esc(S.ref.vitals[p].label)}</option>`).join('')}</select></label>
        <label>Low limits: caution, warning, emergency<input name="low" placeholder="50, 40, 30"></label>
        <label>High limits: caution, warning, emergency<input name="high" placeholder="110, 130, 180"></label>
        <label class="full">Reason (required)<input name="reason" maxlength="300" required></label>
        <button class="primary" type="submit">Apply limits</button>
        <button type="button" data-action="reset-limits" data-id="${esc(id)}">Reset parameter to default</button>
        </form>` : ''}
    </section>
  </div>`;
}

async function tabReport(body, id) {
  body.innerHTML = '<p class="muted">Generating…</p>';
  const r = await api(`/api/crew/${id}/report`);
  const st = (status) => readyPill(status);
  body.innerHTML = `<div class="stack">
    <div class="row no-print"><button class="primary" data-action="print">Print report</button>
      <a class="btn" href="/api/crew/${esc(id)}/export.csv?hours=24" download>Export vitals, 24 h (CSV)</a>
      <a class="btn" href="/api/crew/${esc(id)}/export.csv?hours=168" download>Export vitals, 7 days (CSV)</a></div>
    <section class="card"><h2>Medical summary: ${esc(r.crew.name)}, ${esc(r.crew.role)}</h2>
      <p class="small secondary">${esc(r.mission.name)}, mission day ${r.mission.day}. Generated ${utcFull(r.generatedAt)} UTC by ${esc(r.generatedBy)} (${esc(r.node)}), with data through ${utcFull(r.dataThrough)} UTC. Confidential medical record.</p>
      <p class="small secondary">Age ${esc(r.crew.age)} · ${esc(r.crew.sex)} · ${esc(r.crew.bloodType)} · Allergies: ${esc(r.crew.allergies.join(', ') || 'none recorded')} · Conditions: ${esc(r.crew.conditions.join(', ') || 'none recorded')}</p>
      <div class="row" style="margin-top:8px">Duty ${st(r.readiness?.duty.status)} EVA ${st(r.readiness?.eva.status)} <span class="small secondary">NEWS2: ${r.news?.valid ? esc(r.news.score) : 'not valid during exertion'} · Dose: ${fmt(r.dose?.cumulativeMsv, 1)} of ${fmt(r.dose?.limitMsv)} mSv</span></div>
    </section>
    <section class="card"><h2>Vital signs, last 24 h</h2><div class="table-wrap"><table><thead><tr><th>Parameter</th><th class="num">Min</th><th class="num">Mean</th><th class="num">Max</th><th class="num">Samples</th></tr></thead>
      <tbody>${Object.values(r.vitals).map((v) => `<tr><td>${esc(v.label)} (${esc(v.unit)})</td><td class="num">${fmt(v.min, v.decimals)}</td><td class="num">${fmt(v.avg, v.decimals)}</td><td class="num">${fmt(v.max, v.decimals)}</td><td class="num">${esc(v.n)}</td></tr>`).join('')}</tbody></table></div></section>
    <section class="card"><h2>Long-term findings</h2>${r.longTerm.findings.map((f) => `<p>${sevPill(f.severity)} <strong>${esc(f.title)}.</strong> <span class="small secondary">${esc(f.message)}</span></p>`).join('') || '<p class="small muted">None.</p>'}
      <p class="small secondary" style="margin-top:8px">Fatigue: ${esc(r.longTerm.fatigue.level)} · Exercise adherence: ${fmt(r.longTerm.bone.adherencePct)}% · Estimated bone loss (model): ${fmt(r.longTerm.bone.estLossPct, 1)}%</p></section>
    <section class="card"><h2>Alerts, last 7 days (${r.alerts.length})</h2><div class="table-wrap"><table><thead><tr><th>Raised (UTC)</th><th>Severity</th><th>Alert</th><th>Status</th></tr></thead><tbody>${r.alerts.map((a) => `<tr><td>${utcFull(a.raisedAt)}</td><td>${sevPill(a.severity)}</td><td>${esc(a.title)}</td><td>${esc(a.status)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">None.</td></tr>'}</tbody></table></div></section>
    <section class="card"><h2>Medication and symptoms, last 7 days</h2>
      ${r.medications.map((m) => `<p class="small">${utcFull(m.ts)}: ${esc(m.name)} ${esc(m.dose)}, given by ${esc(m.givenBy)}</p>`).join('') || '<p class="small muted">No doses.</p>'}
      ${r.symptoms.map((s) => `<p class="small">${utcFull(s.ts)}: ${esc(s.label)} (${esc(s.severity)}/10, ${esc(s.triage)})</p>`).join('') || '<p class="small muted">No symptoms.</p>'}</section>
  </div>`;
}

// ---------- Alerts ----------

async function viewAlerts(view) {
  view.innerHTML = `<div class="page-head"><h1>Alerts</h1></div>
    <div class="stack"><section class="card"><h2>Active</h2><div id="al-active"></div><p class="small muted" id="al-none"></p></section>
    <section class="card"><h2>History</h2><div class="table-wrap" id="al-history"><p class="muted">Loading…</p></div></section></div>`;
  S.live = () => {
    setKeyed($('#al-active'), alertItems(S.state.alerts));
    setHtml($('#al-none'), S.state.alerts.length ? '' : 'No active alerts.');
  };
  S.live();
  const load = async () => {
    const rows = await api('/api/alerts/history');
    const el = $('#al-history');
    if (!el) return;
    setHtml(el, `<table><thead><tr><th>Raised (UTC)</th><th>Severity</th><th>Who</th><th>Alert</th><th>Status</th><th>Acknowledged by</th></tr></thead><tbody>${rows.map((a) => `<tr><td>${utcFull(a.raisedAt)}</td><td>${sevPill(a.severity)}</td><td>${esc(a.crewId ? crewName(a.crewId) : 'Cabin')}</td><td>${esc(a.title)}</td><td>${esc(a.status)}</td><td>${esc(a.ackedBy ?? '')}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No alerts yet.</td></tr>'}</tbody></table>`);
  };
  load().catch((e) => toast(e.message, true));
  S.viewTimer = setInterval(() => load().catch(() => {}), 10000);
}

// ---------- Readiness ----------

function viewReadiness(view) {
  view.innerHTML = `<div class="page-head"><h1>Crew readiness</h1></div>
    <section class="card"><div class="table-wrap" id="rd"></div>
    <p class="small muted" style="margin-top:8px">These results support the flight surgeon's decision and don't replace it. Missing data shows as UNKNOWN, never as GO. Command and operations see status only; the reasons stay confidential.</p></section>`;
  S.live = () => {
    const reason = (l) => (l?.length ? `<div class="small secondary">${l.map(esc).join('; ')}</div>` : '');
    setHtml($('#rd'), `<table><thead><tr><th>Crew member</th><th>Fit for duty</th><th>EVA</th></tr></thead><tbody>${S.state.crew.map((c) => `<tr><td><strong>${esc(c.name)}</strong><div class="small muted">${esc(c.role)}</div></td><td>${readyPill(c.readiness?.duty.status)}${reason(c.readiness?.duty.reasons)}</td><td>${readyPill(c.readiness?.eva.status)}${reason(c.readiness?.eva.reasons)}</td></tr>`).join('')}</tbody></table>`);
  };
  S.live();
}

// ---------- Environment ----------

function viewEnvironment(view) {
  const options = Object.entries(S.ref.envParams).map(([k, m]) => `<option value="${k}">${esc(m.label)}</option>`).join('');
  const canShelter = isOnboard() && (S.user.role === 'cmo' || S.user.role === 'commander');
  view.innerHTML = `<div class="page-head"><h1>Cabin environment and radiation</h1></div>
    <div class="stack">
      <div id="env-tiles"></div>
      <section class="card"><div class="row"><h2>Trend</h2><span class="spacer"></span>
        <select id="env-param" style="width:auto" aria-label="Parameter">${options}</select>
        <select id="env-range" style="width:auto" aria-label="Time range"><option value="30">30 min</option><option value="120">2 h</option><option value="1440">24 h</option></select></div>
        <div id="env-chart"></div></section>
      <section class="card"><div class="row"><h2>Radiation dose by crew member</h2><span class="spacer"></span><span id="shelter-status"></span>
        ${canShelter ? '<button class="small" data-action="shelter">Toggle storm shelter</button>' : ''}</div>
        <div class="table-wrap" id="dose"></div>
        <p class="small muted" style="margin-top:8px">Limit: 600 mSv career effective dose (NASA-STD-3001). Each person's dose is estimated from the cabin reading; storm shelter assumes a 0.4 shielding factor. Personal dosimeters remain the record of dose.</p></section>
    </div>`;
  const load = async () => {
    const param = $('#env-param').value;
    const meta = S.ref.envParams[param];
    const data = await api(`/api/environment/history?param=${param}&minutes=${$('#env-range').value}`);
    chart($('#env-chart'), data.points.map((p) => ({ x: p.t, y: p.v })), { unit: meta.unit, decimals: meta.decimals, xType: 'time', name: meta.label });
  };
  $('#env-param').addEventListener('change', load);
  $('#env-range').addEventListener('change', load);
  load().catch((e) => toast(e.message, true));
  S.viewTimer = setInterval(() => load().catch(() => {}), 15000);
  S.live = () => {
    setHtml($('#env-tiles'), envTiles());
    setHtml($('#shelter-status'), S.state.shelter ? '<span class="pill caution">▲ IN STORM SHELTER</span>' : '<span class="pill">Not sheltered</span>');
    const rows = S.state.crew.filter((c) => c.dose);
    setHtml($('#dose'), rows.length ? `<table><thead><tr><th>Crew member</th><th class="num">Dose (mSv)</th><th>Of career limit</th><th class="num">Projected, end of mission</th></tr></thead><tbody>${rows.map((c) => `<tr><td>${esc(c.name)}</td><td class="num">${fmt(c.dose.cumulativeMsv, 1)}</td><td><div class="row"><div class="bar" style="flex:1"><i style="width:${Math.min(100, c.dose.pct).toFixed(1)}%"></i></div><span class="small tabular">${fmt(c.dose.pct)}%</span></div></td><td class="num">${fmt(c.dose.projectedMsv)} mSv${c.dose.projectedPct > 100 ? ' <span class="pill caution">▲ OVER LIMIT</span>' : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="small muted">Individual dose is part of the medical record.</p>');
  };
  S.live();
}

// ---------- Pharmacy ----------

async function viewPharmacy(view) {
  view.innerHTML = '<p class="muted">Loading…</p>';
  const { inventory } = await api('/api/pharmacy');
  const flagPill = { expired: '<span class="pill bad">✖ EXPIRED</span>', expiring: '<span class="pill caution">▲ EXPIRES SOON</span>', out: '<span class="pill bad">✖ OUT</span>', low: '<span class="pill caution">▲ LOW</span>' };
  const canGive = isOnboard();
  const crewOptions = S.state.crew.filter((c) => S.user.role === 'cmo' || c.id === S.user.crewId).map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  view.innerHTML = `<div class="page-head"><h1>Pharmacy</h1></div>
    <div class="stack">
    ${canGive ? `<section class="card"><h2>Give a dose</h2>
      <form data-form="administer" class="form-grid">
        <label>Crew member<select name="crewId">${crewOptions}</select></label>
        <label>Medication<select name="medId">${inventory.map((m) => `<option value="${esc(m.id)}">${esc(m.name)} ${esc(m.dose)}</option>`).join('')}</select></label>
        <label class="full">Indication<input name="indication" maxlength="300"></label>
        <label class="full" id="override-wrap" hidden>Reason for overriding the safety check (recorded)<input name="overrideReason" maxlength="300"></label>
        <button type="button" data-action="check-dose">Check safety</button>
        <button class="primary" type="submit">Record dose</button>
      </form><div id="dose-check" style="margin-top:8px"></div></section>` : ''}
    <section class="card"><h2>Inventory</h2><div class="table-wrap"><table>
      <thead><tr><th>Medication</th><th>Class</th><th class="num">Quantity</th><th>Expires</th><th>Self-administer</th><th>Status</th></tr></thead>
      <tbody>${inventory.map((m) => `<tr><td>${esc(m.name)} <span class="small muted">${esc(m.dose)}</span></td><td>${esc(m.drugClass)}</td><td class="num">${esc(m.qty)}</td><td>${utcFull(m.expiresAt).slice(0, 10)}</td><td>${m.selfAdmin ? 'Yes' : 'CMO only'}</td><td>${m.flags.map((f) => flagPill[f]).join(' ') || '<span class="pill good">✓ OK</span>'}</td></tr>`).join('')}</tbody></table></div>
      <p class="small muted" style="margin-top:8px">Doses are reference defaults and must be validated against the approved flight formulary.</p></section>
    </div>`;
}

function showDoseCheck(check) {
  const list = (cls, label, items) => items.map((t) => `<p class="small"><span class="pill ${cls}">${label}</span> ${esc(t)}</p>`).join('');
  const needsOverride = check.blocks.length > 0 && check.hardStops.length === 0;
  const ok = check.allowed && !check.warnings.length ? '<p class="small"><span class="pill good">✓ PASSED</span> No safety issues found.</p>' : '';
  $('#dose-check').innerHTML = list('bad', '✖ STOP', check.hardStops) + list('bad', '✖ BLOCKED', check.blocks) + list('caution', '▲ WARNING', check.warnings) + ok;
  const wrap = $('#override-wrap');
  if (wrap) wrap.hidden = !(needsOverride && S.user.role === 'cmo');
}

// ---------- Protocols ----------

function viewProtocols(open) {
  const view = $('#view');
  const order = { emergency: 0, urgent: 1, routine: 2 };
  const pillFor = { emergency: '<span class="pill emergency">✖ EMERGENCY</span>', urgent: '<span class="pill warning">◆ URGENT</span>', routine: '<span class="pill">ROUTINE</span>' };
  const items = [...S.ref.protocols].sort((a, b) => order[a.urgency] - order[b.urgency]);
  view.innerHTML = `<div class="page-head"><h1>Medical response protocols</h1></div>
    <p class="small secondary" style="margin-bottom:12px">For use when light-time delay rules out real-time support. These are summary cards; the mission's approved medical checklists govern.</p>
    <div class="stack">${items.map((p) => `<details class="card protocol" id="p-${esc(p.id)}" ${p.id === open ? 'open' : ''}><summary>${esc(p.title)} ${pillFor[p.urgency]}</summary><ol>${p.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></details>`).join('')}</div>`;
  if (open) requestAnimationFrame(() => document.getElementById(`p-${open}`)?.scrollIntoView());
}

// ---------- Comms ----------

async function viewComms(view) {
  const channels = await api('/api/channels');
  view.innerHTML = `<div class="page-head"><h1>Comms</h1></div>
    <div class="stack">
      <section class="card"><h2>Space-ground link</h2><div id="link-tiles"></div></section>
      <section class="card">
        <label style="margin-bottom:8px">Channel<select id="channel">${channels.map((c) => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join('')}</select></label>
        <div class="msg-list" id="messages"></div>
        <form data-form="message" class="stack" style="margin-top:8px">
          <label>Message<textarea name="text" maxlength="4000" required></textarea></label>
          <div class="row"><label class="check"><input type="checkbox" name="urgent"> Urgent (sent ahead of routine traffic)</label><span class="spacer"></span><button class="primary" type="submit">Send</button></div>
        </form>
      </section>
    </div>`;
  const load = async () => {
    const el = $('#messages');
    if (!el) return;
    const rows = await api(`/api/messages?channel=${encodeURIComponent($('#channel').value)}`);
    setHtml(el, rows.map((m) => `<div class="msg"><div class="small muted">${utcFull(m.ts)} UTC · ${esc(m.from)}${m.urgent ? ' · <span class="pill caution">▲ URGENT</span>' : ''}${m.inTransit ? ' · in transit' : ' · delivered'}</div>${esc(m.text)}</div>`).join('') || '<p class="small muted">No messages on this channel.</p>');
  };
  S.reloadMessages = load;
  $('#channel').addEventListener('change', load);
  load().catch((e) => toast(e.message, true));
  S.viewTimer = setInterval(() => load().catch(() => {}), 3000);
  S.live = () => {
    const l = S.state.link;
    setHtml($('#link-tiles'), `<div class="tiles big">
      ${tile('Status', l.los ? '✖ LOS' : '✓ Up', '')}
      ${tile('One-way delay', fmt(l.delaySec, l.delaySec < 10 ? 2 : 0), ' s')}
      ${tile('Queued to ground', fmt(l.queuedDown), '')}
      ${tile('Queued to spacecraft', fmt(l.queuedUp), '')}
      ${tile('Delivered', fmt(l.delivered), '')}
      ${tile('Telemetry shed', fmt(l.shed), '')}
    </div><p class="small muted" style="margin-top:8px">Bundles are held and forwarded in priority order: emergencies, alerts, messages, then telemetry. Only the oldest telemetry is ever discarded.</p>`);
  };
  S.live();
}

// ---------- Training ----------

function viewTraining(view) {
  const crewOptions = S.state.crew.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  view.innerHTML = `<div class="page-head"><h1>Training and simulation</h1></div>
    <div class="stack">
      ${S.state.dataSource === 'simulator' ? `<section class="card"><div class="row"><h2>Running scenarios</h2><span class="spacer"></span><button class="small" data-action="stop-all">Stop all</button></div><div id="running"></div></section>
      <section class="card"><h2>Inject a scenario</h2>
        <label style="margin-bottom:12px;max-width:280px">Crew member (crew scenarios)<select id="sc-crew">${crewOptions}</select></label>
        <div class="grid cols-3">${Object.entries(S.ref.scenarios).map(([k, s]) => `<div class="tile"><strong>${esc(s.label)}</strong><div class="small secondary" style="margin:4px 0 8px">${esc(s.description)}</div><button class="small primary" data-action="start-scenario" data-type="${esc(k)}">Start ${s.scope === 'cabin' ? '(whole cabin)' : ''}</button></div>`).join('')}</div>
      </section>` : '<section class="card"><p class="secondary">Training scenarios are available only in simulator mode.</p></section>'}
      <section class="card"><h2>Link conditions</h2>
        <div class="row">${Object.entries(S.ref.linkPresets).map(([k, p]) => `<button class="small" data-action="link-preset" data-delay="${p.delaySec}">${esc(p.label)}</button>`).join('')}
        <button class="small danger" data-action="toggle-los">Toggle loss of signal</button></div>
        <p class="small muted" style="margin-top:8px">Sign in as the flight surgeon and as the CMO in separate browsers to watch the same event reach the ground later than it appears on board.</p>
      </section>
    </div>`;
  S.live = () => {
    const el = $('#running');
    if (el) setHtml(el, S.state.scenarios.length ? S.state.scenarios.map((s) => `<div class="row" style="margin-bottom:4px"><span class="pill caution">▲ ${esc(S.ref.scenarios[s.type].label)}</span> <span class="small secondary">${esc(s.crewId ? crewName(s.crewId) : 'Whole cabin')}, started ${utc(s.startedAt)} UTC</span> <button class="small" data-action="stop-scenario" data-id="${esc(s.id)}">Stop</button></div>`).join('') : '<p class="small muted">None. Nominal physiology.</p>');
  };
  S.live();
}

// ---------- Audit ----------

async function viewAudit(view) {
  view.innerHTML = `<div class="page-head"><h1>Audit log</h1><button class="small" data-action="verify-audit">Verify integrity</button><span id="audit-result"></span></div>
    <section class="card"><div class="table-wrap" id="audit"><p class="muted">Loading…</p></div></section>`;
  const rows = await api('/api/audit');
  $('#audit').innerHTML = `<table><thead><tr><th class="num">#</th><th>Time (UTC)</th><th>Actor</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead><tbody>${rows.map((r) => `<tr><td class="num">${esc(r.seq)}</td><td>${utcFull(r.ts)}</td><td>${esc(r.actor)}</td><td>${esc(r.action)}</td><td>${esc(r.target ?? '')}</td><td class="small secondary">${esc(r.detail ? JSON.stringify(r.detail) : '')}</td></tr>`).join('')}</tbody></table>`;
}

// ---------- Dialog ----------

function askSilence(id) {
  const dialog = $('#dialog');
  dialog.innerHTML = `<form data-form="silence" data-id="${esc(id)}" class="stack">
    <h2>Silence alarm tone</h2>
    <p class="small secondary">The alert stays visible and active. Only the sound stops.</p>
    <label>Minutes<input type="number" name="minutes" min="1" max="60" value="15" required></label>
    <label>Reason (recorded)<input name="reason" maxlength="300" required></label>
    <div class="row"><span class="spacer"></span><button type="button" data-action="close-dialog">Cancel</button><button class="primary" type="submit">Silence</button></div>
  </form>`;
  dialog.showModal();
}

// ---------- Event handlers ----------

const parseLimits = (text) => {
  if (!text || !text.trim()) return undefined;
  const parts = text.split(',').map((t) => (t.trim() === '' || t.trim() === '-' ? null : Number(t)));
  if (parts.length !== 3 || parts.some((p) => p !== null && !Number.isFinite(p))) throw new Error('Enter limits as three numbers: caution, warning, emergency.');
  return parts;
};

const actions = {
  logout: async () => {
    await api('/api/logout', { method: 'POST', body: {} });
    showLogin();
  },
  mute: (el) => {
    S.muted = !S.muted;
    el.textContent = S.muted ? 'Sound off' : 'Sound on';
  },
  ack: async (el) => ack(await api(`/api/alerts/${el.dataset.id}/ack`, { method: 'POST', body: {} })),
  silence: (el) => askSilence(el.dataset.id),
  'close-dialog': () => $('#dialog').close(),
  print: () => window.print(),
  shelter: async () => {
    await api('/api/environment/shelter', { method: 'POST', body: { on: !S.state.shelter } });
  },
  'resolve-symptom': async (el) => {
    ack(await api(`/api/symptoms/${el.dataset.id}/resolve`, { method: 'POST', body: {} }));
    route();
  },
  'release-hold': async (el) => ack(await api(`/api/crew/${el.dataset.id}/hold`, { method: 'POST', body: { release: true } })),
  'reset-limits': async (el) => {
    const form = el.closest('form');
    const v = formValues(form);
    if (!v.reason) throw new Error('A reason is required.');
    ack(await api(`/api/crew/${el.dataset.id}/limits`, { method: 'POST', body: { param: v.param, reason: v.reason } }));
  },
  'check-dose': async (el) => {
    const v = formValues(el.closest('form'));
    showDoseCheck(await api('/api/pharmacy/check', { method: 'POST', body: { crewId: v.crewId, medId: v.medId } }));
  },
  'start-scenario': async (el) => {
    await api('/api/training/scenarios', { method: 'POST', body: { type: el.dataset.type, crewId: $('#sc-crew').value } });
    toast('Scenario started. It may take a minute for physiology to change.');
  },
  'stop-scenario': (el) => api('/api/training/scenarios/stop', { method: 'POST', body: { id: el.dataset.id } }),
  'stop-all': () => api('/api/training/scenarios/stop', { method: 'POST', body: { id: 'all' } }),
  'link-preset': async (el) => {
    await api('/api/training/link', { method: 'POST', body: { delaySec: Number(el.dataset.delay) } });
    toast('Link delay updated.');
  },
  'toggle-los': () => api('/api/training/link', { method: 'POST', body: { los: !S.state.link.los } }),
  'verify-audit': async () => {
    const r = await api('/api/audit/verify');
    $('#audit-result').innerHTML = r.ok ? `<span class="pill good">✓ INTACT: ${r.count} entries verified</span>` : `<span class="pill bad">✖ TAMPERED at entry ${r.brokenAt}</span>`;
  },
};

const forms = {
  login: async (v) => {
    const { user } = await api('/api/login', { method: 'POST', body: { username: v.username, password: v.password } });
    S.audio ??= (() => { try { return new AudioContext(); } catch { return null; } })();
    await startSession(user);
  },
  checkin: async (v, f) => {
    await api(`/api/crew/${f.dataset.id}/checkin`, { method: 'POST', body: v });
    toast('Check recorded.');
  },
  daily: async (v, f) => {
    const r = await api(`/api/crew/${f.dataset.id}/daily`, { method: 'POST', body: v });
    toast(`Log saved for mission day ${r.missionDay}.`);
    route();
  },
  exam: async (v, f) => {
    await api(`/api/crew/${f.dataset.id}/exams`, { method: 'POST', body: v });
    toast('Exam recorded.');
    route();
  },
  symptom: async (v, f) => {
    const r = await api(`/api/crew/${f.dataset.id}/symptoms`, { method: 'POST', body: v });
    toast(`Reported. Triage: ${r.triage}.${r.protocol ? ' A protocol is linked from the alert.' : ''}`);
    route();
  },
  encounter: async (v, f) => {
    await api(`/api/crew/${f.dataset.id}/encounters`, { method: 'POST', body: v });
    toast('Note added.');
    route();
  },
  hold: async (v, f) => ack(await api(`/api/crew/${f.dataset.id}/hold`, { method: 'POST', body: { reason: v.reason } })),
  limits: async (v, f) => {
    const override = {};
    const low = parseLimits(v.low);
    const high = parseLimits(v.high);
    if (low) override.low = low;
    if (high) override.high = high;
    ack(await api(`/api/crew/${f.dataset.id}/limits`, { method: 'POST', body: { param: v.param, reason: v.reason, override } }));
  },
  administer: async (v, f) => {
    try {
      const r = await api('/api/pharmacy/administer', { method: 'POST', body: v });
      toast(`Dose recorded.${r.warnings.length ? ` Note: ${r.warnings.join(' ')}` : ''}`);
      await viewPharmacy($('#view'));
    } catch (err) {
      if (err.data?.check) showDoseCheck(err.data.check);
      throw err;
    }
  },
  message: async (v, f) => {
    const r = await api('/api/messages', { method: 'POST', body: { channel: $('#channel').value, text: v.text, urgent: v.urgent } });
    f.reset();
    toast(r.los ? 'Queued. It will send when signal returns.' : `Sent. It arrives in about ${fmt(r.etaSec)} s.`);
    await S.reloadMessages?.();
  },
  silence: async (v, f) => {
    ack(await api(`/api/alerts/${f.dataset.id}/silence`, { method: 'POST', body: v }));
    $('#dialog').close();
  },
};

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  e.preventDefault();
  S.audio?.resume?.();
  try {
    await actions[el.dataset.action]?.(el);
  } catch (err) {
    toast(err.message, true);
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  try {
    await forms[form.dataset.form](formValues(form), form);
  } catch (err) {
    if (form.dataset.form === 'login') showLogin(err.message);
    else toast(err.message, true);
  }
});

window.addEventListener('hashchange', route);

// ---------- Start ----------

api('/api/me').then(({ user }) => startSession(user)).catch(() => showLogin());
