import { useEffect, useState } from 'react';
import { AlertList, Loading, ReadyPill, SevPill, StaleTag, Tile, VitalTiles } from './components.jsx';
import { Chart } from './charts.jsx';
import { api, fmt, formValues, post, useApp, useLoad, utc, utcFull } from './lib.js';

function EnvTiles() {
  const { state, ref: reference } = useApp();
  if (!state.env) return <p className="muted small">No cabin data.</p>;
  const worst = (param) => state.alerts.filter((a) => a.category === 'environment' && a.param === param && !a.clearedAt).reduce((m, a) => Math.max(m, a.severity), 0);
  return (
    <div className="tiles big">
      {Object.entries(reference.envParams).map(([k, m]) => <Tile key={k} label={m.label} value={fmt(state.env[k], m.decimals)} unit={` ${m.unit}`} severity={worst(k)} />)}
    </div>
  );
}

function CrewCard({ c }) {
  const ready = c.readiness ?? { duty: { status: 'UNKNOWN' }, eva: { status: 'UNKNOWN' } };
  const status = (
    <div className="row small" style={{ marginTop: 8 }}>
      <span className="muted">Duty</span> <ReadyPill status={ready.duty.status} /> <span className="muted">EVA</span> <ReadyPill status={ready.eva.status} />
    </div>
  );
  const head = (
    <header>
      <div>
        <h2>{c.medicalAccess ? <a href={`#/crew/${c.id}`}>{c.name}</a> : c.name}</h2>
        <div className="small muted">{c.role}</div>
      </div>
      <span className="spacer" />
      <StaleTag c={c} />
    </header>
  );
  if (!c.medicalAccess) {
    return <div className="card crew-card">{head}<p className="small muted">Medical details are confidential to this crew member and the medical team.</p>{status}</div>;
  }
  const facts = [
    c.activity ? `Activity: ${c.activity}` : null,
    c.rhythm && c.rhythm !== 'insufficient' ? `Rhythm: ${c.rhythm}` : null,
    c.rmssd !== null && c.rmssd !== undefined ? `HRV ${c.rmssd} ms` : null,
    c.battery !== null && c.battery !== undefined ? `Battery ${c.battery}%` : null,
  ].filter(Boolean);
  return (
    <div className="card crew-card">
      {head}
      <VitalTiles c={c} />
      <div className="small muted" style={{ marginTop: 8 }}>{facts.join(' · ')}</div>
      {c.hold && <div className="row small" style={{ marginTop: 6 }}><span className="pill bad">✖ MEDICAL HOLD</span> {c.hold.reason}</div>}
      {status}
    </div>
  );
}

export function Overview() {
  const { state } = useApp();
  return (
    <>
      <div className="page-head"><h1>Crew overview</h1></div>
      <div className="stack">
        <div className="crew-grid">{state.crew.map((c) => <CrewCard key={c.id} c={c} />)}</div>
        <section className="card"><h2>Active alerts</h2><AlertList alerts={state.alerts} /></section>
        <section className="card"><h2>Cabin environment</h2><EnvTiles /></section>
      </div>
    </>
  );
}

export function Alerts() {
  const { state } = useApp();
  const { data: rows, error } = useLoad(() => api('/api/alerts/history'), [], 10000);
  const crewName = (id) => (id ? state.crew.find((c) => c.id === id)?.name ?? id : 'Cabin');
  return (
    <>
      <div className="page-head"><h1>Alerts</h1></div>
      <div className="stack">
        <section className="card"><h2>Active</h2><AlertList alerts={state.alerts} /></section>
        <section className="card">
          <h2>History</h2>
          {!rows ? <Loading error={error} /> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Raised (UTC)</th><th>Severity</th><th>Who</th><th>Alert</th><th>Status</th><th>Acknowledged by</th></tr></thead>
                <tbody>
                  {rows.length ? rows.map((a) => <tr key={a.id}><td>{utcFull(a.raisedAt)}</td><td><SevPill severity={a.severity} /></td><td>{crewName(a.crewId)}</td><td>{a.title}</td><td>{a.status}</td><td>{a.ackedBy ?? ''}</td></tr>)
                    : <tr><td colSpan="6" className="muted">No alerts yet.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

const Reason = ({ list }) => (list?.length ? <div className="small secondary">{list.join('; ')}</div> : null);

export function Readiness() {
  const { state } = useApp();
  return (
    <>
      <div className="page-head"><h1>Crew readiness</h1></div>
      <section className="card">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Crew member</th><th>Fit for duty</th><th>EVA</th></tr></thead>
            <tbody>
              {state.crew.map((c) => (
                <tr key={c.id}>
                  <td><strong>{c.name}</strong><div className="small muted">{c.role}</div></td>
                  <td><ReadyPill status={c.readiness?.duty.status} /><Reason list={c.readiness?.duty.reasons} /></td>
                  <td><ReadyPill status={c.readiness?.eva.status} /><Reason list={c.readiness?.eva.reasons} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ marginTop: 8 }}>These results support the flight surgeon's decision and don't replace it. Missing data shows as UNKNOWN, never as GO. Command and operations see status only; the reasons stay confidential.</p>
      </section>
    </>
  );
}

export function Environment() {
  const { state, ref: reference, user, toast } = useApp();
  const [param, setParam] = useState('co2');
  const [minutes, setMinutes] = useState('30');
  const { data: trend } = useLoad(() => api(`/api/environment/history?param=${param}&minutes=${minutes}`), [param, minutes], 15000);
  const meta = reference.envParams[param];
  const canShelter = state.node === 'onboard' && (user.role === 'cmo' || user.role === 'commander');
  const rows = state.crew.filter((c) => c.dose);
  const toggle = () => post('/api/environment/shelter', { on: !state.shelter }).catch((e) => toast(e.message, true));
  return (
    <>
      <div className="page-head"><h1>Cabin environment and radiation</h1></div>
      <div className="stack">
        <EnvTiles />
        <section className="card">
          <div className="row">
            <h2>Trend</h2><span className="spacer" />
            <select style={{ width: 'auto' }} aria-label="Parameter" value={param} onChange={(e) => setParam(e.target.value)}>
              {Object.entries(reference.envParams).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
            </select>
            <select style={{ width: 'auto' }} aria-label="Time range" value={minutes} onChange={(e) => setMinutes(e.target.value)}>
              <option value="30">30 min</option><option value="120">2 h</option><option value="1440">24 h</option>
            </select>
          </div>
          {trend && <Chart points={trend.points.map((p) => ({ x: p.t, y: p.v }))} unit={meta.unit} decimals={meta.decimals} name={meta.label} />}
        </section>
        <section className="card">
          <div className="row">
            <h2>Radiation dose by crew member</h2><span className="spacer" />
            {state.shelter ? <span className="pill caution">▲ IN STORM SHELTER</span> : <span className="pill">Not sheltered</span>}
            {canShelter && <button className="small" onClick={toggle}>Toggle storm shelter</button>}
          </div>
          {rows.length ? (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Crew member</th><th className="num">Dose (mSv)</th><th>Of career limit</th><th className="num">Projected, end of mission</th></tr></thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id}>
                      <td>{c.name}</td>
                      <td className="num">{fmt(c.dose.cumulativeMsv, 1)}</td>
                      <td><div className="row"><div className="bar" style={{ flex: 1 }}><i style={{ width: `${Math.min(100, c.dose.pct).toFixed(1)}%` }} /></div><span className="small tabular">{fmt(c.dose.pct)}%</span></div></td>
                      <td className="num">{fmt(c.dose.projectedMsv)} mSv{c.dose.projectedPct > 100 && <> <span className="pill caution">▲ OVER LIMIT</span></>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="small muted">Individual dose is part of the medical record.</p>}
          <p className="small muted" style={{ marginTop: 8 }}>Limit: 600 mSv career effective dose (NASA-STD-3001). Each person's dose is estimated from the cabin reading; storm shelter assumes a 0.4 shielding factor. Personal dosimeters remain the record of dose.</p>
        </section>
      </div>
    </>
  );
}

const FLAG_PILL = {
  expired: <span className="pill bad" key="expired">✖ EXPIRED</span>,
  expiring: <span className="pill caution" key="expiring">▲ EXPIRES SOON</span>,
  out: <span className="pill bad" key="out">✖ OUT</span>,
  low: <span className="pill caution" key="low">▲ LOW</span>,
};

function DoseCheck({ check }) {
  const list = (cls, label, items) => items.map((t) => <p className="small" key={`${label}${t}`}><span className={`pill ${cls}`}>{label}</span> {t}</p>);
  return (
    <div style={{ marginTop: 8 }}>
      {list('bad', '✖ STOP', check.hardStops)}
      {list('bad', '✖ BLOCKED', check.blocks)}
      {list('caution', '▲ WARNING', check.warnings)}
      {check.allowed && !check.warnings.length && <p className="small"><span className="pill good">✓ PASSED</span> No safety issues found.</p>}
    </div>
  );
}

export function Pharmacy() {
  const { state, user, toast } = useApp();
  const { data, error, reload } = useLoad(() => api('/api/pharmacy'), []);
  const [medId, setMedId] = useState(null);
  const [crewId, setCrewId] = useState(user.crewId ?? '');
  const [check, setCheck] = useState(null);
  if (!data) return <Loading error={error} />;
  const { inventory } = data;
  const selectedMed = medId ?? inventory[0]?.id;
  const med = inventory.find((m) => m.id === selectedMed);
  // The CMO treats anyone, and any crew member may give an emergency drug to a crewmate
  const crewOptions = state.crew.filter((c) => user.role === 'cmo' || med?.emergency || c.id === user.crewId);
  const selectedCrew = crewOptions.some((c) => c.id === crewId) ? crewId : crewOptions[0]?.id;
  const needsOverride = check && check.blocks.length > 0 && check.hardStops.length === 0 && user.role === 'cmo';

  const runCheck = async () => {
    try {
      setCheck(await post('/api/pharmacy/check', { crewId: selectedCrew, medId: selectedMed }));
    } catch (err) {
      toast(err.message, true);
    }
  };
  const give = async (e) => {
    e.preventDefault();
    try {
      const v = formValues(e.target);
      const r = await post('/api/pharmacy/administer', { crewId: selectedCrew, medId: selectedMed, indication: v.indication, overrideReason: v.overrideReason ?? '' });
      toast(`Dose recorded.${r.warnings.length ? ` Note: ${r.warnings.join(' ')}` : ''}`);
      setCheck(null);
      e.target.reset();
      reload();
    } catch (err) {
      if (err.data?.check) setCheck(err.data.check);
      toast(err.message, true);
    }
  };
  // A result belongs to one crew member and one drug: never leave it showing for another
  const changeMed = (e) => { setMedId(e.target.value); setCheck(null); };
  const changeCrew = (e) => { setCrewId(e.target.value); setCheck(null); };

  return (
    <>
      <div className="page-head"><h1>Pharmacy</h1></div>
      <div className="stack">
        {state.node === 'onboard' && (
          <section className="card">
            <h2>Give a dose</h2>
            <form className="form-grid" onSubmit={give}>
              <label>Crew member<select value={selectedCrew} onChange={changeCrew}>{crewOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
              <label>Medication<select value={selectedMed} onChange={changeMed}>{inventory.map((m) => <option key={m.id} value={m.id}>{m.name} {m.dose}</option>)}</select></label>
              <label className="full">Indication<input name="indication" maxLength="300" /></label>
              {needsOverride && <label className="full">Reason for overriding the safety check (recorded)<input name="overrideReason" maxLength="300" /></label>}
              <button type="button" onClick={runCheck}>Check safety</button>
              <button className="primary" type="submit">Record dose</button>
            </form>
            {check && <DoseCheck check={check} />}
          </section>
        )}
        <section className="card">
          <h2>Inventory</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Medication</th><th>Class</th><th className="num">Quantity</th><th>Expires</th><th>Self-administer</th><th>Status</th></tr></thead>
              <tbody>
                {inventory.map((m) => (
                  <tr key={m.id}>
                    <td>{m.name} <span className="small muted">{m.dose}</span></td>
                    <td>{m.drugClass}</td>
                    <td className="num">{m.qty}</td>
                    <td>{utcFull(m.expiresAt).slice(0, 10)}</td>
                    <td>{m.selfAdmin ? 'Yes' : 'CMO only'}</td>
                    <td>{m.flags.length ? m.flags.map((f) => FLAG_PILL[f]) : <span className="pill good">✓ OK</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted" style={{ marginTop: 8 }}>Doses are reference defaults and must be validated against the approved flight formulary.</p>
        </section>
      </div>
    </>
  );
}

const URGENCY_PILL = {
  emergency: <span className="pill emergency">✖ EMERGENCY</span>,
  urgent: <span className="pill warning">◆ URGENT</span>,
  routine: <span className="pill">ROUTINE</span>,
};
const URGENCY_ORDER = { emergency: 0, urgent: 1, routine: 2 };

export function Protocols({ open }) {
  const { ref: reference } = useApp();
  const items = [...reference.protocols].sort((a, b) => URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency]);
  useEffect(() => {
    if (open) document.getElementById(`p-${open}`)?.scrollIntoView();
  }, [open]);
  return (
    <>
      <div className="page-head"><h1>Medical response protocols</h1></div>
      <p className="small secondary" style={{ marginBottom: 12 }}>For use when light-time delay rules out real-time support. These are summary cards; the mission's approved medical checklists govern.</p>
      <div className="stack">
        {items.map((p) => (
          <details className="card protocol" id={`p-${p.id}`} key={p.id} open={p.id === open}>
            <summary>{p.title} {URGENCY_PILL[p.urgency]}</summary>
            <ol>{p.steps.map((s) => <li key={s}>{s}</li>)}</ol>
          </details>
        ))}
      </div>
    </>
  );
}

export function Comms() {
  const { state, toast } = useApp();
  const { data: channels, error } = useLoad(() => api('/api/channels'), []);
  const [channel, setChannel] = useState('ops');
  const { data: messages, reload } = useLoad(() => api(`/api/messages?channel=${encodeURIComponent(channel)}`), [channel], 3000);
  const l = state.link;
  if (!channels) return <Loading error={error} />;
  const send = async (e) => {
    e.preventDefault();
    try {
      const v = formValues(e.target);
      const r = await post('/api/messages', { channel, text: v.text, urgent: v.urgent });
      e.target.reset();
      toast(r.los ? 'Queued. It will send when signal returns.' : `Sent. It arrives in about ${fmt(r.etaSec)} s.`);
      reload();
    } catch (err) {
      toast(err.message, true);
    }
  };
  return (
    <>
      <div className="page-head"><h1>Comms</h1></div>
      <div className="stack">
        <section className="card">
          <h2>Space-ground link</h2>
          <div className="tiles big">
            <Tile label="Status" value={l.los ? '✖ LOS' : '✓ Up'} />
            <Tile label="One-way delay" value={fmt(l.delaySec, l.delaySec < 10 ? 2 : 0)} unit=" s" />
            <Tile label="Queued to ground" value={fmt(l.queuedDown)} />
            <Tile label="Queued to spacecraft" value={fmt(l.queuedUp)} />
            <Tile label="Delivered" value={fmt(l.delivered)} />
            <Tile label="Telemetry shed" value={fmt(l.shed)} />
          </div>
          <p className="small muted" style={{ marginTop: 8 }}>Bundles are held and forwarded in priority order: emergencies, alerts, messages, then telemetry. Only the oldest telemetry is ever discarded.</p>
        </section>
        <section className="card">
          <label style={{ marginBottom: 8 }}>Channel
            <select value={channel} onChange={(e) => setChannel(e.target.value)}>{channels.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
          </label>
          <div className="msg-list">
            {messages?.length ? messages.map((m) => (
              <div className="msg" key={m.id}>
                <div className="small muted">{utcFull(m.ts)} UTC · {m.from}{m.urgent && <> · <span className="pill caution">▲ URGENT</span></>}{m.inTransit ? ' · in transit' : ' · delivered'}</div>
                {m.text}
              </div>
            )) : <p className="small muted">No messages on this channel.</p>}
          </div>
          <form className="stack" style={{ marginTop: 8 }} onSubmit={send}>
            <label>Message<textarea name="text" maxLength="4000" required /></label>
            <div className="row">
              <label className="check"><input type="checkbox" name="urgent" /> Urgent (sent ahead of routine traffic)</label>
              <span className="spacer" /><button className="primary" type="submit">Send</button>
            </div>
          </form>
        </section>
      </div>
    </>
  );
}

export function Training() {
  const { state, ref: reference, toast } = useApp();
  const [crewId, setCrewId] = useState(state.crew[0]?.id);
  const run = (fn) => () => fn().catch((e) => toast(e.message, true));
  const crewName = (id) => state.crew.find((c) => c.id === id)?.name ?? id;
  return (
    <>
      <div className="page-head"><h1>Training and simulation</h1></div>
      <div className="stack">
        {state.dataSource === 'simulator' ? (
          <>
            <section className="card">
              <div className="row"><h2>Running scenarios</h2><span className="spacer" /><button className="small" onClick={run(() => post('/api/training/scenarios/stop', { id: 'all' }))}>Stop all</button></div>
              {state.scenarios.length ? state.scenarios.map((s) => (
                <div className="row" style={{ marginBottom: 4 }} key={s.id}>
                  <span className="pill caution">▲ {reference.scenarios[s.type].label}</span>
                  <span className="small secondary">{s.crewId ? crewName(s.crewId) : 'Whole cabin'}, started {utc(s.startedAt)} UTC</span>
                  <button className="small" onClick={run(() => post('/api/training/scenarios/stop', { id: s.id }))}>Stop</button>
                </div>
              )) : <p className="small muted">None. Nominal physiology.</p>}
            </section>
            <section className="card">
              <h2>Inject a scenario</h2>
              <label style={{ marginBottom: 12, maxWidth: 280 }}>Crew member (crew scenarios)
                <select value={crewId} onChange={(e) => setCrewId(e.target.value)}>{state.crew.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
              </label>
              <div className="grid cols-3">
                {Object.entries(reference.scenarios).map(([k, s]) => (
                  <div className="tile" key={k}>
                    <strong>{s.label}</strong>
                    <div className="small secondary" style={{ margin: '4px 0 8px' }}>{s.description}</div>
                    <button className="small primary" onClick={run(async () => {
                      await post('/api/training/scenarios', { type: k, crewId });
                      toast('Scenario started. It may take a minute for physiology to change.');
                    })}>Start{s.scope === 'cabin' ? ' (whole cabin)' : ''}</button>
                  </div>
                ))}
              </div>
            </section>
          </>
        ) : <section className="card"><p className="secondary">Training scenarios are available only in simulator mode.</p></section>}
        <section className="card">
          <h2>Link conditions</h2>
          <div className="row">
            {Object.entries(reference.linkPresets).map(([k, p]) => (
              <button className="small" key={k} onClick={run(async () => {
                await post('/api/training/link', { delaySec: p.delaySec });
                toast('Link delay updated.');
              })}>{p.label}</button>
            ))}
            <button className="small danger" onClick={run(() => post('/api/training/link', { los: !state.link.los }))}>Toggle loss of signal</button>
          </div>
          <p className="small muted" style={{ marginTop: 8 }}>Sign in as the flight surgeon and as the CMO in separate browsers to watch the same event reach the ground later than it appears on board.</p>
        </section>
      </div>
    </>
  );
}

export function Audit() {
  const { toast } = useApp();
  const { data: rows, error } = useLoad(() => api('/api/audit'), []);
  const [result, setResult] = useState(null);
  const verify = () => api('/api/audit/verify').then(setResult).catch((e) => toast(e.message, true));
  return (
    <>
      <div className="page-head">
        <h1>Audit log</h1>
        <button className="small" onClick={verify}>Verify integrity</button>
        {result && (result.ok ? <span className="pill good">✓ INTACT: {result.count} entries verified</span> : <span className="pill bad">✖ TAMPERED at entry {result.brokenAt}</span>)}
      </div>
      <section className="card">
        {!rows ? <Loading error={error} /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th className="num">#</th><th>Time (UTC)</th><th>Actor</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
              <tbody>
                {rows.map((r) => <tr key={r.seq}><td className="num">{r.seq}</td><td>{utcFull(r.ts)}</td><td>{r.actor}</td><td>{r.action}</td><td>{r.target ?? ''}</td><td className="small secondary">{r.detail ? JSON.stringify(r.detail) : ''}</td></tr>)}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
