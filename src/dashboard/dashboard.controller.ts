import { Controller, Get, Post, Query } from '@nestjs/common';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DATA_DIR } from '../common/paths';
import { Workflow } from '../common/types';
import { EventBus } from '../engine/event-bus';
import { ExecutorService } from '../engine/executor.service';
import { InboxService } from '../engine/inbox.service';
import { ProcessQueue } from '../engine/queue';
import { RunsStore } from '../engine/runs.store';
import { TriggersService } from '../triggers/triggers.service';
import { validateWorkflow } from '../workflows/validate';
import { WorkflowsService } from '../workflows/workflows.service';

const PAUSED_FILE = join(DATA_DIR, 'paused.json');
const DAY = 86_400_000;
const RANGES: Record<string, number> = { '24h': DAY, '7d': 7 * DAY, '14d': 14 * DAY, '30d': 30 * DAY };

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Flow steps in execution order (no triggers, memory or team members): the progress dots of a live run. */
function orderedSteps(wf: Workflow) {
  const flow = wf.edges.filter((e) => e.sourceHandle !== 'revise' && e.sourceHandle !== 'team');
  const workers = new Set(wf.edges.filter((e) => e.sourceHandle === 'team').map((e) => e.target));
  const nodes = wf.nodes.filter((n) => !n.kind.startsWith('trigger.') && n.kind !== 'memory' && !workers.has(n.id));
  const ids = new Set(nodes.map((n) => n.id));
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of flow) if (ids.has(e.source) && ids.has(e.target)) indeg.set(e.target, indeg.get(e.target)! + 1);
  const order: string[] = [];
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).sort((a, b) => a.position.x - b.position.x).map((n) => n.id);
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of flow) {
      if (e.source !== id || !ids.has(e.target)) continue;
      indeg.set(e.target, indeg.get(e.target)! - 1);
      if (indeg.get(e.target) === 0) queue.push(e.target);
    }
  }
  const name = (n: (typeof nodes)[number]) => n.data?.name || n.data?.title || n.label || n.kind;
  return {
    steps: order.map((id) => nodes.find((n) => n.id === id)!).map((n) => ({ id: n.id, kind: n.kind, name: name(n) })),
    workers: wf.edges
      .filter((e) => e.sourceHandle === 'team')
      .map((e) => ({ id: e.target, lead: e.source, name: wf.nodes.find((n) => n.id === e.target)?.data?.name ?? e.target })),
  };
}

@Controller('api/dashboard')
export class DashboardController {
  constructor(
    private readonly store: RunsStore,
    private readonly workflows: WorkflowsService,
    private readonly executor: ExecutorService,
    private readonly inbox: InboxService,
    private readonly triggers: TriggersService,
    private readonly bus: EventBus,
    private readonly queue: ProcessQueue,
  ) {}

  @Get('summary')
  summary(@Query('range') range = '14d', @Query('workflowId') workflowId?: string) {
    const now = Date.now();
    const span = RANGES[range] ?? RANGES['14d'];
    const since = now - span;
    const wfs = this.workflows.list();

    // KPIs (always "now"-relative, not scoped by the history filter).
    const week = this.store.dailyCounts(now - 7 * DAY);
    const prevWeek = this.store.dailyCounts(now - 14 * DAY).filter((d) => !week.some((w) => w.day === d.day));
    const rate = (rows: typeof week) => {
      const s = rows.reduce((a, r) => a + r.success, 0);
      const f = rows.reduce((a, r) => a + r.failed, 0);
      return s + f ? s / (s + f) : null;
    };
    const today = this.store.queryRuns({ since: startOfToday(), limit: 1 }).total;
    const failed24 = this.store.queryRuns({ since: now - DAY, status: 'failed', limit: 5 });
    const upcoming = this.triggers.upcoming(24 * 30);
    const next = upcoming
      .filter((u) => u.enabled && u.times.length)
      .map((u) => ({ at: u.times[0], workflowId: u.workflowId, workflowName: u.workflowName }))
      .sort((a, b) => a.at - b.at)[0];
    const last7Days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(startOfToday() - (6 - i) * DAY);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const row = week.find((w) => w.day === key);
      return row ? row.success + row.failed + row.cancelled + row.running : 0;
    });
    const usage = this.bus.usage;
    const kpis = {
      running: this.executor.activeRuns().length,
      waiting: this.inbox.list().length,
      runsToday: today,
      runsTrend: last7Days,
      successRate7d: rate(week),
      successRatePrev7d: rate(prevWeek),
      failed24h: failed24.total,
      next: next ?? null,
      usage,
      cost7d: week.reduce((a, r) => a + (r.cost ?? 0), 0),
      queue: this.queue.stats,
      enabledWorkflows: wfs.filter((w) => w.enabled).length,
      workflows: wfs.length,
    };

    // Attention strip: only things that need a person.
    const attention: Array<{ level: 'warning' | 'critical'; kind: string; text: string; workflowId?: string; runId?: string; nodeId?: string }> = [];
    if (kpis.waiting) attention.push({ level: 'warning', kind: 'waiting', text: `${kpis.waiting} waiting for you` });
    // One chip per failing workflow, with the step's real error rather than the run's generic one.
    const failedByWf = new Map<string, { name: string; count: number; runId: string; nodeId?: string; error?: string }>();
    for (const r of this.store.queryRuns({ since: now - DAY, status: 'failed', limit: 200 }).runs) {
      const g = failedByWf.get(r.workflowId);
      if (g) {
        g.count++;
        continue;
      }
      const step = this.store.getRun(r.id)?.nodes.find((n) => n.status === 'failed' && n.error);
      failedByWf.set(r.workflowId, { name: r.workflowName, count: 1, runId: r.id, nodeId: step?.nodeId, error: (step?.error ?? r.error ?? '').split('\n')[0] });
    }
    for (const [workflowId, g] of [...failedByWf].slice(0, 4)) {
      attention.push({ level: 'critical', kind: 'failed', text: `${g.name} failed${g.count > 1 ? ` ${g.count}×` : ''}${g.error ? `: ${g.error.slice(0, 90)}` : ''}`, workflowId, runId: g.runId, nodeId: g.nodeId });
    }
    if (failedByWf.size > 4) attention.push({ level: 'critical', kind: 'failed-more', text: `${failedByWf.size - 4} more workflows failed in the last 24h` });
    for (const u of upcoming) {
      if (u.error) attention.push({ level: 'critical', kind: 'trigger-error', text: `${u.workflowName}: trigger not armed (${u.error})`, workflowId: u.workflowId, nodeId: u.nodeId });
      else if (u.lastSkippedAt && now - u.lastSkippedAt < DAY)
        attention.push({ level: 'warning', kind: 'skipped', text: `${u.workflowName}: a scheduled run was skipped because the previous one was still going`, workflowId: u.workflowId, nodeId: u.nodeId });
    }
    for (const w of wfs) if (w.enabled && validateWorkflow(w).length) attention.push({ level: 'warning', kind: 'issues', text: `${w.name} is enabled but has setup issues`, workflowId: w.id });
    const five = usage?.fiveHour?.utilization ?? 0;
    if (five >= 0.8) attention.push({ level: five >= 0.95 ? 'critical' : 'warning', kind: 'usage', text: `5-hour usage at ${Math.round(five * 100)}%` });

    // History (scoped by range + workflow).
    const { agg, last } = this.store.workflowStats(since);
    const health = wfs.map((w) => {
      const a = agg.find((x) => x.id === w.id);
      const nextRun = upcoming.filter((u) => u.workflowId === w.id && u.enabled && u.times.length).map((u) => u.times[0]).sort()[0];
      const hasSchedule = w.nodes.some((n) => n.kind === 'trigger.schedule');
      const listens = w.nodes.filter((n) => n.kind === 'trigger.file' || n.kind === 'trigger.webhook').length;
      return {
        id: w.id,
        name: w.name,
        enabled: w.enabled,
        issues: validateWorkflow(w).length,
        runs: a?.runs ?? 0,
        success: a?.success ?? 0,
        failed: a?.failed ?? 0,
        cost: a?.cost ?? 0,
        avgMs: a?.avgMs ?? null,
        lastAt: a?.lastAt ?? last.get(w.id)?.at(-1)?.at ?? null,
        recent: last.get(w.id) ?? [],
        nextRun: nextRun ?? null,
        trigger: hasSchedule ? 'schedule' : listens ? 'listening' : 'manual',
      };
    });
    const days = Math.round(span / DAY) || 1;
    const daily = this.store.dailyCounts(since, workflowId);
    const series = Array.from({ length: days }, (_, i) => {
      const d = new Date(startOfToday() - (days - 1 - i) * DAY);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const r = daily.find((x) => x.day === key);
      return { day: key, success: r?.success ?? 0, failed: r?.failed ?? 0, cancelled: r?.cancelled ?? 0, running: r?.running ?? 0, cost: r?.cost ?? 0 };
    });

    return { kpis, attention, health, series, topErrors: this.store.topErrors(since).filter((e) => !workflowId || e.workflowId === workflowId), range };
  }

  @Get('live')
  live() {
    return this.executor.activeRuns().map((run) => {
      const detail = this.store.getRun(run.id);
      let layout: ReturnType<typeof orderedSteps> = { steps: [], workers: [] };
      try {
        layout = orderedSteps(this.workflows.get(run.workflowId));
      } catch {
        /* workflow deleted mid-run */
      }
      const status = new Map(detail?.nodes.map((n) => [n.nodeId, n]) ?? []);
      const pick = (id: string) => {
        const n = status.get(id);
        return { status: n?.status ?? 'pending', startedAt: n?.startedAt, finishedAt: n?.finishedAt };
      };
      return {
        run,
        steps: layout.steps.map((s) => ({ ...s, ...pick(s.id) })),
        workers: layout.workers.map((w) => ({ ...w, ...pick(w.id) })).filter((w) => w.status !== 'pending'),
      };
    });
  }

  @Get('upcoming')
  upcoming(@Query('hours') hours = '24') {
    return this.triggers.upcoming(Math.min(24 * 14, Math.max(1, Number(hours) || 24)));
  }

  @Get('files')
  files(@Query('limit') limit = '12') {
    return this.store.latestFiles(Math.min(50, Number(limit) || 12));
  }

  @Get('runs')
  runs(
    @Query('range') range?: string,
    @Query('status') status?: string,
    @Query('trigger') trigger?: string,
    @Query('workflowId') workflowId?: string,
    @Query('q') q?: string,
    @Query('limit') limit = '25',
    @Query('offset') offset = '0',
  ) {
    const since = range && RANGES[range] ? Date.now() - RANGES[range] : undefined;
    const st = status === 'waiting' ? 'running' : status || undefined;
    const res = this.store.queryRuns({ since, status: st, trigger: trigger || undefined, workflowId: workflowId || undefined, q: q?.trim() || undefined, limit: Math.min(100, Number(limit) || 25), offset: Number(offset) || 0 });
    const waitingRuns = new Set(this.inbox.list().map((r) => r.runId));
    const runs = res.runs.map((r) => ({ ...r, waiting: waitingRuns.has(r.id) })).filter((r) => status !== 'waiting' || r.waiting);
    return { total: status === 'waiting' ? runs.length : res.total, runs };
  }

  /** Emergency stop: disable every enabled workflow (remembering which), and cancel what's running. */
  @Post('pause-all')
  pauseAll() {
    const enabled = this.workflows.list().filter((w) => w.enabled);
    const previous: string[] = existsSync(PAUSED_FILE) ? JSON.parse(readFileSync(PAUSED_FILE, 'utf8')) : [];
    writeFileSync(PAUSED_FILE, JSON.stringify([...new Set([...previous, ...enabled.map((w) => w.id)])]));
    for (const w of enabled) this.workflows.update(w.id, { enabled: false });
    const running = this.executor.activeRuns();
    for (const r of running) this.executor.cancel(r.id);
    return { paused: enabled.length, cancelled: running.length };
  }

  @Post('resume-all')
  resumeAll() {
    const ids: string[] = existsSync(PAUSED_FILE) ? JSON.parse(readFileSync(PAUSED_FILE, 'utf8')) : [];
    let resumed = 0;
    for (const id of ids) {
      try {
        const w = this.workflows.get(id);
        if (!validateWorkflow(w).length) {
          this.workflows.update(id, { enabled: true });
          resumed++;
        }
      } catch {
        /* deleted since */
      }
    }
    if (existsSync(PAUSED_FILE)) unlinkSync(PAUSED_FILE);
    return { resumed };
  }

  @Get('paused')
  paused() {
    return { ids: existsSync(PAUSED_FILE) ? JSON.parse(readFileSync(PAUSED_FILE, 'utf8')) : [] };
  }
}
