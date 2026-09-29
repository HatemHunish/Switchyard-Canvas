import { useRef, useState } from 'react';
import { colPath, niceTicks, Tooltip, type TipState } from '../dashboard/charts';

/*
 * Insights charts, same specs as the dashboard ones: thin columns with 4px
 * rounded data-ends, 2px surface gaps between stacked segments, hairline grid,
 * one y-axis, text in text tokens, per-mark tooltips (crosshair on lines).
 * Series colours are the validated categorical slots (--cat-1…8) in a fixed
 * order per dataset, so a source keeps its colour whatever the filter.
 */

export const CATEGORICAL = ['var(--cat-1)', 'var(--cat-2)', 'var(--cat-3)', 'var(--cat-4)', 'var(--cat-5)', 'var(--cat-6)', 'var(--cat-7)', 'var(--cat-8)'];

export interface Bucket {
  key: string;
  label: string;
  values: Record<string, number>;
}

const W = 560;
const H = 190;
const PAD = { l: 34, r: 8, t: 10, b: 22 };

const fmt = (v: number) => (Math.abs(v) >= 10_000 ? `${(v / 1000).toFixed(v >= 100_000 ? 0 : 1)}k` : Number.isInteger(v) ? String(v) : v.toFixed(1));

/** Columns per day/week, stacked by series (e.g. items per source). */
export function StackedColumns({ buckets, series, color, label }: { buckets: Bucket[]; series: string[]; color: (s: string) => string; label: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<TipState | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const totals = buckets.map((b) => series.reduce((a, s) => a + (b.values[s] ?? 0), 0));
  const ticks = niceTicks(Math.max(0, ...totals));
  const top = ticks[ticks.length - 1];
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const band = iw / Math.max(1, buckets.length);
  const bw = Math.min(24, band * 0.62);
  const y = (v: number) => PAD.t + ih - (v / top) * ih;
  const labelEvery = Math.ceil(buckets.length / 8);

  return (
    <div className="viz" ref={wrap} onPointerLeave={() => (setTip(null), setHover(null))}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} className={t === 0 ? 'viz-base' : 'viz-grid'} />
            <text x={PAD.l - 6} y={y(t) + 3.5} className="viz-axis" textAnchor="end">
              {fmt(t)}
            </text>
          </g>
        ))}
        {buckets.map((b, i) => {
          const x = PAD.l + i * band + (band - bw) / 2;
          const present = series.filter((s) => (b.values[s] ?? 0) > 0);
          let acc = 0;
          return (
            <g key={b.key} opacity={hover === null || hover === i ? 1 : 0.55}>
              {present.map((s, j) => {
                const v = b.values[s];
                const h = (v / top) * ih - (j > 0 ? 2 : 0);
                const yTop = y(acc + v);
                acc += v;
                return h > 0 ? <path key={s} d={colPath(x, yTop, bw, h, j === present.length - 1)} fill={color(s)} /> : null;
              })}
              {i % labelEvery === 0 && (
                <text x={x + bw / 2} y={H - 6} className="viz-axis" textAnchor="middle">
                  {b.label}
                </text>
              )}
              <rect
                x={PAD.l + i * band}
                y={PAD.t}
                width={band}
                height={ih}
                fill="transparent"
                tabIndex={0}
                aria-label={`${b.label}: ${totals[i]} items`}
                onFocus={() => setHover(i)}
                onPointerMove={(e) => {
                  const r = wrap.current!.getBoundingClientRect();
                  setHover(i);
                  setTip({
                    flip: e.clientX - r.left > r.width * 0.6,
                    x: e.clientX - r.left,
                    y: e.clientY - r.top,
                    title: `${b.label} · ${totals[i]} items`,
                    rows: series.filter((s) => b.values[s]).map((s) => ({ key: color(s), value: String(b.values[s]), label: s })),
                  });
                }}
              />
            </g>
          );
        })}
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

/** Sentiment per bucket: positive items above the baseline, negative below. */
export function DivergingColumns({ buckets, label }: { buckets: Array<{ key: string; label: string; pos: number; neg: number; neutral: number; avg: number | null }>; label: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<TipState | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const ticks = niceTicks(Math.max(1, ...buckets.map((b) => Math.max(b.pos, b.neg))));
  const top = ticks[ticks.length - 1];
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const mid = PAD.t + ih / 2;
  const band = iw / Math.max(1, buckets.length);
  const bw = Math.min(24, band * 0.62);
  const h = (v: number) => (v / top) * (ih / 2 - 1);
  const labelEvery = Math.ceil(buckets.length / 8);
  const gridVals = ticks.filter((t) => t > 0);

  return (
    <div className="viz" ref={wrap} onPointerLeave={() => (setTip(null), setHover(null))}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
        {gridVals.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={mid - h(t) - 1} y2={mid - h(t) - 1} className="viz-grid" />
            <line x1={PAD.l} x2={W - PAD.r} y1={mid + h(t) + 1} y2={mid + h(t) + 1} className="viz-grid" />
            <text x={PAD.l - 6} y={mid - h(t) + 2.5} className="viz-axis" textAnchor="end">
              {t}
            </text>
            <text x={PAD.l - 6} y={mid + h(t) + 4.5} className="viz-axis" textAnchor="end">
              {t}
            </text>
          </g>
        ))}
        <line x1={PAD.l} x2={W - PAD.r} y1={mid} y2={mid} className="viz-base" />
        {buckets.map((b, i) => {
          const x = PAD.l + i * band + (band - bw) / 2;
          return (
            <g key={b.key} opacity={hover === null || hover === i ? 1 : 0.55}>
              {b.pos > 0 && <path d={colPath(x, mid - 1 - h(b.pos), bw, h(b.pos), true)} fill="var(--sent-pos)" />}
              {b.neg > 0 && <path d={colPath(x, mid + 1, bw, h(b.neg), true)} transform={`rotate(180 ${x + bw / 2} ${mid + 1 + h(b.neg) / 2})`} fill="var(--sent-neg)" />}
              {i % labelEvery === 0 && (
                <text x={x + bw / 2} y={H - 6} className="viz-axis" textAnchor="middle">
                  {b.label}
                </text>
              )}
              <rect
                x={PAD.l + i * band}
                y={PAD.t}
                width={band}
                height={ih}
                fill="transparent"
                tabIndex={0}
                aria-label={`${b.label}: ${b.pos} positive, ${b.neg} negative, ${b.neutral} neutral`}
                onFocus={() => setHover(i)}
                onPointerMove={(e) => {
                  const r = wrap.current!.getBoundingClientRect();
                  setHover(i);
                  setTip({
                    flip: e.clientX - r.left > r.width * 0.6,
                    x: e.clientX - r.left,
                    y: e.clientY - r.top,
                    title: b.label,
                    rows: [
                      { key: 'var(--sent-pos)', value: String(b.pos), label: 'positive' },
                      { key: 'var(--sent-neg)', value: String(b.neg), label: 'negative' },
                      { value: String(b.neutral), label: 'neutral' },
                      ...(b.avg != null ? [{ value: b.avg.toFixed(2), label: 'average (−1…1)' }] : []),
                    ],
                  });
                }}
              />
            </g>
          );
        })}
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

/** Lines over time on one scale (same unit), with a crosshair that lists every line at that time. */
export function LineChart({ lines, color, label, unit }: { lines: Array<{ name: string; points: Array<{ t: number; value: number }> }>; color: (name: string) => string; label: string; unit?: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<TipState | null>(null);
  const [cross, setCross] = useState<number | null>(null);
  const all = lines.flatMap((l) => l.points);
  const t0 = Math.min(...all.map((p) => p.t));
  const t1 = Math.max(...all.map((p) => p.t));
  const minV = Math.min(0, ...all.map((p) => p.value));
  const ticks = niceTicks(Math.max(...all.map((p) => p.value), 1));
  const top = ticks[ticks.length - 1];
  const iw = W - PAD.l - PAD.r - (lines.length <= 4 ? 70 : 0);
  const ih = H - PAD.t - PAD.b;
  const x = (t: number) => PAD.l + (t1 === t0 ? iw / 2 : ((t - t0) / (t1 - t0)) * iw);
  const y = (v: number) => PAD.t + ih - ((v - minV) / (top - minV)) * ih;
  const times = [...new Set(all.map((p) => p.t))].sort((a, b) => a - b);
  const span = t1 - t0;
  const dateLabel = (t: number) => new Date(t).toLocaleDateString(undefined, span > 300 * 86_400_000 ? { month: 'short', year: '2-digit' } : { day: 'numeric', month: 'short' });
  const xTicks = times.length <= 1 ? times : [0, 0.25, 0.5, 0.75, 1].map((f) => t0 + f * span);

  const nearest = (t: number) => times.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a), times[0]);

  return (
    <div className="viz" ref={wrap} onPointerLeave={() => (setTip(null), setCross(null))}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={label}
        onPointerMove={(e) => {
          const r = wrap.current!.getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          const t = nearest(t0 + ((px - PAD.l) / iw) * span);
          setCross(t);
          setTip({
            flip: e.clientX - r.left > r.width * 0.6,
            x: e.clientX - r.left,
            y: e.clientY - r.top,
            title: new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }),
            rows: lines
              .map((l) => ({ l, p: l.points.find((p) => p.t === t) }))
              .filter((r) => r.p)
              .sort((a, b) => b.p!.value - a.p!.value)
              .map(({ l, p }) => ({ key: color(l.name), value: `${fmt(p!.value)}${unit ?? ''}`, label: l.name })),
          });
        }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={PAD.l + iw} y1={y(t)} y2={y(t)} className={t === 0 ? 'viz-base' : 'viz-grid'} />
            <text x={PAD.l - 6} y={y(t) + 3.5} className="viz-axis" textAnchor="end">
              {fmt(t)}
            </text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text key={i} x={x(t)} y={H - 6} className="viz-axis" textAnchor={i === 0 && xTicks.length > 1 ? 'start' : i === xTicks.length - 1 && xTicks.length > 1 ? 'end' : 'middle'}>
            {dateLabel(t)}
          </text>
        ))}
        {cross !== null && <line x1={x(cross)} x2={x(cross)} y1={PAD.t} y2={PAD.t + ih} className="viz-cross" />}
        {lines.map((l) => {
          const pts = [...l.points].sort((a, b) => a.t - b.t);
          const last = pts[pts.length - 1];
          return (
            <g key={l.name}>
              {pts.length > 1 && <polyline points={pts.map((p) => `${x(p.t)},${y(p.value)}`).join(' ')} fill="none" stroke={color(l.name)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
              {(pts.length === 1 || cross !== null) &&
                pts
                  .filter((p) => pts.length === 1 || p.t === cross)
                  .map((p) => <circle key={p.t} cx={x(p.t)} cy={y(p.value)} r={4} fill={color(l.name)} stroke="var(--panel)" strokeWidth={2} />)}
              {lines.length <= 4 && last && (
                <text x={x(last.t) + 8} y={y(last.value) + 3.5} className="viz-label">
                  {fmt(last.value)}
                  {unit ?? ''}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}
