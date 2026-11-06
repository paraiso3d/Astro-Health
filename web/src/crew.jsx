import { useState } from 'react';
import { AlertList, Loading, ReadyPill, SevPill, StaleTag, Tile, VitalTiles } from './components.jsx';
import { Chart, EcgMonitor } from './charts.jsx';
import { VITAL_PARAMS, api, fmt, formValues, parseLimits, post, useApp, useLoad, utcFull } from './lib.js';

const isMedical = (user) => user.role === 'flight_surgeon' || user.role === 'cmo';

export function CrewView({ id, tab }) {
  const { state, user } = useApp();
  const c = state.crew.find((x) => x.id === id);
  if (!c?.medicalAccess) {
    return <div className="card"><h2>Restricted</h2><p className="secondary">Medical details are confidential to this crew member and the medical team.</p></div>;
  }
  const base = id === user.crewId ? '#/me' : `#/crew/${id}`;
  const tabs = [['live', 'Live'], ['longterm', 'Long-term health'], ['record', 'Clinical record'], ['report', 'Report']];
  return (
    <>
      <div className="page-head"><h1>{c.name}</h1><span className="secondary">{c.role}</span></div>
      <div className="tabs">{tabs.map(([t, label]) => <a key={t} href={`${base}/${t}`} className={t === tab ? 'on' : ''}>{label}</a>)}</div>
      {tab === 'longterm' ? <LongTerm id={id} /> : tab === 'record' ? <Record id={id} /> : tab === 'report' ? <Report id={id} /> : <Live id={id} />}
    </>
  );
}

const Reasons = ({ list }) => (list?.length ? <ul className="small secondary" style={{ margin: '4px 0 0', paddingLeft: 18 }}>{list.map((t) => <li key={t}>{t}</li>)}</ul> : null);

function Live({ id }) {
  const { state, ref: reference, user, toast } = useApp();
  const x = state.crew.find((c) => c.id === id);
  const [param, setParam] = useState('hr');
  const [minutes, setMinutes] = useState('30');
  const { data: trend } = useLoad(() => api(`/api/crew/${id}/history?param=${param}&minutes=${minutes}`), [id, param, minutes], 15000);
  const meta = reference.vitals[param];
  const canCheck = state.node === 'onboard' && (user.crewId === id || user.role === 'cmo');
  const r = x.readiness;
  const b = x.baseline;
  const checkIn = async (e) => {
    e.preventDefault();
    try {
      await post(`/api/crew/${id}/checkin`, formValues(e.target));
      toast('Check recorded.');
    } catch (err) {
      toast(err.message, true);
    }
  };
  return (
    <div className="stack">
      <div><StaleTag c={x} /><VitalTiles c={x} big /></div>
      <section className="card">
        <div className="row"><h2>ECG monitor</h2><span className="small muted">Illustrative trace generated from reported rate and rhythm, not a raw clinical waveform.</span></div>
        <EcgMonitor crew={x} />
      </section>
      <section className="card">
        <div className="row">
          <h2>Trend</h2><span className="spacer" />
          <select style={{ width: 'auto' }} aria-label="Parameter" value={param} onChange={(e) => setParam(e.target.value)}>
            {VITAL_PARAMS.map((p) => <option key={p} value={p}>{reference.vitals[p].label}</option>)}
          </select>
          <select style={{ width: 'auto' }} aria-label="Time range" value={minutes} onChange={(e) => setMinutes(e.target.value)}>
            <option value="30">30 min</option><option value="120">2 h</option><option value="1440">24 h</option>
          </select>
        </div>
        {trend && <Chart points={trend.points.map((p) => ({ x: p.t, y: p.v }))} unit={meta.unit} decimals={meta.decimals} refValue={trend.baseline} refLabel="Personal baseline" name={meta.label} />}
      </section>
      <div className="grid cols-2">
        <section className="card">
          <h2>Status</h2>
          <div className="stack">
            <div className="row">Fit for duty <ReadyPill status={r?.duty.status} /></div>
            <Reasons list={r?.duty.reasons} />
            <div className="row">EVA <ReadyPill status={r?.eva.status} /></div>
            <Reasons list={r?.eva.reasons} />
            <div className="small secondary">Activity: {x.activity ?? '—'} · Rhythm screen: {x.rhythm ?? '—'} · HRV (RMSSD): {fmt(x.rmssd)} ms · Wearable battery: {fmt(x.battery)}%</div>
            <div className="small secondary">Fatigue: {x.fatigue?.level ?? '—'} · Last check: AVPU {x.checkin?.avpu}{x.checkin?.onOxygen ? ', on oxygen' : ''}{x.checkin?.by ? ` by ${x.checkin.by}` : ''}</div>
            <div className="small secondary">Radiation: {fmt(x.dose?.cumulativeMsv, 1)} mSv of {fmt(x.dose?.limitMsv)} mSv career limit; projected {fmt(x.dose?.projectedMsv)} mSv by end of mission; about {fmt(x.dose?.daysToLimit)} days to limit at the current rate</div>
            {x.hold && <div className="row small"><span className="pill bad">✖ MEDICAL HOLD</span> {x.hold.reason}</div>}
          </div>
        </section>
        <section className="card">
          <h2>Medical profile</h2>
          <table>
            <tbody>
              <tr><th>Age / sex</th><td>{x.age} / {x.sex}</td></tr>
              <tr><th>Blood type</th><td>{x.bloodType}</td></tr>
              <tr><th>Allergies</th><td>{x.allergies?.length ? <strong>{x.allergies.join(', ')}</strong> : 'None recorded'}</td></tr>
              <tr><th>Conditions</th><td>{x.conditions?.join(', ') || 'None recorded'}</td></tr>
              <tr><th>Baseline</th><td className="tabular">HR {b?.hr} · RR {b?.rr} · SpO2 {b?.spo2}% · BP {b?.sys}/{b?.dia} · {b?.temp} °C</td></tr>
            </tbody>
          </table>
        </section>
      </div>
      <section className="card"><h2>Alerts for this crew member</h2><AlertList alerts={state.alerts.filter((a) => a.crewId === id)} /></section>
      {canCheck && (
        <section className="card">
          <h2>Consciousness and oxygen check</h2>
          <form className="form-grid" onSubmit={checkIn}>
            <label>AVPU
              <select name="avpu">
                <option value="A">A: Alert</option><option value="C">C: New confusion</option><option value="V">V: Responds to voice</option>
                <option value="P">P: Responds to pain</option><option value="U">U: Unresponsive</option>
              </select>
            </label>
            <label className="check"><input type="checkbox" name="onOxygen" /> On supplemental oxygen</label>
            <button className="primary" type="submit">Record check</button>
          </form>
        </section>
      )}
    </div>
  );
}

function LongTerm({ id }) {
  const { state, user, toast } = useApp();
  const { data: lt, error, reload } = useLoad(() => api(`/api/crew/${id}/longterm`), [id]);
  if (!lt) return <Loading error={error} />;
  const canLog = state.node === 'onboard' && (user.crewId === id || user.role === 'cmo');
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
  const send = (path, done) => async (e) => {
    e.preventDefault();
    try {
      const result = await post(path, formValues(e.target));
      toast(done(result));
      reload();
    } catch (err) {
      toast(err.message, true);
    }
  };
  return (
    <div className="stack">
      <div className="tiles big">
        <Tile label="Fatigue risk" value={lt.fatigue.level} unit={lt.fatigue.score === null ? '' : ` score ${lt.fatigue.score}`} />
        <Tile label="3-day sleep debt" value={fmt(lt.fatigue.sleepDebtH, 1)} unit=" h" />
        <Tile label="Exercise adherence" value={fmt(lt.bone.adherencePct)} unit=" %" />
        <Tile label="Est. bone loss*" value={fmt(lt.bone.estLossPct, 1)} unit=" %" />
      </div>
      <p className="small muted">*Illustrative model for weight-bearing bone (about 1.25 %/month, halved at full exercise adherence). Use it to prompt a scan, never in place of one.</p>
      <section className="card">
        <h2>Findings</h2>
        {lt.findings.length ? lt.findings.map((f) => (
          <div key={f.code} className={`alert sev-${f.severity}`}>
            <div><SevPill severity={f.severity} /></div>
            <div className="body"><strong>{f.title}</strong><div className="small secondary">{f.message}</div></div>
          </div>
        )) : <p className="small muted">No long-term findings.</p>}
      </section>
      <div className="grid cols-2">
        {series.map(([key, label, unit, decimals, refValue, refLabel]) => (
          <section className="card" key={key}>
            <h2>{label}</h2>
            <Chart points={lt.logs.map((l) => ({ x: l.missionDay, y: l[key] }))} unit={unit} decimals={decimals} xType="day" refValue={refValue} refLabel={refLabel} name={label} height={170} />
          </section>
        ))}
      </div>
      <section className="card">
        <h2>Eye exams (SANS screening)</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Frisén grade</th><th className="num">Near acuity change</th><th className="num">IOP (mmHg)</th><th>Notes</th></tr></thead>
            <tbody>
              {lt.exams.length ? lt.exams.map((e) => <tr key={e.id}><td>{utcFull(e.ts).slice(0, 10)}</td><td>{e.frisenGrade}</td><td className="num">{e.acuityChange}</td><td className="num">{e.iopMmHg}</td><td>{e.notes}</td></tr>)
                : <tr><td colSpan="5" className="muted">No exams.</td></tr>}
            </tbody>
          </table>
        </div>
        {user.role === 'cmo' && (
          <form className="form-grid" style={{ marginTop: 12 }} onSubmit={send(`/api/crew/${id}/exams`, () => 'Exam recorded.')}>
            <label>Frisén grade (0-5)<input type="number" name="frisenGrade" min="0" max="5" step="1" required /></label>
            <label>Acuity change (lines)<input type="number" name="acuityChange" min="0" max="10" defaultValue="0" /></label>
            <label>IOP (mmHg)<input type="number" name="iopMmHg" min="1" max="80" step="0.1" required /></label>
            <label className="full">Notes<input name="notes" maxLength="2000" /></label>
            <button className="primary" type="submit">Record exam</button>
          </form>
        )}
      </section>
      {canLog && (
        <section className="card">
          <h2>Today's daily log</h2>
          <form className="form-grid" onSubmit={send(`/api/crew/${id}/daily`, (r) => `Log saved for mission day ${r.missionDay}.`)}>
            <label>Sleep (h)<input type="number" name="sleepH" min="0" max="24" step="0.1" required defaultValue={last?.sleepH} /></label>
            <label>Exercise (min)<input type="number" name="exerciseMin" min="0" max="600" required defaultValue={last?.exerciseMin} /></label>
            <label>Fluids (L)<input type="number" name="waterL" min="0" max="15" step="0.1" required defaultValue={last?.waterL} /></label>
            <label>Energy (kcal)<input type="number" name="kcal" min="0" max="10000" required defaultValue={last?.kcal} /></label>
            <label>Body mass (kg)<input type="number" name="weightKg" min="20" max="250" step="0.1" required defaultValue={last?.weightKg} /></label>
            <label>Mood (1-10)<input type="number" name="mood" min="1" max="10" step="0.1" required defaultValue={last?.mood} /></label>
            <label>Stress (1-10)<input type="number" name="stress" min="1" max="10" step="0.1" required defaultValue={last?.stress} /></label>
            <label>Vigilance lapses<input type="number" name="pvtLapses" min="0" max="100" defaultValue={last?.pvtLapses ?? 0} /></label>
            <button className="primary" type="submit">Save log</button>
          </form>
        </section>
      )}
    </div>
  );
}

function Record({ id }) {
  const { state, ref: reference, user, toast, ack } = useApp();
  const { data: rec, error, reload } = useLoad(() => api(`/api/crew/${id}/record`), [id]);
  if (!rec) return <Loading error={error} />;
  const canReport = state.node === 'onboard' && (user.crewId === id || user.role === 'cmo');
  const medical = isMedical(user);
  const attempt = (fn) => async (e) => {
    e?.preventDefault?.();
    try {
      await fn(e);
      reload();
    } catch (err) {
      toast(err.message, true);
    }
  };
  const submitSymptom = attempt(async (e) => {
    const r = await post(`/api/crew/${id}/symptoms`, formValues(e.target));
    toast(`Reported. Triage: ${r.triage}.${r.protocol ? ' A protocol is linked from the alert.' : ''}`);
    e.target.reset();
  });
  const submitNote = attempt(async (e) => {
    await post(`/api/crew/${id}/encounters`, formValues(e.target));
    toast('Note added.');
    e.target.reset();
  });
  const submitHold = attempt(async (e) => ack(await post(`/api/crew/${id}/hold`, { reason: e.target.reason.value })));
  const submitLimits = attempt(async (e) => {
    const v = formValues(e.target);
    const override = {};
    const low = parseLimits(v.low);
    const high = parseLimits(v.high);
    if (low) override.low = low;
    if (high) override.high = high;
    ack(await post(`/api/crew/${id}/limits`, { param: v.param, reason: v.reason, override }));
  });
  const resetLimits = attempt(async (e) => {
    const v = formValues(e.target.closest('form'));
    if (!v.reason) throw new Error('A reason is required.');
    ack(await post(`/api/crew/${id}/limits`, { param: v.param, reason: v.reason }));
  });
  const limitRows = Object.entries(rec.limits ?? {});
  return (
    <div className="stack">
      {canReport && (
        <section className="card">
          <h2>Report a symptom</h2>
          <form className="form-grid" onSubmit={submitSymptom}>
            <label className="full">Symptom<select name="code">{Object.entries(reference.symptoms).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}</select></label>
            <label>Severity (0-10)<input type="number" name="severity" min="0" max="10" required defaultValue="3" /></label>
            <label className="full">Notes<input name="notes" maxLength="2000" /></label>
            <button className="primary" type="submit">Report</button>
          </form>
        </section>
      )}
      <section className="card">
        <h2>Symptoms</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Reported (UTC)</th><th>Symptom</th><th className="num">Severity</th><th>Triage</th><th>Status</th></tr></thead>
            <tbody>
              {rec.symptoms.length ? rec.symptoms.slice().reverse().map((s) => (
                <tr key={s.id}>
                  <td>{utcFull(s.ts)}</td>
                  <td>{s.label}{s.notes && <div className="small muted">{s.notes}</div>}</td>
                  <td className="num">{s.severity}/10</td>
                  <td>{s.triage}</td>
                  <td>{s.resolvedAt ? `Resolved by ${s.resolvedBy}` : <button className="small" onClick={attempt(async () => ack(await post(`/api/symptoms/${s.id}/resolve`)))}>Mark resolved</button>}</td>
                </tr>
              )) : <tr><td colSpan="5" className="muted">No symptoms recorded.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <h2>Medication record</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Given (UTC)</th><th>Medication</th><th>By</th><th>Indication / override</th></tr></thead>
            <tbody>
              {rec.medications.length ? rec.medications.slice().reverse().map((m) => (
                <tr key={m.id}>
                  <td>{utcFull(m.ts)}</td><td>{m.name} {m.dose}</td><td>{m.givenBy}</td>
                  <td>{m.indication}{m.overrideReason && <div className="small"><span className="pill caution">▲ OVERRIDE</span> {m.overrideReason}</div>}</td>
                </tr>
              )) : <tr><td colSpan="4" className="muted">No doses recorded.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <h2>Clinical notes</h2>
        {rec.encounters.length ? rec.encounters.slice().reverse().map((n) => (
          <div className="msg" key={n.id}>
            <div className="small muted">{utcFull(n.ts)} UTC · {n.type} · {n.authorName}{n.visGround && n.visOnboard ? '' : ' · in transit'}</div>
            {n.text}
          </div>
        )) : <p className="small muted">No notes.</p>}
        {medical && (
          <form className="form-grid" style={{ marginTop: 8 }} onSubmit={submitNote}>
            <label>Type<select name="type"><option>Note</option><option>Private medical conference</option><option>Exam</option><option>Procedure</option><option>Plan</option></select></label>
            <label className="full">Note<textarea name="text" maxLength="5000" required /></label>
            <button className="primary" type="submit">Add note</button>
          </form>
        )}
      </section>
      {medical && (
        <section className="card">
          <h2>Medical hold</h2>
          <form className="form-grid" onSubmit={submitHold}>
            <label className="full">Reason<input name="reason" maxLength="300" required /></label>
            <button className="danger" type="submit">Set hold</button>
            <button type="button" onClick={attempt(async () => ack(await post(`/api/crew/${id}/hold`, { release: true })))}>Release hold</button>
          </form>
        </section>
      )}
      <section className="card">
        <h2>Crew-specific alarm limits</h2>
        <div className="table-wrap">
          <table>
            <tbody>
              {limitRows.length ? limitRows.map(([p, o]) => <tr key={p}><td>{reference.vitals[p]?.label ?? p}</td><td className="tabular">low {JSON.stringify(o.low ?? 'default')}, high {JSON.stringify(o.high ?? 'default')}</td></tr>)
                : <tr><td className="muted">Using mission defaults.</td></tr>}
            </tbody>
          </table>
        </div>
        {user.role === 'flight_surgeon' && (
          <form className="form-grid" style={{ marginTop: 8 }} onSubmit={submitLimits}>
            <label>Parameter<select name="param">{VITAL_PARAMS.map((p) => <option key={p} value={p}>{reference.vitals[p].label}</option>)}</select></label>
            <label>Low limits: caution, warning, emergency<input name="low" placeholder="50, 40, 30" /></label>
            <label>High limits: caution, warning, emergency<input name="high" placeholder="110, 130, 180" /></label>
            <label className="full">Reason (required)<input name="reason" maxLength="300" required /></label>
            <button className="primary" type="submit">Apply limits</button>
            <button type="button" onClick={resetLimits}>Reset parameter to default</button>
          </form>
        )}
      </section>
    </div>
  );
}

function Report({ id }) {
  const { data: r, error } = useLoad(() => api(`/api/crew/${id}/report`), [id]);
  if (!r) return <Loading error={error} />;
  return (
    <div className="stack">
      <div className="row no-print">
        <button className="primary" onClick={() => window.print()}>Print report</button>
        <a className="btn" href={`/api/crew/${id}/export.csv?hours=24`} download>Export vitals, 24 h (CSV)</a>
        <a className="btn" href={`/api/crew/${id}/export.csv?hours=168`} download>Export vitals, 7 days (CSV)</a>
      </div>
      <section className="card">
        <h2>Medical summary: {r.crew.name}, {r.crew.role}</h2>
        <p className="small secondary">{r.mission.name}, mission day {r.mission.day}. Generated {utcFull(r.generatedAt)} UTC by {r.generatedBy} ({r.node}), with data through {utcFull(r.dataThrough)} UTC. Confidential medical record.</p>
        <p className="small secondary">Age {r.crew.age} · {r.crew.sex} · {r.crew.bloodType} · Allergies: {r.crew.allergies.join(', ') || 'none recorded'} · Conditions: {r.crew.conditions.join(', ') || 'none recorded'}</p>
        <div className="row" style={{ marginTop: 8 }}>
          Duty <ReadyPill status={r.readiness?.duty.status} /> EVA <ReadyPill status={r.readiness?.eva.status} />
          <span className="small secondary">NEWS2: {r.news?.valid ? r.news.score : 'not valid during exertion'} · Dose: {fmt(r.dose?.cumulativeMsv, 1)} of {fmt(r.dose?.limitMsv)} mSv</span>
        </div>
      </section>
      <section className="card">
        <h2>Vital signs, last 24 h</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Parameter</th><th className="num">Min</th><th className="num">Mean</th><th className="num">Max</th><th className="num">Samples</th></tr></thead>
            <tbody>
              {Object.values(r.vitals).map((v) => <tr key={v.label}><td>{v.label} ({v.unit})</td><td className="num">{fmt(v.min, v.decimals)}</td><td className="num">{fmt(v.avg, v.decimals)}</td><td className="num">{fmt(v.max, v.decimals)}</td><td className="num">{v.n}</td></tr>)}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <h2>Long-term findings</h2>
        {r.longTerm.findings.length ? r.longTerm.findings.map((f) => <p key={f.code}><SevPill severity={f.severity} /> <strong>{f.title}.</strong> <span className="small secondary">{f.message}</span></p>) : <p className="small muted">None.</p>}
        <p className="small secondary" style={{ marginTop: 8 }}>Fatigue: {r.longTerm.fatigue.level} · Exercise adherence: {fmt(r.longTerm.bone.adherencePct)}% · Estimated bone loss (model): {fmt(r.longTerm.bone.estLossPct, 1)}%</p>
      </section>
      <section className="card">
        <h2>Alerts, last 7 days ({r.alerts.length})</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Raised (UTC)</th><th>Severity</th><th>Alert</th><th>Status</th></tr></thead>
            <tbody>
              {r.alerts.length ? r.alerts.map((a) => <tr key={a.id}><td>{utcFull(a.raisedAt)}</td><td><SevPill severity={a.severity} /></td><td>{a.title}</td><td>{a.status}</td></tr>) : <tr><td colSpan="4" className="muted">None.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <h2>Medication and symptoms, last 7 days</h2>
        {r.medications.length ? r.medications.map((m) => <p className="small" key={m.id}>{utcFull(m.ts)}: {m.name} {m.dose}, given by {m.givenBy}</p>) : <p className="small muted">No doses.</p>}
        {r.symptoms.length ? r.symptoms.map((s) => <p className="small" key={s.id}>{utcFull(s.ts)}: {s.label} ({s.severity}/10, {s.triage})</p>) : <p className="small muted">No symptoms.</p>}
      </section>
    </div>
  );
}
