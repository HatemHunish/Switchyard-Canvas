import { useRef, useState } from 'react';
import { money, shortDay } from '../../lib/format';

/*
 * Small SVG charts for the dashboard, following the dataviz specs:
 * thin marks (<=24px columns, 4px rounded data-ends, square at the baseline),
 * a 2px surface gap between stacked segments, hairline solid gridlines,
 * text in text tokens (never the series colour), per-mark hover tooltips.
 * Colours are CSS tokens (--viz-*) validated against the dark panel surface.
 */

export interface DayPoint {
  day: string;
  success: number;
  failed: number;
  cancelled: number;
  running: number;
  cost: number;
}

interface TipState {
  /** Near the right edge the tooltip opens to the left of the pointer. */
  flip?: boolean;
  x: number;
  y: number;
  rows: Array<{ key?: string; value: string; label: string }>;
  title: string;
}

function Tooltip({ tip }: { tip: TipState | null }) {
  if (!tip) return null;
  return (
    <div className={`viz-tip ${tip.flip ? 'flip' : ''}`} style={{ left: tip.x, top: tip.y }} role="status">
      <div className="viz-tip-title">{tip.title}</div>
      {tip.rows.map((r, i) => (
        <div key={i} className="viz-tip-row">
          {r.key && <span className="viz-key" style={{ background: r.key }} />}
          <b>{r.value}</b>
          <span>{r.label}</span>
        </div>
      ))}
    </div>
  );
}

/** Clean round axis maximum and 2–4 ticks. */
function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const step = max <= 4 ? 1 : max <= 10 ? 2 : max <= 25 ? 5 : max <= 50 ? 10 : Math.pow(10, Math.floor(Math.log10(max))) * (max / Math.pow(10, Math.floor(Math.log10(max))) > 5 ? 2 : 1);
  const top = Math.ceil(max / step) * step;
  const t: number[] = [];
  for (let v = 0; v <= top; v += step) t.push(v);
  return t;
}

/** Top-rounded column/segment path: 4px radius at the data end, square at the baseline. */
function colPath(x: number, y: number, w: number, h: number, round: boolean) {
  const r = round ? Math.min(4, w / 2, h) : 0;
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

/** Runs per day, stacked: completed (series blue) under failed (critical red). */
export function RunsPerDay({ data }: { data: DayPoint[] }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<TipState | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 560;
  const H = 180;
  const pad = { l: 30, r: 8, t: 8, b: 22 };
  const max = Math.max(...data.map((d) => d.success + d.failed), 0);
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1];
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const band = iw / Math.max(1, data.length);
  const bw = Math.min(24, band * 0.62);
  const y = (v: number) => pad.t + ih - (v / top) * ih;
  const labelEvery = data.length > 16 ? 5 : data.length > 8 ? 2 : 1;

  return (
    <div className="viz" ref={wrap} onPointerLeave={() => (setTip(null), setHover(null))}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Runs per day, completed and failed">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className={t === 0 ? 'viz-base' : 'viz-grid'} />
            <text x={pad.l - 6} y={y(t) + 3.5} className="viz-axis" textAnchor="end">
              {t}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = pad.l + i * band + (band - bw) / 2;
          const sH = (d.success / top) * ih;
          const fH = (d.failed / top) * ih;
          const gap = d.success && d.failed ? 2 : 0;
          return (
            <g key={d.day} opacity={hover === null || hover === i ? 1 : 0.55}>
              {d.success > 0 && <path d={colPath(x, y(d.success), bw, sH, !d.failed)} fill="var(--viz-done)" />}
              {d.failed > 0 && <path d={colPath(x, y(d.success) - fH - gap, bw, fH, true)} fill="var(--viz-failed)" />}
              {i % labelEvery === 0 && (
                <text x={x + bw / 2} y={H - 6} className="viz-axis" textAnchor="middle">
                  {shortDay(d.day)}
                </text>
              )}
              {/* Hit area: the whole day band, bigger than the mark. */}
              <rect
                x={pad.l + i * band}
                y={pad.t}
                width={band}
                height={ih}
                fill="transparent"
                tabIndex={0}
                aria-label={`${shortDay(d.day)}: ${d.success} completed, ${d.failed} failed`}
                onPointerMove={(e) => {
                  const r = wrap.current!.getBoundingClientRect();
                  setHover(i);
                  setTip({
                    flip: e.clientX - r.left > r.width * 0.6,
                    x: e.clientX - r.left,
                    y: e.clientY - r.top,
                    title: shortDay(d.day),
                    rows: [
                      { key: 'var(--viz-done)', value: String(d.success), label: 'completed' },
                      { key: 'var(--viz-failed)', value: String(d.failed), label: 'failed' },
                      ...(d.cancelled ? [{ value: String(d.cancelled), label: 'cancelled' }] : []),
                      { value: `≈${money(d.cost)}`, label: 'usage (API-equivalent)' },
                    ],
                  });
                }}
                onFocus={() => setHover(i)}
              />
            </g>
          );
        })}
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

/** One series, horizontal bars with the value at the tip. */
export function HBars({ rows, format, label }: { rows: Array<{ id: string; name: string; value: number }>; format: (v: number) => string; label: string }) {
  const max = Math.max(...rows.map((r) => r.value), 0) || 1;
  if (!rows.length) return <p className="muted small">Nothing in this period.</p>;
  return (
    <ul className="hbars" aria-label={label}>
      {rows.map((r) => (
        <li key={r.id} title={`${r.name}: ${format(r.value)}`}>
          <span className="hbar-name">{r.name}</span>
          <span className="hbar-track">
            <span className="hbar-fill" style={{ width: `${Math.max(1.5, (r.value / max) * 100)}%` }} />
            <span className="hbar-val">{format(r.value)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** 7-point trend in the de-emphasis hue, today's point in the accent. */
export function Sparkline({ values }: { values: number[] }) {
  const W = 84;
  const H = 26;
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => [3 + (i * (W - 6)) / Math.max(1, values.length - 1), H - 4 - (v / max) * (H - 8)]);
  const last = pts[pts.length - 1];
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} aria-hidden>
      <polyline points={pts.map((p) => p.join(',')).join(' ')} fill="none" stroke="var(--viz-muted)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {last && <circle cx={last[0]} cy={last[1]} r={4} fill="var(--viz-done)" stroke="var(--panel)" strokeWidth={2} />}
    </svg>
  );
}

/** Meter whose fill carries severity; the track is a lighter step of the same hue. */
export function Meter({ value, label }: { value: number; label: string }) {
  const sev = value >= 0.95 ? 'crit' : value >= 0.8 ? 'warn' : 'ok';
  return (
    <span className={`meter2 ${sev}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)} aria-label={label}>
      <span style={{ width: `${Math.min(100, value * 100)}%` }} />
    </span>
  );
}
