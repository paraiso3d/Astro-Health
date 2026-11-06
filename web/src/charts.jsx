import { useEffect, useRef, useState } from 'react';

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

function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** Single-series line with crosshair, tooltip and table view. A gap in time breaks the line. */
export function Chart({ points, unit = '', decimals = 0, xType = 'time', refValue = null, refLabel = '', name = '', height = 220 }) {
  const [box, measured] = useWidth();
  const [hover, setHover] = useState(null);
  const svgRef = useRef(null);
  const usable = points.filter((p) => Number.isFinite(p.y));
  if (usable.length < 2) return <div ref={box}><p className="small muted">Not enough data yet.</p></div>;

  const width = Math.max(280, measured || 600);
  const m = { top: 12, right: 14, bottom: 22, left: 46 };
  const hasRef = Number.isFinite(refValue);
  const ys = usable.map((p) => p.y);
  if (hasRef) ys.push(refValue);
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
  const n = Math.max(2, Math.floor((width - m.left - m.right) / 110));
  const xTicks = Array.from({ length: n + 1 }, (_, i) => x0 + ((x1 - x0) * i) / n);
  const xText = (x) => (xType === 'time' ? timeLabel(x) : `Day ${Math.round(x)}`);
  const anchor = (i) => (i === 0 ? 'start' : i === n ? 'end' : 'middle');

  const onMove = (e) => {
    const rect = svgRef.current.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    let best = usable[0];
    for (const p of usable) if (Math.abs(sx(p.x) - px) < Math.abs(sx(best.x) - px)) best = p;
    setHover(best);
  };
  const tipLeft = hover ? Math.min(width - 190, Math.max(0, sx(hover.x) - 90)) : 0;

  return (
    <div ref={box}>
      <div className="chart" role="img" aria-label={`${name} line chart`}>
        <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} height={height}>
          {yTicks.map((t) => (
            <g key={t}>
              <line className="grid-line" x1={m.left} x2={width - m.right} y1={sy(t)} y2={sy(t)} />
              <text x={m.left - 6} y={sy(t) + 4} textAnchor="end">{t.toFixed(labelDecimals)}</text>
            </g>
          ))}
          <line className="axis-line" x1={m.left} x2={width - m.right} y1={height - m.bottom} y2={height - m.bottom} />
          {xTicks.map((x, i) => <text key={i} x={sx(x)} y={height - 6} textAnchor={anchor(i)}>{xText(x)}</text>)}
          {hasRef && (
            <>
              <line className="ref-line" x1={m.left} x2={width - m.right} y1={sy(refValue)} y2={sy(refValue)} />
              <text className="ref-label" x={width - m.right} y={sy(refValue) - 4} textAnchor="end">{refLabel} {Number(refValue).toFixed(decimals)}</text>
            </>
          )}
          <path className="line" d={d} />
          {hover && (
            <>
              <line className="cross" x1={sx(hover.x)} x2={sx(hover.x)} y1={m.top} y2={height - m.bottom} />
              <circle className="dot" r="5" cx={sx(hover.x)} cy={sy(hover.y)} />
            </>
          )}
          <rect x={m.left} y="0" width={width - m.left - m.right} height={height} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
        </svg>
        {hover && (
          <div className="tooltip" style={{ left: `${(tipLeft / width) * 100}%` }}>
            {xType === 'time' ? `${timeLabel(hover.x)} UTC` : `Day ${hover.x}`}: {hover.y.toFixed(decimals)}{unit ? ` ${unit}` : ''}
          </div>
        )}
      </div>
      <details className="no-print">
        <summary>View as table</summary>
        <div className="table-wrap" style={{ maxHeight: 220, overflowY: 'auto' }}>
          <table>
            <thead><tr><th>{xType === 'time' ? 'Time (UTC)' : 'Mission day'}</th><th className="num">{name}{unit ? ` (${unit})` : ''}</th></tr></thead>
            <tbody>
              {usable.slice(-120).reverse().map((p) => (
                <tr key={p.x}><td>{xType === 'time' ? new Date(p.x).toISOString().slice(0, 19).replace('T', ' ') : p.x}</td><td className="num">{p.y.toFixed(decimals)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function ecgShape(phase) {
  const gauss = (c, w, a) => a * Math.exp(-((phase - c) ** 2) / (2 * w * w));
  return gauss(0.18, 0.025, 0.12) + gauss(0.28, 0.008, -0.12) + gauss(0.3, 0.01, 1) + gauss(0.325, 0.009, -0.25) + gauss(0.52, 0.04, 0.28);
}

/** Sweep display drawn from rate and rhythm only. The crew prop supplies live values. */
export function EcgMonitor({ crew }) {
  const canvasRef = useRef(null);
  const crewRef = useRef(crew);
  crewRef.current = crew;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    let raf = 0;
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
      const elapsed = Math.min(1, (t - last) / 1000);
      last = t;
      const live = crewRef.current;
      const hr = live?.vitals?.hr ?? null;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      // Fixed sub-steps keep the sweep speed true and the QRS spike visible at any frame rate
      const steps = Math.max(1, Math.round(elapsed * 250));
      const dt = elapsed / steps;
      const dx = dt * 90;

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
            nextInterval = (60 / hr) * (live.rhythm === 'irregular' ? 0.6 + Math.random() * 0.8 : 1);
            if (live.rhythm === 'pause' && Math.random() < 0.3) nextInterval = 3.2;
          }
          const y = h * 0.68 - ecgShape(Math.min(1, (beat * nextInterval) / 0.85)) * h * 0.55;
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
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return <canvas className="ecg" ref={canvasRef} />;
}
