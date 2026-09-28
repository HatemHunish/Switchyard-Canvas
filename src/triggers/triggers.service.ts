import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { FSWatcher, watch } from 'chokidar';
import { CronJob, CronTime } from 'cron';
import { Subscription } from 'rxjs';
import { expandHome } from '../common/paths';
import { Workflow } from '../common/types';
import { ExecutorService } from '../engine/executor.service';
import { validateWorkflow } from '../workflows/validate';
import { WorkflowsService } from '../workflows/workflows.service';

export interface TriggerStatus {
  nodeId: string;
  kind: string;
  armed: boolean;
  nextRunAt?: number;
  lastFiredAt?: number;
  lastSkippedAt?: number;
  error?: string;
}

interface Armed {
  stop: () => void | Promise<void>;
  status: TriggerStatus;
  next?: () => number | undefined;
  /** Upcoming fire times up to `until` (max n). */
  upcoming?: (until: number, n: number) => number[];
}

export interface UpcomingItem {
  workflowId: string;
  workflowName: string;
  nodeId: string;
  kind: string;
  /** schedule: human description; file: path; webhook: '' */
  detail: string;
  enabled: boolean;
  times: number[];
  /** Next fire time even if it's beyond the window. */
  next?: number;
  lastFiredAt?: number;
  lastSkippedAt?: number;
  error?: string;
}

/**
 * Keeps schedule and file-watch triggers of every *enabled* workflow armed.
 * Webhook triggers are passive (see HooksController) and manual ones are UI-only.
 */
@Injectable()
export class TriggersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TriggersService.name);
  private readonly armed = new Map<string, Map<string, Armed>>();
  private sub?: Subscription;

  constructor(
    private readonly workflows: WorkflowsService,
    private readonly executor: ExecutorService,
  ) {}

  onModuleInit() {
    for (const wf of this.workflows.list()) this.arm(wf);
    this.sub = this.workflows.changes$.subscribe((c) => {
      if (c.type === 'saved') this.arm(c.workflow);
      else {
        this.disarm(c.id);
        this.executor.cancelWorkflow(c.id);
      }
    });
  }

  async onModuleDestroy() {
    this.sub?.unsubscribe();
    for (const id of [...this.armed.keys()]) this.disarm(id);
  }

  status(workflowId: string): TriggerStatus[] {
    return [...(this.armed.get(workflowId)?.values() ?? [])].map((a) => ({ ...a.status, nextRunAt: a.next?.() }));
  }

  /**
   * Everything that can start a run on its own: schedule ticks in the window
   * (also for disabled workflows, shown as paused) and armed file/webhook listeners.
   */
  upcoming(hours: number): UpcomingItem[] {
    const until = Date.now() + hours * 3_600_000;
    const out: UpcomingItem[] = [];
    for (const wf of this.workflows.list()) {
      for (const node of wf.nodes) {
        if (!['trigger.schedule', 'trigger.file', 'trigger.webhook'].includes(node.kind)) continue;
        const armed = this.armed.get(wf.id)?.get(node.id);
        let times: number[] = [];
        if (node.kind === 'trigger.schedule') {
          try {
            times = armed?.upcoming
              ? armed.upcoming(until, 48)
              : node.data.mode === 'cron'
                ? cronTimes(node.data.cron, until, 48)
                : intervalTimes(Date.now() + Number(node.data.everyMinutes || 1) * 60_000, Number(node.data.everyMinutes || 1) * 60_000, until, 48);
          } catch {
            times = [];
          }
        }
        let next: number | undefined = times[0];
        if (node.kind === 'trigger.schedule' && next === undefined) {
          try {
            next = node.data.mode === 'cron' ? cronTimes(node.data.cron, Infinity, 1)[0] : undefined;
          } catch {
            next = undefined;
          }
        }
        out.push({
          next,
          workflowId: wf.id,
          workflowName: wf.name,
          nodeId: node.id,
          kind: node.kind,
          detail:
            node.kind === 'trigger.schedule' ? (node.data.mode === 'cron' ? `cron ${node.data.cron}` : `every ${node.data.everyMinutes} min`) : node.kind === 'trigger.file' ? node.data.path : 'webhook',
          enabled: wf.enabled && !!armed?.status.armed,
          times,
          lastFiredAt: armed?.status.lastFiredAt,
          lastSkippedAt: armed?.status.lastSkippedAt,
          error: armed?.status.error,
        });
      }
    }
    return out;
  }

  /** Fires a trigger; skipped if the previous run from the same trigger is still going. */
  fire(workflowId: string, nodeId: string, payload: unknown, opts: { allowOverlap?: boolean } = {}) {
    const wf = this.workflows.get(workflowId);
    const st = this.armed.get(workflowId)?.get(nodeId)?.status;
    if (!opts.allowOverlap && this.executor.isRunning(workflowId, nodeId)) {
      this.logger.log(`Skipping ${wf.name}/${nodeId}: previous run still in progress`);
      if (st) st.lastSkippedAt = Date.now();
      return null;
    }
    if (st) st.lastFiredAt = Date.now();
    return this.executor.start(wf, nodeId, payload);
  }

  private disarm(workflowId: string) {
    const m = this.armed.get(workflowId);
    if (!m) return;
    for (const a of m.values()) void a.stop();
    this.armed.delete(workflowId);
  }

  private arm(wf: Workflow) {
    this.disarm(wf.id);
    if (!wf.enabled) return;
    if (validateWorkflow(wf).length) {
      this.logger.warn(`Not arming "${wf.name}": workflow has validation issues`);
      return;
    }
    const m = new Map<string, Armed>();
    for (const node of wf.nodes) {
      const status: TriggerStatus = { nodeId: node.id, kind: node.kind, armed: true };
      try {
        if (node.kind === 'trigger.schedule') {
          const fire = () => this.safeFire(wf.id, node.id, { firedAt: new Date().toISOString(), schedule: node.data });
          if (node.data.mode === 'cron') {
            const job = CronJob.from({ cronTime: node.data.cron, onTick: fire, start: true });
            m.set(node.id, {
              status,
              stop: () => job.stop(),
              next: () => job.nextDate().toMillis(),
              upcoming: (until, n) => cronTimes(node.data.cron, until, n),
            });
          } else {
            const ms = Math.max(1, Number(node.data.everyMinutes)) * 60_000;
            let nextAt = Date.now() + ms;
            const timer = setInterval(() => {
              nextAt = Date.now() + ms;
              fire();
            }, ms);
            m.set(node.id, { status, stop: () => clearInterval(timer), next: () => nextAt, upcoming: (until, n) => intervalTimes(nextAt, ms, until, n) });
          }
        } else if (node.kind === 'trigger.file') {
          m.set(node.id, { status, stop: this.watchFiles(wf.id, node.id, node.data) });
        } else if (node.kind === 'trigger.webhook') {
          m.set(node.id, { status, stop: () => undefined });
        }
      } catch (err: any) {
        m.set(node.id, { status: { ...status, armed: false, error: err.message }, stop: () => undefined });
        this.logger.warn(`Could not arm ${node.kind} in "${wf.name}": ${err.message}`);
      }
    }
    this.armed.set(wf.id, m);
    this.logger.log(`Armed "${wf.name}" (${m.size} trigger${m.size === 1 ? '' : 's'})`);
  }

  private watchFiles(workflowId: string, nodeId: string, data: any): () => Promise<void> {
    const events: string[] = data.events?.length ? data.events : ['add', 'change'];
    const debounceMs = Number(data.debounceMs) || 1000;
    const watcher: FSWatcher = watch(expandHome(data.path), { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 300 } });
    let timer: NodeJS.Timeout | undefined;
    let pending: Array<{ event: string; path: string }> = [];
    watcher.on('all', (event, path) => {
      if (!events.includes(event)) return;
      pending.push({ event, path });
      clearTimeout(timer);
      timer = setTimeout(() => {
        const changes = pending;
        pending = [];
        this.safeFire(workflowId, nodeId, { event: changes[0].event, path: changes[0].path, changes });
      }, debounceMs);
    });
    return async () => {
      clearTimeout(timer);
      await watcher.close();
    };
  }

  private safeFire(workflowId: string, nodeId: string, payload: unknown) {
    try {
      this.fire(workflowId, nodeId, payload);
    } catch (err: any) {
      this.logger.warn(`Trigger ${workflowId}/${nodeId} failed to start: ${err.message}`);
    }
  }
}

function cronTimes(expr: string, until: number, n: number): number[] {
  const out: number[] = [];
  for (const d of new CronTime(expr).sendAt(n) as any[]) {
    const t = d.toMillis();
    if (t > until) break;
    out.push(t);
  }
  return out;
}

function intervalTimes(first: number, every: number, until: number, n: number): number[] {
  const out: number[] = [];
  for (let t = first; t <= until && out.length < n; t += every) out.push(t);
  return out;
}
