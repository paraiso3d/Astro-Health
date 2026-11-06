// Single-series line chart with crosshair and tooltip, plus a table view for accessibility.

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function niceTicks(min, max, count = 4) {
  const span = max - min || 1;
  const rough = span / count;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const ticks = [];
  for (let t = Math.ceil(min / step) * step; t <= max + step * 1e-6; t += step) ticks.push(Number(t.toFixed(6)));
  return ticks;
}

const timeLabel = (ts) => new Date(ts).toISOString().slice(11, 16);

/** Renders points [{x, y}] into el. A gap in time breaks the line rather than joining across it. */
export function chart(el, points, { unit = '', decimals = 0, xType = 'time', ref = null, refLabel = '', name = '', height = 220 } = {}) {
  const usable = points.filter((p) => Number.isFinite(p.y));
  if (usable.length < 2) {
    el.innerHTML = '<p class="small muted">Not enough data yet.</p>';
    return;
  }
  const width = Math.max(280, el.clientWidth || 600);
  const m = { top: 12, right: 14, bottom: 22, left: 46 };
  const ys = usable.map((p) => p.y);
  if (Number.isFinite(ref)) ys.push(ref);
  let lo = Math.min(...ys);
  let hi = Math.max(...ys);
  const pad = (hi - lo || Math.abs(hi) * 0.1 || 1) * 0.12;
  lo -= pad;
  hi += pad;
  const x0 = usable[0].x;
  const x1 = usable.at(-1).x;
  const sx = (x) => m.left + ((x - x0) / (x1 - x0 || 1)) * (width - m.left - m.right);
  const sy = (y) => height - m.bottom - ((y - lo) / (hi - lo)) * (height - m.top - m.bottom);

  const gaps = usable.slice(1).map((p, i) => p.x - usable[i].x).sort((a, b) => a - b);
  const gapLimit = (gaps[Math.floor(gaps.length / 2)] || 1) * 5;
  let d = '';
  usable.forEach((p, i) => {
    const jump = i === 0 || p.x - usable[i - 1].x > gapLimit;
    d += `${jump ? 'M' : 'L'}${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`;
  });

  const yTicks = niceTicks(lo, hi);
  const labelDecimals = yTicks.some((t) => !Number.isInteger(t)) ? Math.max(decimals, 1) : 0;
  const xTicks = [];
  const n = Math.max(2, Math.floor((width - m.left - m.right) / 110));
  for (let i = 0; i <= n; i++) xTicks.push(x0 + ((x1 - x0) * i) / n);
  const xText = (x) => (xType === 'time' ? timeLabel(x) : `Day ${Math.round(x)}`);
  const anchor = (i) => (i === 0 ? 'start' : i === n ? 'end' : 'middle');

  el.innerHTML = `<div class="chart" role="img" aria-label="${esc(name)} line chart">
    <svg viewBox="0 0 ${width} ${height}" height="${height}">
      ${yTicks.map((t) => `<line class="grid-line" x1="${m.left}" x2="${width - m.right}" y1="${sy(t)}" y2="${sy(t)}"/><text x="${m.left - 6}" y="${sy(t) + 4}" text-anchor="end">${t.toFixed(labelDecimals)}</text>`).join('')}
      <line class="axis-line" x1="${m.left}" x2="${width - m.right}" y1="${height - m.bottom}" y2="${height - m.bottom}"/>
      ${xTicks.map((x, i) => `<text x="${sx(x)}" y="${height - 6}" text-anchor="${anchor(i)}">${xText(x)}</text>`).join('')}
      ${Number.isFinite(ref) ? `<line class="ref-line" x1="${m.left}" x2="${width - m.right}" y1="${sy(ref)}" y2="${sy(ref)}"/><text class="ref-label" x="${width - m.right}" y="${sy(ref) - 4}" text-anchor="end">${esc(refLabel)} ${Number(ref).toFixed(decimals)}</text>` : ''}
      <path class="line" d="${d}"/>
      <line class="cross" y1="${m.top}" y2="${height - m.bottom}" visibility="hidden"/>
      <circle class="dot" r="5" visibility="hidden"/>
      <rect class="hit" x="${m.left}" y="0" width="${width - m.left - m.right}" height="${height}" fill="transparent"/>
    </svg>
    <div class="tooltip" hidden></div>
  </div>
  <details class="no-print"><summary>View as table</summary><div class="table-wrap" style="max-height:220px;overflow-y:auto"><table>
    <thead><tr><th>${xType === 'time' ? 'Time (UTC)' : 'Mission day'}</th><th class="num">${esc(name)}${unit ? ` (${esc(unit)})` : ''}</th></tr></thead>
    <tbody>${usable.slice(-120).reverse().map((p) => `<tr><td>${xType === 'time' ? new Date(p.x).toISOString().slice(0, 19).replace('T', ' ') : p.x}</td><td class="num">${p.y.toFixed(decimals)}</td></tr>`).join('')}</tbody>
  </table></div></details>`;

  const svg = el.querySelector('svg');
  const cross = svg.querySelector('.cross');
  const dot = svg.querySelector('.dot');
  const tip = el.querySelector('.tooltip');
  const hit = svg.querySelector('.hit');
  hit.addEventListener('pointermove', (e) => {
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    let best = usable[0];
    for (const p of usable) if (Math.abs(sx(p.x) - px) < Math.abs(sx(best.x) - px)) best = p;
    const cx = sx(best.x);
    cross.setAttribute('x1', cx);
    cross.setAttribute('x2', cx);
    cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', cx);
    dot.setAttribute('cy', sy(best.y));
    dot.setAttribute('visibility', 'visible');
    tip.hidden = false;
    tip.textContent = `${xType === 'time' ? `${timeLabel(best.x)} UTC` : `Day ${best.x}`}: ${best.y.toFixed(decimals)}${unit ? ` ${unit}` : ''}`;
    const screenX = (cx / width) * rect.width;
    const tipW = tip.offsetWidth;
    tip.style.left = `${Math.min(rect.width - tipW - 2, Math.max(0, screenX - tipW / 2))}px`;
  });
  hit.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  });
}

function ecgShape(phase) {
  const gauss = (c, w, a) => a * Math.exp(-((phase - c) ** 2) / (2 * w * w));
  return gauss(0.18, 0.025, 0.12) + gauss(0.28, 0.008, -0.12) + gauss(0.3, 0.01, 1) + gauss(0.325, 0.009, -0.25) + gauss(0.52, 0.04, 0.28);
}

/** Sweep display drawn from rate and rhythm only. getCrew() supplies live values. */
export function drawEcg(canvas, getCrew) {
  const ctx = canvas.getContext('2d');
  let raf = 0;
  let stopped = false;
  let last = performance.now();
  let beat = 0;
  let cursor = 0;
  let prevY = null;
  let nextInterval = 1;

  const resize = () => {
    const ratio = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * ratio;
    canvas.height = canvas.clientHeight * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    cursor = 0;
    prevY = null;
  };
  resize();
  window.addEventListener('resize', resize);

  const frame = (t) => {
    if (stopped) return;
    const elapsed = Math.min(1, (t - last) / 1000);
    last = t;
    const crew = getCrew();
    const hr = crew?.vitals?.hr ?? null;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const pxPerSec = 90;
    // Fixed sub-steps keep the sweep speed true and the QRS spike visible at any frame rate
    const steps = Math.max(1, Math.round(elapsed * 250));
    const dt = elapsed / steps;
    const dx = dt * pxPerSec;

    if (hr === null) {
      ctx.fillStyle = '#0d0d0d';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#ec835a';
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillText('◆ ECG signal unavailable', 12, 24);
      ctx.strokeStyle = '#383835';
      ctx.beginPath();
      ctx.moveTo(0, h * 0.65);
      ctx.lineTo(w, h * 0.65);
      ctx.stroke();
      cursor = 0;
      prevY = null;
    } else {
      for (let i = 0; i < steps; i++) {
        beat += dt / nextInterval;
        if (beat >= 1) {
          beat -= 1;
          const irregular = crew.rhythm === 'irregular';
          nextInterval = (60 / hr) * (irregular ? 0.6 + Math.random() * 0.8 : 1);
          if (crew.rhythm === 'pause' && Math.random() < 0.3) nextInterval = 3.2;
        }
        const shapePhase = Math.min(1, beat * nextInterval / 0.85);
        const y = h * 0.68 - ecgShape(shapePhase) * h * 0.55;
        ctx.fillStyle = '#0d0d0d';
        ctx.fillRect(cursor, 0, dx + 8, h);
        if (prevY !== null) {
          ctx.strokeStyle = '#3987e5';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(cursor - dx, prevY);
          ctx.lineTo(cursor, y);
          ctx.stroke();
        }
        prevY = y;
        cursor += dx;
        if (cursor > w) {
          cursor = 0;
          prevY = null;
        }
      }
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', resize);
  };
}
