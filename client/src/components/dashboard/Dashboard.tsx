import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type ClaudeStatus, type DashSummary, type FileRow, type LiveRun, type RunFilters, type RunRow, type UpcomingItem } from '../../api';
import { subscribe } from '../../lib/live';
import type { HumanRequest } from '../../types';
import { RespondCard } from '../RespondCard';
import { Activity, AttentionStrip, LatestFiles, LiveRuns, type Nav, RecentRuns, StatTiles, Upcoming, WorkflowHealth } from './sections';

interface Props {
  inbox: HumanRequest[];
  claude: ClaudeStatus | null;
  workflows: Array<{ id: string; name: string }>;
  nav: Nav;
  notify: (msg: string, kind?: 'ok' | 'err') => void;
  onOpenInbox: () => void;
  onWorkflowsChanged: () => void;
}

const RANGES = [
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: '14d', label: '14 days' },
  { value: '30d', label: '30 days' },
];

function loadFilters(): RunFilters {
  try {
    return { range: '14d', limit: 25, ...JSON.parse(localStorage.getItem('ac.dashFilters') || '{}'), offset: 0 };
  } catch {
    return { range: '14d', limit: 25, offset: 0 };
  }
}

/** Home screen: what needs you, what's running, what's next, and how things have gone. */
export function Dashboard({ inbox, claude, workflows, nav, notify, onOpenInbox, onWorkflowsChanged }: Props) {
  const [summary, setSummary] = useState<DashSummary | null>(null);
  const [live, setLive] = useState<LiveRun[]>([]);
  const [upcoming, setUpcoming] = useState<UpcomingItem[]>([]);
  const [files, setFiles] = useState<FileRow[]>([]);
  const [runs, setRuns] = useState<{ total: number; runs: RunRow[] }>({ total: 0, runs: [] });
  const [filters, setFilters] = useState<RunFilters>(loadFilters);
  const [loading, setLoading] = useState(false);
  const [paused, setPaused] = useState(0);
  const [, tick] = useState(0);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const loadHistory = useCallback(async (f: RunFilters) => {
    setLoading(true);
    try {
      const [s, r] = await Promise.all([api.dashboard(f.range ?? '14d', f.workflowId), api.runHistory(f)]);
      setSummary(s);
      setRuns(r);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadNow = useCallback(async () => {
    const [l, u, fl, p] = await Promise.all([api.live(), api.upcoming(24), api.latestFiles(6), api.pausedIds()]);
    setLive(l);
    setUpcoming(u);
    setFiles(fl);
    setPaused(p.ids.length);
  }, []);

  const refreshAll = useCallback(() => {
    void loadNow();
    void loadHistory(filtersRef.current);
  }, [loadNow, loadHistory]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  // Filters scope the history section; keep them across reloads.
  useEffect(() => {
    try {
      const { offset, ...keep } = filters;
      localStorage.setItem('ac.dashFilters', JSON.stringify(keep));
    } catch {
      /* storage unavailable */
    }
    void loadHistory(filters);
  }, [filters, loadHistory]);

  // Live: server events trigger a (debounced) refresh; no refresh button needed.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(refreshAll, ms);
    };
    const unsub = subscribe((e) => {
      if (e.type === 'run' || e.type === 'inbox') soon(400);
      else if (e.type === 'node') {
        clearTimeout(timer);
        timer = setTimeout(() => void api.live().then(setLive), 300);
      } else if (e.type === 'usage') soon(2000);
    });
    const slow = setInterval(() => void api.upcoming(24).then(setUpcoming), 60_000);
    return () => {
      unsub();
      clearTimeout(timer);
      clearInterval(slow);
    };
  }, [refreshAll]);

  // Elapsed times tick while something runs.
  useEffect(() => {
    if (!live.length) return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [live.length]);

  const setFilter = (patch: Partial<RunFilters>) => setFilters((f) => ({ ...f, ...patch, offset: 0 }));

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) notify(ok, 'ok');
      onWorkflowsChanged();
      refreshAll();
    } catch (err) {
      const e = err as ApiError;
      notify(e.issues?.length ? e.issues.map((i) => i.message).join(' ') : e.message, 'err');
    }
  };

  const cliProblem = !claude ? undefined : !claude.installed ? 'Claude Code CLI not found. Agents can’t run.' : claude.loggedIn === false ? 'Claude Code is not logged in. Run `claude` and /login.' : undefined;

  if (!summary) return <div className="dash-loading muted">Loading dashboard…</div>;

  return (
    <div className="dash">
      <AttentionStrip items={summary.attention} cliProblem={cliProblem} nav={nav} onOpenInbox={onOpenInbox} />
      <StatTiles k={summary.kpis} onFilter={(f) => setFilter(f)} />

      <div className="dash-grid dash-cols">
        <div className="dash-col">
        <LiveRuns runs={live} nav={nav} onStop={(id) => act(() => api.cancelRun(id), 'Stopping run')} />
        <Upcoming
          items={upcoming}
          hours={24}
          nav={nav}
          pausedCount={paused}
          onToggle={(id, enable) => act(() => api.saveWorkflow(id, { enabled: enable }), enable ? 'Resumed' : 'Paused')}
          onRunNow={(id, nodeId) => act(() => api.runWorkflow(id, nodeId), 'Run started')}
          onPauseAll={() => {
            if (confirm('Pause every enabled workflow and stop anything running?')) void act(async () => notify(`Paused ${(await api.pauseAll()).paused} workflow(s)`, 'ok'));
          }}
          onResumeAll={() => act(async () => notify(`Resumed ${(await api.resumeAll()).resumed} workflow(s)`, 'ok'))}
        />
        </div>
        <div className="dash-col">
        <section className="card" aria-label="Needs you">
          <header className="card-head">
            <h2>Needs you</h2>
            <span className="muted small">{inbox.length ? `${inbox.length} waiting` : ''}</span>
          </header>
          {!inbox.length && <p className="empty ok">✓ Nothing waiting for you.</p>}
          <div className="needs">
            {inbox.slice(0, 4).map((r) => (
              <RespondCard key={r.id} request={r} showSource notify={notify} onOpen={() => nav.openRun(r.workflowId, r.runId, r.nodeId)} />
            ))}
            {inbox.length > 4 && (
              <button className="btn ghost sm" onClick={onOpenInbox}>
                +{inbox.length - 4} more in the Inbox
              </button>
            )}
          </div>
        </section>
        <LatestFiles files={files} nav={nav} onOpenFile={(id, how) => void api.openFile(id, how)} />
        </div>
      </div>

      <div className="dash-history">
        <div className="filters" role="toolbar" aria-label="History filters">
          <div className="seg" role="radiogroup" aria-label="Time range">
            {RANGES.map((r) => (
              <button key={r.value} role="radio" aria-checked={filters.range === r.value} className={filters.range === r.value ? 'on' : ''} onClick={() => setFilter({ range: r.value })}>
                {r.label}
              </button>
            ))}
          </div>
          <select value={filters.workflowId ?? ''} onChange={(e) => setFilter({ workflowId: e.target.value || undefined })} aria-label="Workflow">
            <option value="">All workflows</option>
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          <select value={filters.status ?? ''} onChange={(e) => setFilter({ status: e.target.value || undefined })} aria-label="Status">
            <option value="">Any status</option>
            <option value="running">Running</option>
            <option value="waiting">Waiting for you</option>
            <option value="failed">Failed</option>
            <option value="success">Completed</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <select value={filters.trigger ?? ''} onChange={(e) => setFilter({ trigger: e.target.value || undefined })} aria-label="Trigger">
            <option value="">Any trigger</option>
            <option value="trigger.schedule">Schedule</option>
            <option value="trigger.manual">Manual</option>
            <option value="trigger.file">File watch</option>
            <option value="trigger.webhook">Webhook</option>
          </select>
          <input className="filter-search" placeholder="Search workflow or error…" value={filters.q ?? ''} onChange={(e) => setFilter({ q: e.target.value })} aria-label="Search runs" />
          {(filters.workflowId || filters.status || filters.trigger || filters.q) && (
            <button className="btn ghost sm" onClick={() => setFilters({ range: filters.range, limit: 25, offset: 0 })}>
              Clear filters
            </button>
          )}
        </div>
        <div className="dash-grid">
          <RecentRuns data={runs} filters={filters} loading={loading} nav={nav} onPage={(offset) => setFilters((f) => ({ ...f, offset }))} onCancel={(id) => act(() => api.cancelRun(id))} />
          <WorkflowHealth rows={summary.health.filter((h) => !filters.workflowId || h.id === filters.workflowId)} nav={nav} loading={loading} onToggle={(id, enable) => act(() => api.saveWorkflow(id, { enabled: enable }), enable ? 'Enabled' : 'Disabled')} />
          <Activity summary={summary} loading={loading} nav={nav} />
        </div>
      </div>
    </div>
  );
}
