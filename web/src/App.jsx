import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorBoundary, groundBehind } from './components.jsx';
import { AppContext, api, fmt, post, useRoute, utc } from './lib.js';
import { Alerts, Audit, Comms, Environment, Overview, Pharmacy, Protocols, Readiness, Training } from './views.jsx';
import { CrewView } from './crew.jsx';

const isMedicalRole = (user) => user.role === 'flight_surgeon' || user.role === 'cmo';

const NAV = [
  ['overview', 'Crew overview', () => true],
  ['me', 'My health', (u) => !!u.crewId],
  ['alerts', 'Alerts', () => true],
  ['readiness', 'Readiness', () => true],
  ['environment', 'Environment', () => true],
  ['pharmacy', 'Pharmacy', (u) => u.role !== 'mission_ops'],
  ['protocols', 'Protocols', (u) => u.role !== 'mission_ops'],
  ['comms', 'Comms', () => true],
  ['training', 'Training', isMedicalRole],
  ['audit', 'Audit log', isMedicalRole],
];

function Login({ message, onSignedIn }) {
  const [error, setError] = useState(message);
  const submit = async (e) => {
    e.preventDefault();
    try {
      const { user } = await post('/api/login', { username: e.target.username.value, password: e.target.password.value });
      onSignedIn(user);
    } catch (err) {
      setError(err.message);
    }
  };
  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <h1>AstroHealth</h1>
        <p className="secondary">Crew health monitoring system</p>
        <p className="small secondary note">Not a certified medical device. Thresholds and clinical content need flight-surgeon validation before operational use.</p>
        {error && <p className="small" role="alert">{error}</p>}
        <label>Username<input name="username" autoComplete="username" required autoFocus /></label>
        <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
        <button className="primary" type="submit">Sign in</button>
      </form>
    </div>
  );
}

/** Audible alarm repeats while an unacknowledged, unsilenced warning or emergency is active. */
function useAlarm(state, muted) {
  const audio = useRef(null);
  const lastBeep = useRef(0);
  useEffect(() => {
    const unlock = () => {
      try {
        audio.current ??= new AudioContext();
        audio.current.resume();
      } catch { /* the visual alarm still shows if audio is unavailable */ }
    };
    document.addEventListener('pointerdown', unlock);
    return () => document.removeEventListener('pointerdown', unlock);
  }, []);
  useEffect(() => {
    if (!state || muted) return;
    const pending = state.alerts.filter((a) => a.status === 'active' && a.severity >= 3 && !(a.shelvedUntil > state.now));
    if (!pending.length || audio.current?.state !== 'running') return;
    const emergency = pending.some((a) => a.severity === 4);
    const now = Date.now();
    if (now - lastBeep.current < (emergency ? 1000 : 4000)) return;
    lastBeep.current = now;
    const osc = audio.current.createOscillator();
    const gain = audio.current.createGain();
    osc.frequency.value = emergency ? 960 : 660;
    gain.gain.value = 0.06;
    osc.connect(gain).connect(audio.current.destination);
    osc.start();
    osc.stop(audio.current.currentTime + 0.25);
  }, [state, muted]);
}

function Shell({ user, reference, initialState, onSignOut, onExpired }) {
  const [state, setState] = useState(initialState);
  const [muted, setMuted] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [silent, setSilent] = useState(false);
  const lastTick = useRef(Date.now());
  const route = useRoute();
  useAlarm(state, muted);

  useEffect(() => {
    const stream = new EventSource('/api/stream');
    stream.onmessage = (e) => {
      setState(JSON.parse(e.data));
      lastTick.current = Date.now();
    };
    stream.addEventListener('expired', onExpired);
    window.addEventListener('astrohealth:session-ended', onExpired);
    // Watchdog: a frozen display must never pass for a stable patient
    const watchdog = setInterval(() => setSilent(Date.now() - lastTick.current > 5000), 1000);
    return () => {
      stream.close();
      clearInterval(watchdog);
      window.removeEventListener('astrohealth:session-ended', onExpired);
    };
  }, [onExpired]);

  const toast = useCallback((message, isError = false) => {
    const id = crypto.randomUUID();
    setToasts((list) => [...list, { id, message, isError }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), isError ? 7000 : 4000);
  }, []);

  const ack = useCallback((result) => {
    if (result.applied === false) toast(result.los ? 'Queued. The link is down, so this will send when signal returns.' : `Sent to the spacecraft. It takes effect in about ${fmt(result.etaSec)} s.`);
    else toast('Done.');
  }, [toast]);

  const context = useMemo(() => ({ user, ref: reference, state, toast, ack }), [user, reference, state, toast, ack]);

  const [section = 'overview', a, b] = route;
  const open = state.alerts.filter((x) => x.status === 'active').length;
  const emergencies = state.alerts.filter((x) => x.severity === 4 && !x.clearedAt);
  const crewName = (id) => state.crew.find((c) => c.id === id)?.name ?? id;
  const delay = state.link.delaySec >= 60 ? `${fmt(state.link.delaySec / 60, 1)} min` : `${fmt(state.link.delaySec, 2).replace(/\.?0+$/, '')} s`;

  const signOut = async () => {
    await post('/api/logout').catch(() => {});
    onSignOut();
  };

  let view;
  switch (section) {
    case 'me': view = <CrewView id={user.crewId} tab={a ?? 'live'} />; break;
    case 'crew': view = <CrewView id={a} tab={b ?? 'live'} />; break;
    case 'alerts': view = <Alerts />; break;
    case 'readiness': view = <Readiness />; break;
    case 'environment': view = <Environment />; break;
    case 'pharmacy': view = <Pharmacy />; break;
    case 'protocols': view = <Protocols open={a} />; break;
    case 'comms': view = <Comms />; break;
    case 'training': view = <Training />; break;
    case 'audit': view = <Audit />; break;
    default: view = <Overview />;
  }

  return (
    <AppContext.Provider value={context}>
      <div className="topbar">
        <span className="brand">AstroHealth</span>
        <span className="small secondary">{state.mission.name} · {state.mission.profile} · Mission day {state.mission.day} of {state.mission.plannedDays} · {utc(state.now)} UTC</span>
        <span className="spacer" />
        <span className="small row">
          {state.node === 'onboard'
            ? <span className="pill good">● ON BOARD: live data</span>
            : <span className="pill advisory">◌ GROUND: data {fmt((state.snapshotAgeMs ?? 0) / 1000)} s old</span>}
          {state.link.los ? <span className="pill bad">✖ LOSS OF SIGNAL</span> : <span className="pill">Link {delay} one-way</span>}
          {state.cloud && (state.cloud.error || state.cloud.lastSyncAt === null
            ? <span className="pill caution" title={state.cloud.error ?? 'Waiting for the first sync'}>▲ Supabase sync waiting: {state.cloud.pending} queued</span>
            : <span className="pill">✓ Supabase synced</span>)}
        </span>
        <button className="small" onClick={() => setMuted((m) => !m)}>{muted ? 'Sound off' : 'Sound on'}</button>
        <span className="small secondary">{user.displayName}</span>
        <button className="small" onClick={signOut}>Sign out</button>
      </div>
      {state.dataSource === 'simulator' && (
        <div className="training">▲ TRAINING SIMULATION: all crew and telemetry shown are simulated.{state.scenarios.length ? ` ${state.scenarios.length} training scenario(s) running.` : ''}</div>
      )}
      {silent && <div className="banner critical" role="alert">✖ DISPLAY NOT UPDATING: connection to the monitoring system is lost. Values on screen are out of date.</div>}
      {emergencies.length > 0 && (
        <div className="banner critical" role="alert">
          ✖ EMERGENCY: {emergencies.map((x) => (x.crewId ? `${x.title}, ${crewName(x.crewId)}` : x.title)).join(' · ')}
          <a className="btn small" href="#/alerts">View alerts</a>
        </div>
      )}
      {state.link.los && state.node === 'ground' && <div className="banner warn">▲ Loss of signal. The ground view is out of date, and the crew is relying on on-board systems.</div>}
      {!state.link.los && groundBehind(state) && <div className="banner warn">▲ Ground data is {fmt(state.snapshotAgeMs / 1000)} s old, more than the link delay. The backlog is catching up.</div>}
      <div className="layout">
        <nav className="side" aria-label="Sections">
          {NAV.filter(([, , allowed]) => allowed(user)).map(([id, label]) => {
            const on = section === id || (id === 'me' && section === 'crew' && a === user.crewId) || (id === 'overview' && section === 'crew' && a !== user.crewId);
            return <a key={id} href={`#/${id}`} className={on ? 'on' : ''}>{label}{id === 'alerts' && open > 0 && <span className="count">{open}</span>}</a>;
          })}
        </nav>
        <main><ErrorBoundary key={route.join('/')}>{view}</ErrorBoundary></main>
      </div>
      <div id="toast" role="status" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={t.isError ? 'err' : ''}>{t.message}</div>)}
      </div>
    </AppContext.Provider>
  );
}

export default function App() {
  const [session, setSession] = useState(null);
  const [booting, setBooting] = useState(true);
  const [message, setMessage] = useState('');

  const start = useCallback(async (user) => {
    const [reference, state] = await Promise.all([api('/api/reference'), api('/api/state')]);
    setSession({ user, reference, state });
  }, []);

  useEffect(() => {
    api('/api/me')
      .then(({ user }) => start(user))
      .catch(() => {})
      .finally(() => setBooting(false));
  }, [start]);

  const expired = useCallback(() => {
    setSession(null);
    setMessage('Your session has ended. Please sign in again.');
  }, []);

  if (booting) return null;
  if (!session) return <Login key={message} message={message} onSignedIn={(user) => start(user).catch((e) => setMessage(e.message))} />;
  return (
    <ErrorBoundary>
      <Shell user={session.user} reference={session.reference} initialState={session.state} onExpired={expired} onSignOut={() => { setMessage(''); setSession(null); }} />
    </ErrorBoundary>
  );
}
