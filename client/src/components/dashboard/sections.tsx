import { useMemo, useRef, useState } from 'react';
import type { AttentionItem, DashKpis, DashSummary, FileRow, HealthRow, LiveRun, RunFilters, RunRow, UpcomingItem } from '../../api';
import { ago, clock, dur, money, pct, STATUS_ICON, until } from '../../lib/format';
import { HBars, Meter, RunsPerDay, Sparkline } from './charts';

export interface Nav {
  openWorkflow: (workflowId: string) => void;
  openRun: (workflowId: string, runId: string, nodeId?: string) => void;
}

const TRIGGER_LABEL: Record<string, string> = { 'trigger.manual': 'manual', 'trigger.schedule': 'schedule', 'trigger.file': 'file', 'trigger.webhook': 'webhook' };
const TRIGGER_ICON: Record<string, string> = { 'trigger.schedule': '⏱', 'trigger.file': '📁', 'trigger.webhook': '⚡', 'trigger.manual': '▶' };

function StatusBadge({ status, waiting }: { status: string; waiting?: boolean }) {
  const s = waiting ? 'waiting' : status;
  return (
    <span className={`sbadge st-${s}`}>
      <span aria-hidden>{STATUS_ICON[s] ?? '•'}</span> {s === 'waiting' ? 'Waiting for you' : s === 'success' ? 'Completed' : s[0].toUpperCase() + s.slice(1)}
    </span>
  );
}

// ---------------- attention ----------------

export function AttentionStrip({ items, cliProblem, nav, onOpenInbox }: { items: AttentionItem[]; cliProblem?: string; nav: Nav; onOpenInbox: () => void }) {
  const all = [...(cliProblem ? [{ level: 'critical' as const, kind: 'cli', text: cliProblem }] : []), ...items];
  if (!all.length) return null;
  return (
    <section className="attention" aria-label="Needs attention">
      <span className="attention-title">Needs attention</span>
      <ul>
        {all.map((a, i) => (
          <li key={i}>
            <button
              className={`att att-${a.level}`}
              onClick={() => {
                if (a.kind === 'waiting') onOpenInbox();
                else if ('runId' in a && a.runId && a.workflowId) nav.openRun(a.workflowId, a.runId, a.nodeId);
                else if ('workflowId' in a && a.workflowId) nav.openWorkflow(a.workflowId);
              }}
            >
              <span aria-hidden>{a.level === 'critical' ? '✕' : '!'}</span>
              {a.text}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------- stat tiles ----------------

export function StatTiles({ k, onFilter }: { k: DashKpis; onFilter: (f: Partial<RunFilters>) => void }) {
  const delta = k.successRate7d != null && k.successRatePrev7d != null ? k.successRate7d - k.successRatePrev7d : null;
  const five = k.usage?.fiveHour;
  const seven = k.usage?.sevenDay;
  return (
    <section className="tiles" aria-label="Key numbers">
      <button className="tile" onClick={() => onFilter({ status: 'running', range: '24h' })}>
        <span className="tile-label">Running now</span>
        <span className="tile-value">{k.running}</span>
        <span className="tile-sub">
          {k.queue.active}/{k.queue.limit} agent slots{k.queue.waiting ? ` · ${k.queue.waiting} queued` : ''}
        </span>
      </button>
      <button className={`tile ${k.waiting ? 'tile-warn' : ''}`} onClick={() => onFilter({ status: 'waiting' })}>
        <span className="tile-label">Waiting for you</span>
        <span className="tile-value">{k.waiting}</span>
        <span className="tile-sub">{k.waiting ? 'reviews and questions' : 'all clear'}</span>
      </button>
      <button className="tile" onClick={() => onFilter({ range: '24h', status: '' })}>
        <span className="tile-label">Runs today</span>
        <span className="tile-row">
          <span className="tile-value">{k.runsToday}</span>
          <Sparkline values={k.runsTrend} />
        </span>
        <span className="tile-sub">last 7 days</span>
      </button>
      <button className={`tile ${k.failed24h ? 'tile-crit' : ''}`} onClick={() => onFilter({ range: '7d', status: 'failed' })}>
        <span className="tile-label">Success rate · 7 days</span>
        <span className="tile-value">{pct(k.successRate7d)}</span>
        <span className="tile-sub">
          {delta != null && Math.abs(delta) >= 0.005 && <span className={delta > 0 ? 'delta-up' : 'delta-down'}>{`${delta > 0 ? '▲' : '▼'} ${Math.abs(Math.round(delta * 100))} pts vs prior week · `}</span>}
          {k.failed24h ? `${k.failed24h} failed in 24h` : 'no failures in 24h'}
        </span>
      </button>
      <div className="tile">
        <span className="tile-label">Next scheduled run</span>
        <span className="tile-value tile-value-sm" title={clock(k.next?.at)}>
          {k.next ? until(k.next.at) : '—'}
        </span>
        <span className="tile-sub">{k.next ? k.next.workflowName : `${k.enabledWorkflows} of ${k.workflows} workflows enabled`}</span>
      </div>
      <div className="tile">
        <span className="tile-label">Subscription usage</span>
        {five || seven ? (
          <div className="usage-rows">
            {five && (
              <div title={`Resets ${clock(five.resetsAt * 1000)}`}>
                <span>5h</span>
                <Meter value={five.utilization} label="5-hour usage" />
                <b>{pct(five.utilization)}</b>
              </div>
            )}
            {seven && (
              <div title={`Resets ${clock(seven.resetsAt * 1000)}`}>
                <span>7d</span>
                <Meter value={seven.utilization} label="7-day usage" />
                <b>{pct(seven.utilization)}</b>
              </div>
            )}
          </div>
        ) : (
          <span className="tile-value tile-value-sm">—</span>
        )}
        <span className="tile-sub" title="What these runs would cost on the API. On a subscription this is usage, not a bill.">
          ≈{money(k.cost7d)} API-equivalent this week
          {five ? ` · resets ${new Date(five.resetsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
        </span>
      </div>
    </section>
  );
}

// ---------------- live runs ----------------

export function LiveRuns({ runs, nav, onStop }: { runs: LiveRun[]; nav: Nav; onStop: (id: string) => void }) {
  return (
    <section className="card" aria-label="Live runs">
      <header className="card-head">
        <h2>Live runs</h2>
        <span className="muted small">{runs.length ? `${runs.length} running` : ''}</span>
      </header>
      {!runs.length && <p className="empty">Nothing running right now. Scheduled runs will appear here as they start.</p>}
      <ul className="live-list">
        {runs.map(({ run, steps, workers }) => {
          const current = steps.filter((s) => ['running', 'queued', 'waiting'].includes(s.status));
          return (
            <li key={run.id} className="live">
              <div className="live-top">
                <button className="linkish live-name" onClick={() => nav.openRun(run.workflowId, run.id)}>
                  {run.workflowName}
                </button>
                <span className="muted small">
                  {TRIGGER_ICON[run.triggerKind]} {TRIGGER_LABEL[run.triggerKind]} · {dur(Date.now() - run.startedAt)}
                </span>
                <span className="spacer" />
                <button className="btn ghost danger sm" onClick={() => onStop(run.id)}>
                  Stop
                </button>
              </div>
              <ol className="steps" aria-label="Progress">
                {steps.map((s) => (
                  <li key={s.id} className={`step st-${s.status}`} title={`${s.name}: ${s.status}${s.startedAt ? ` · ${dur((s.finishedAt ?? Date.now()) - s.startedAt)}` : ''}`}>
                    <span aria-hidden>{STATUS_ICON[s.status] ?? '○'}</span>
                  </li>
                ))}
              </ol>
              <div className="live-now small">
                {current.length ? (
                  current.map((s) => (
                    <button key={s.id} className={`linkish st-${s.status}`} onClick={() => nav.openRun(run.workflowId, run.id, s.id)}>
                      {s.status === 'waiting' ? '⏸ waiting for you at ' : s.status === 'queued' ? '◌ queued: ' : '◐ '}
                      {s.name}
                      {s.startedAt && s.status === 'running' ? ` · ${dur(Date.now() - s.startedAt)}` : ''}
                    </button>
                  ))
                ) : (
                  <span className="muted">starting…</span>
                )}
                {workers.length > 0 && (
                  <span className="workers">
                    team:{' '}
                    {workers.map((w) => (
                      <span key={w.id} className={`st-${w.status}`}>
                        {STATUS_ICON[w.status]} {w.name}
                      </span>
                    ))}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------- upcoming ----------------

export function Upcoming({
  items,
  hours,
  nav,
  onToggle,
  onRunNow,
  onPauseAll,
  onResumeAll,
  pausedCount,
}: {
  items: UpcomingItem[];
  hours: number;
  nav: Nav;
  onToggle: (workflowId: string, enable: boolean) => void;
  onRunNow: (workflowId: string, nodeId: string) => void;
  onPauseAll: () => void;
  onResumeAll: () => void;
  pausedCount: number;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const schedules = items.filter((i) => i.kind === 'trigger.schedule').sort((a, b) => (a.enabled === b.enabled ? (a.times[0] ?? Infinity) - (b.times[0] ?? Infinity) : a.enabled ? -1 : 1));
  const listeners = items.filter((i) => i.kind !== 'trigger.schedule');
  const now = Date.now();
  const end = now + hours * 3_600_000;
  const X = (t: number) => ((t - now) / (end - now)) * 100;
  const anyEnabled = items.some((i) => i.enabled);

  return (
    <section className="card" aria-label="Upcoming">
      <header className="card-head">
        <h2>Upcoming · next {hours}h</h2>
        <span className="spacer" />
        {pausedCount > 0 && (
          <button className="btn sm" onClick={onResumeAll} title="Re-enable the workflows that Pause all turned off">
            Resume {pausedCount}
          </button>
        )}
        {anyEnabled && (
          <button className="btn sm danger" onClick={onPauseAll} title="Disable every workflow's triggers and stop running runs">
            ⏸ Pause all
          </button>
        )}
      </header>
      {!schedules.length && !listeners.length && <p className="empty">Nothing scheduled. Add a Schedule, File watch or Webhook trigger to a workflow and enable it.</p>}
      {schedules.length > 0 && (
        <div className="timeline" ref={wrap} onPointerLeave={() => setTip(null)}>
          <div className="tl-axis">
            {[0, 0.25, 0.5, 0.75, 1].map((f) => (
              <span key={f} style={{ left: `${f * 100}%` }}>
                {f === 0 ? 'now' : new Date(now + f * (end - now)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            ))}
          </div>
          {schedules.map((s) => {
            const dense = s.times.length > 24;
            return (
              <div key={s.workflowId + s.nodeId} className={`tl-row ${s.enabled ? '' : 'tl-paused'}`}>
                <div className="tl-label">
                  <button className="linkish" onClick={() => nav.openWorkflow(s.workflowId)} title={s.workflowName}>
                    {s.workflowName}
                  </button>
                  <span className="muted small">
                    {s.detail}
                    {s.enabled ? (s.next ? ` · ${until(s.next)}` : '') : ' · paused'}
                  </span>
                </div>
                <div className="tl-track">
                  {dense ? (
                    <span className="tl-band" style={{ left: `${X(s.times[0])}%`, right: `${100 - X(s.times[s.times.length - 1])}%` }} title={`${s.detail}: ${s.times.length}+ runs in this window`} />
                  ) : (
                    s.times.map((t) => (
                      <span
                        key={t}
                        className="tl-dot"
                        style={{ left: `${X(t)}%` }}
                        tabIndex={0}
                        aria-label={`${s.workflowName} at ${clock(t)}`}
                        onPointerMove={(e) => {
                          const r = wrap.current!.getBoundingClientRect();
                          setTip({ x: e.clientX - r.left, y: e.clientY - r.top, text: `${s.workflowName} · ${new Date(t).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` });
                        }}
                      />
                    ))
                  )}
                </div>
                <div className="tl-actions">
                  <button className="btn ghost sm" onClick={() => onRunNow(s.workflowId, s.nodeId)} title="Run now">
                    ▶
                  </button>
                  <button className={`btn sm ${s.enabled ? '' : 'on'}`} onClick={() => onToggle(s.workflowId, !s.enabled)}>
                    {s.enabled ? 'Pause' : 'Resume'}
                  </button>
                </div>
              </div>
            );
          })}
          {tip && (
            <div className="viz-tip" style={{ left: tip.x, top: tip.y }}>
              {tip.text}
            </div>
          )}
        </div>
      )}
      {listeners.length > 0 && (
        <div className="listeners">
          <span className="muted small">Listening</span>
          {listeners.map((l) => (
            <button key={l.workflowId + l.nodeId} className={`listener ${l.enabled ? 'on' : ''}`} onClick={() => nav.openWorkflow(l.workflowId)} title={`${l.workflowName}: ${l.detail}${l.lastFiredAt ? ` · last fired ${ago(l.lastFiredAt)}` : ''}`}>
              <span aria-hidden>{TRIGGER_ICON[l.kind]}</span> {l.workflowName}
              <span className="muted"> · {l.enabled ? (l.lastFiredAt ? ago(l.lastFiredAt) : 'armed') : 'paused'}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------- files ----------------

export function LatestFiles({ files, nav, onOpenFile }: { files: FileRow[]; nav: Nav; onOpenFile: (id: string, how: 'open' | 'reveal') => void }) {
  return (
    <section className="card" aria-label="Latest files">
      <header className="card-head">
        <h2>Latest files</h2>
      </header>
      {!files.length && <p className="empty">No files yet. Add an Output node to turn results into PDF, PowerPoint, Word or Excel.</p>}
      <ul className="dfiles">
        {files.map((f) => (
          <li key={f.id}>
            <span className="file-fmt">{f.format}</span>
            <div className="dfile-main">
              <a href={`/api/files/${f.id}`} target="_blank" rel="noreferrer" title={f.path}>
                {f.name}
              </a>
              <span className="muted small">
                <button className="linkish" onClick={() => nav.openRun(f.workflowId, f.runId, f.nodeId)}>
                  {f.workflowName}
                </button>{' '}
                · <span title={clock(f.createdAt)}>{ago(f.createdAt)}</span> · {Math.max(1, Math.round(f.bytes / 1024))} KB
              </span>
            </div>
            <button className="linkbtn" onClick={() => onOpenFile(f.id, 'open')}>
              Open
            </button>
            <button className="linkbtn" onClick={() => onOpenFile(f.id, 'reveal')} title="Show in Finder">
              Finder
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------- recent runs ----------------

export function RecentRuns({
  data,
  filters,
  loading,
  nav,
  onPage,
  onCancel,
}: {
  data: { total: number; runs: RunRow[] };
  filters: RunFilters;
  loading: boolean;
  nav: Nav;
  onPage: (offset: number) => void;
  onCancel: (id: string) => void;
}) {
  const limit = filters.limit ?? 25;
  const offset = filters.offset ?? 0;
  return (
    <section className="card span-2" aria-label="Recent runs">
      <header className="card-head">
        <h2>Recent runs</h2>
        <span className="muted small">{data.total ? `${offset + 1}–${Math.min(offset + limit, data.total)} of ${data.total}` : ''}</span>
      </header>
      <div className={`table-wrap ${loading ? 'refetch' : ''}`}>
        <table className="runs-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Workflow</th>
              <th>Trigger</th>
              <th>Started</th>
              <th className="num">Duration</th>
              <th className="num" title="API-equivalent value; on a subscription this is usage, not a bill">≈ Usage</th>
              <th className="num">Files</th>
              <th>Note</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.runs.map((r) => (
              <tr key={r.id} onClick={() => nav.openRun(r.workflowId, r.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && nav.openRun(r.workflowId, r.id)}>
                <td>
                  <StatusBadge status={r.status} waiting={r.waiting} />
                </td>
                <td className="strong">{r.workflowName}</td>
                <td>
                  <span aria-hidden>{TRIGGER_ICON[r.triggerKind]}</span> {TRIGGER_LABEL[r.triggerKind] ?? r.triggerKind}
                </td>
                <td title={clock(r.startedAt)}>{ago(r.startedAt)}</td>
                <td className="num">{dur((r.finishedAt ?? Date.now()) - r.startedAt)}</td>
                <td className="num">{r.costUsd ? money(r.costUsd) : '–'}</td>
                <td className="num">{r.fileCount || '–'}</td>
                <td className="note" title={r.error}>
                  {r.status === 'failed' || r.status === 'cancelled' ? r.error : ''}
                </td>
                <td className="num">
                  {r.status === 'running' ? (
                    <button
                      className="linkbtn danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        onCancel(r.id);
                      }}
                    >
                      Stop
                    </button>
                  ) : (
                    <span className="muted">→</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data.runs.length && <p className="empty">No runs match these filters.</p>}
      </div>
      {data.total > limit && (
        <div className="pager">
          <button className="btn sm" disabled={offset === 0} onClick={() => onPage(Math.max(0, offset - limit))}>
            ← Newer
          </button>
          <button className="btn sm" disabled={offset + limit >= data.total} onClick={() => onPage(offset + limit)}>
            Older →
          </button>
        </div>
      )}
    </section>
  );
}

// ---------------- workflow health ----------------

export function WorkflowHealth({ rows, nav, onToggle, loading }: { rows: HealthRow[]; nav: Nav; onToggle: (id: string, enable: boolean) => void; loading: boolean }) {
  const [all, setAll] = useState(false);
  // Enabled first, then problems, then most recently active.
  const sorted = useMemo(
    () => [...rows].sort((a, b) => Number(b.enabled) - Number(a.enabled) || b.failed - a.failed || (b.lastAt ?? 0) - (a.lastAt ?? 0)),
    [rows],
  );
  const shown = all ? sorted : sorted.slice(0, 8);
  return (
    <section className="card" aria-label="Workflow health">
      <header className="card-head">
        <h2>Workflow health</h2>
        <span className="muted small">last 20 runs</span>
      </header>
      {!rows.length && <p className="empty">No workflows yet.</p>}
      <ul className={`health ${loading ? 'refetch' : ''}`}>
        {shown.map((w) => {
          const rate = w.success + w.failed ? w.success / (w.success + w.failed) : null;
          return (
            <li key={w.id}>
              <label className={`switch sm ${w.enabled ? 'on' : ''}`} title={w.issues ? 'Fix setup issues before enabling' : w.enabled ? 'Disable triggers' : 'Enable triggers'}>
                <input type="checkbox" checked={w.enabled} disabled={!w.enabled && w.issues > 0} onChange={() => onToggle(w.id, !w.enabled)} />
                <span className="track">
                  <span className="thumb" />
                </span>
              </label>
              <div className="health-main">
                <button className="linkish strong" onClick={() => nav.openWorkflow(w.id)}>
                  {w.name}
                </button>
                <span className="muted small">
                  {w.issues ? <span className="warnish">! {w.issues} issue{w.issues > 1 ? 's' : ''} · </span> : null}
                  {w.trigger === 'schedule' ? (w.enabled && w.nextRun ? `next ${until(w.nextRun)}` : 'scheduled · paused') : w.trigger === 'listening' ? (w.enabled ? 'listening' : 'listener paused') : 'manual'}
                  {w.avgMs ? ` · avg ${dur(w.avgMs)}` : ''}
                </span>
              </div>
              <div className="strip" aria-label={`Last ${w.recent.length} runs`}>
                {w.recent.map((r) => (
                  <button key={r.id} className={`cell st-${r.status}`} title={`${r.status} · ${clock(r.at)}`} onClick={() => nav.openRun(w.id, r.id)}>
                    <span className="sr">{r.status}</span>
                  </button>
                ))}
              </div>
              <span className="health-rate" title={`${w.success} completed, ${w.failed} failed in this period`}>
                {rate == null ? '–' : pct(rate)}
              </span>
            </li>
          );
        })}
      </ul>
      {sorted.length > 8 && (
        <button className="btn ghost sm" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${sorted.length}`}
        </button>
      )}
    </section>
  );
}

// ---------------- activity ----------------

export function Activity({ summary, loading, nav }: { summary: DashSummary; loading: boolean; nav: Nav }) {
  const [asTable, setAsTable] = useState(false);
  const byWorkflow = summary.health
    .filter((h) => h.cost > 0)
    .sort((a, b) => b.cost - a.cost)
    .map((h) => ({ id: h.id, name: h.name, value: h.cost }));
  const top = byWorkflow.slice(0, 6);
  const rest = byWorkflow.slice(6).reduce((a, r) => a + r.value, 0);
  if (rest > 0) top.push({ id: '_other', name: 'Other', value: rest });
  const totals = summary.series.reduce((a, d) => ({ s: a.s + d.success, f: a.f + d.failed }), { s: 0, f: 0 });

  return (
    <section className={`card ${loading ? 'refetch' : ''}`} aria-label="Activity">
      <header className="card-head">
        <h2>Activity</h2>
        <span className="spacer" />
        <button className="btn ghost sm" onClick={() => setAsTable(!asTable)} aria-pressed={asTable}>
          {asTable ? 'Show chart' : 'Show table'}
        </button>
      </header>
      <div className="activity">
        <div>
          <div className="chart-title">
            Runs per day
            <span className="legend">
              <span>
                <span className="swatch" style={{ background: 'var(--viz-done)' }} /> ✓ Completed {totals.s}
              </span>
              <span>
                <span className="swatch" style={{ background: 'var(--viz-failed)' }} /> ✕ Failed {totals.f}
              </span>
            </span>
          </div>
          {asTable ? (
            <table className="mini-table">
              <thead>
                <tr>
                  <th>Day</th>
                  <th className="num">Completed</th>
                  <th className="num">Failed</th>
                  <th className="num">Cancelled</th>
                  <th className="num">≈ Usage</th>
                </tr>
              </thead>
              <tbody>
                {summary.series
                  .filter((d) => d.success + d.failed + d.cancelled)
                  .map((d) => (
                    <tr key={d.day}>
                      <td>{d.day}</td>
                      <td className="num">{d.success}</td>
                      <td className="num">{d.failed}</td>
                      <td className="num">{d.cancelled}</td>
                      <td className="num">{money(d.cost)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          ) : (
            <RunsPerDay data={summary.series} />
          )}
        </div>
        <div>
          <div className="chart-title">Usage by workflow (≈ API-equivalent)</div>
          <HBars rows={top} format={(v) => money(v)} label="Usage by workflow" />
        </div>
        <div>
          <div className="chart-title">Top errors</div>
          {!summary.topErrors.length ? (
            <p className="empty ok">✓ No failures in this period.</p>
          ) : (
            <ul className="errors">
              {summary.topErrors.map((e, i) => (
                <li key={i}>
                  <button className="linkish" onClick={() => nav.openRun(e.workflowId, e.runId, e.nodeId)} title={e.message}>
                    <span className="err-count">×{e.count}</span>
                    <span className="err-msg">{e.message}</span>
                  </button>
                  <span className="muted small">
                    {e.workflowName} · {ago(e.lastAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
