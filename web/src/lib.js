import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';

export const fmt = (v, d = 0) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(d));
export const utc = (ts) => (ts ? new Date(ts).toISOString().slice(11, 19) : '—');
export const utcFull = (ts) => (ts ? new Date(ts).toISOString().slice(0, 19).replace('T', ' ') : '—');

export const SEV = { 1: ['advisory', 'ⓘ ADVISORY'], 2: ['caution', '▲ CAUTION'], 3: ['warning', '◆ WARNING'], 4: ['emergency', '✖ EMERGENCY'] };
export const READY = { GO: ['good', '✓ GO'], RESTRICTED: ['caution', '▲ RESTRICTED'], 'NO-GO': ['bad', '✖ NO-GO'], UNKNOWN: ['advisory', '? UNKNOWN'] };
export const VITAL_PARAMS = ['hr', 'spo2', 'rr', 'sys', 'dia', 'temp'];

export class SessionEnded extends Error {}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login' && path !== '/api/me') {
    window.dispatchEvent(new Event('astrohealth:session-ended'));
    throw new SessionEnded('Please sign in.');
  }
  if (!res.ok) {
    const err = new Error(data.error ?? `Request failed (${res.status})`);
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

export const post = (path, body = {}) => api(path, { method: 'POST', body });

/** Shared session data: { user, ref, state, toast, ack }. */
export const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

const subscribeHash = (fn) => {
  window.addEventListener('hashchange', fn);
  return () => window.removeEventListener('hashchange', fn);
};

export function useRoute() {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  return hash.replace(/^#\/?/, '').split('/').filter(Boolean);
}

/** Loads data on mount and on `deps` change, optionally refreshing while the view is open. */
export function useLoad(loader, deps, intervalMs = 0) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const result = await loaderRef.current();
      if (mine === generation.current) {
        setData(result);
        setError(null);
      }
    } catch (err) {
      if (mine === generation.current && !(err instanceof SessionEnded)) setError(err);
    }
  }, []);

  useEffect(() => {
    setData(null);
    setError(null);
    reload();
    if (!intervalMs) return () => { generation.current += 1; };
    const timer = setInterval(reload, intervalMs);
    return () => {
      clearInterval(timer);
      generation.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, reload };
}

/** Reads a form's inputs: numbers become numbers, blank numbers become undefined. */
export function formValues(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'number') out[el.name] = el.value === '' ? undefined : Number(el.value);
    else out[el.name] = el.value;
  }
  return out;
}

export const parseLimits = (text) => {
  if (!text || !text.trim()) return undefined;
  const parts = text.split(',').map((t) => (t.trim() === '' || t.trim() === '-' ? null : Number(t)));
  if (parts.length !== 3 || parts.some((p) => p !== null && !Number.isFinite(p))) throw new Error('Enter limits as three numbers: caution, warning, emergency.');
  return parts;
};
