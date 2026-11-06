import { Component, useEffect, useRef, useState } from 'react';
import { READY, SEV, fmt, post, useApp, utcFull } from './lib.js';

export const SevPill = ({ severity }) => <span className={`pill ${SEV[severity][0]}`}>{SEV[severity][1]}</span>;

export function ReadyPill({ status }) {
  const [cls, label] = READY[status] ?? READY.UNKNOWN;
  return <span className={`pill ${cls}`}>{label}</span>;
}

export function Tile({ label, value, unit = '', severity = 0 }) {
  return (
    <div className={`tile ${severity ? `sev-${severity}` : ''}`}>
      <div className="label">
        {label}
        {severity ? <span title={SEV[severity][0]} aria-label={SEV[severity][0]}> {SEV[severity][1].split(' ')[0]}</span> : null}
      </div>
      <div className="value">{value}<span className="unit">{unit}</span></div>
    </div>
  );
}

function worstAlert(alerts, crewId, param) {
  return alerts.filter((a) => a.crewId === crewId && a.param === param && !a.clearedAt).reduce((m, a) => Math.max(m, a.severity), 0);
}

export function VitalTiles({ c, big = false }) {
  const { state } = useApp();
  const { alerts } = state;
  const v = c.vitals ?? {};
  const news = c.news;
  const newsText = !news ? '—' : news.valid ? `${news.score}${news.complete ? '' : '*'}` : 'n/a';
  const newsUnit = !news ? '' : news.valid ? (news.complete ? '' : ' partial') : ' exertion';
  const newsSev = news?.valid && news.score >= 7 ? 3 : news?.valid && news.score >= 5 ? 2 : 0;
  return (
    <div className={`tiles ${big ? 'big' : ''}`}>
      <Tile label="Heart rate" value={fmt(v.hr)} unit=" bpm" severity={worstAlert(alerts, c.id, 'hr')} />
      <Tile label="SpO2" value={fmt(v.spo2)} unit=" %" severity={worstAlert(alerts, c.id, 'spo2')} />
      <Tile label="Resp rate" value={fmt(v.rr)} unit=" /min" severity={worstAlert(alerts, c.id, 'rr')} />
      <Tile label="Blood pressure" value={`${fmt(v.sys)}/${fmt(v.dia)}`} unit=" mmHg" severity={Math.max(worstAlert(alerts, c.id, 'sys'), worstAlert(alerts, c.id, 'dia'))} />
      <Tile label="Core temp" value={fmt(v.temp, 1)} unit=" °C" severity={worstAlert(alerts, c.id, 'temp')} />
      <Tile label="NEWS2" value={newsText} unit={newsUnit} severity={newsSev} />
    </div>
  );
}

export const groundBehind = (state) => state.node === 'ground' && state.snapshotAgeMs > (state.link.delaySec + 10) * 1000;

export function StaleTag({ c }) {
  const { state } = useApp();
  if (c.dataAgeMs === null || c.dataAgeMs === undefined) return <span className="pill bad">✖ NO DATA</span>;
  if (c.dataAgeMs >= 10000) return <span className="pill bad">✖ STALE {fmt(c.dataAgeMs / 1000)} s</span>;
  if (groundBehind(state)) return <span className="pill caution">▲ LAST KNOWN</span>;
  return null;
}

export function AlertRow({ a }) {
  const { ack, toast } = useApp();
  const [silencing, setSilencing] = useState(false);
  const acknowledge = () => post(`/api/alerts/${a.id}/ack`).then(ack).catch((e) => toast(e.message, true));
  return (
    <div className={`alert sev-${a.severity}`}>
      <div><SevPill severity={a.severity} /></div>
      <div className="body">
        <strong>{a.title}</strong>{' '}
        {a.escalated && <span className="pill bad">✖ ESCALATED</span>}{' '}
        {a.status === 'acknowledged' && <span className="pill">✓ Ack by {a.ackedBy}</span>}{' '}
        {a.clearedAt && <span className="pill">Condition cleared; awaiting acknowledgement</span>}{' '}
        {a.occurrences > 1 && <span className="pill">×{a.occurrences} recurring</span>}
        <div className="small secondary">{a.message}</div>
        <div className="small muted">{utcFull(a.raisedAt)} UTC</div>
      </div>
      <div className="row">
        {a.protocol && <a className="btn small" href={`#/protocols/${a.protocol}`}>Protocol</a>}
        {a.ackPending
          ? <span className="small muted">Acknowledgement in transit</span>
          : a.canAck && a.status === 'active' && <button className="small primary" onClick={acknowledge}>Acknowledge</button>}
        {a.canAck && a.severity >= 2 && a.severity < 4 && !a.redacted && !a.clearedAt && <button className="small" onClick={() => setSilencing(true)}>Silence</button>}
      </div>
      {silencing && <SilenceDialog id={a.id} onClose={() => setSilencing(false)} />}
    </div>
  );
}

function SilenceDialog({ id, onClose }) {
  const { ack, toast } = useApp();
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  const submit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      ack(await post(`/api/alerts/${id}/silence`, { minutes: Number(f.minutes.value), reason: f.reason.value }));
      onClose();
    } catch (err) {
      toast(err.message, true);
    }
  };
  return (
    <dialog ref={ref} onCancel={onClose}>
      <form className="stack" onSubmit={submit}>
        <h2>Silence alarm tone</h2>
        <p className="small secondary">The alert stays visible and active. Only the sound stops.</p>
        <label>Minutes<input type="number" name="minutes" min="1" max="60" defaultValue="15" required /></label>
        <label>Reason (recorded)<input name="reason" maxLength="300" required /></label>
        <div className="row"><span className="spacer" /><button type="button" onClick={onClose}>Cancel</button><button className="primary" type="submit">Silence</button></div>
      </form>
    </dialog>
  );
}

export function AlertList({ alerts, empty = 'No active alerts.' }) {
  if (!alerts.length) return <p className="small muted">{empty}</p>;
  return alerts.map((a) => <AlertRow key={a.id} a={a} />);
}

export const Loading = ({ error }) => (error ? <p className="small" role="alert">{error.message}</p> : <p className="muted">Loading…</p>);

/** A rendering fault must be obvious: a blank or frozen screen could pass for a stable patient. */
export class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="banner critical" role="alert">
        ✖ DISPLAY FAULT: this screen failed to draw, so values may be missing. {this.state.error.message}
        <button className="small" onClick={() => window.location.reload()}>Reload</button>
      </div>
    );
  }
}
