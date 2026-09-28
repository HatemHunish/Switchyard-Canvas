import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { DB_PATH } from '../common/paths';
import { HumanRequest, NodeEvent, NodeRun, OutputFile, Run } from '../common/types';

/** Cap per node so a chatty agent can't bloat the DB. */
const MAX_EVENTS_PER_NODE = 400;

@Injectable()
export class RunsStore implements OnModuleDestroy {
  private db = new Database(DB_PATH);

  constructor() {
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        workflow_name TEXT NOT NULL,
        trigger_node_id TEXT NOT NULL,
        trigger_kind TEXT NOT NULL,
        trigger_payload TEXT,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        error TEXT,
        cost_usd REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS runs_by_workflow ON runs (workflow_id, started_at DESC);
      CREATE TABLE IF NOT EXISTS node_runs (
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        prompt TEXT,
        output TEXT,
        error TEXT,
        session_id TEXT,
        cost_usd REAL,
        events TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (run_id, node_id)
      );
      CREATE TABLE IF NOT EXISTS human_requests (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS requests_by_run ON human_requests (run_id);
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        format TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    // A crash or restart leaves in-flight runs orphaned; close them out.
    this.db
      .prepare(`UPDATE runs SET status = 'failed', error = 'Interrupted by server restart', finished_at = ? WHERE status IN ('queued','running')`)
      .run(Date.now());
    this.db
      .prepare(`UPDATE node_runs SET status = 'cancelled' WHERE status IN ('pending','queued','running','waiting')`)
      .run();
    // Waiting lives in memory, so requests left open by a restart can no longer be answered.
    this.db.prepare(`UPDATE human_requests SET status = 'cancelled' WHERE status = 'pending'`).run();
  }

  onModuleDestroy() {
    this.db.close();
  }

  insertRun(run: Run) {
    this.db
      .prepare(
        `INSERT INTO runs (id, workflow_id, workflow_name, trigger_node_id, trigger_kind, trigger_payload, status, started_at, cost_usd)
         VALUES (@id, @workflowId, @workflowName, @triggerNodeId, @triggerKind, @payload, @status, @startedAt, 0)`,
      )
      .run({ ...run, payload: JSON.stringify(run.triggerPayload ?? null) });
  }

  updateRun(run: Run) {
    this.db
      .prepare(`UPDATE runs SET status = @status, finished_at = @finishedAt, error = @error, cost_usd = @costUsd WHERE id = @id`)
      .run({ id: run.id, status: run.status, finishedAt: run.finishedAt ?? null, error: run.error ?? null, costUsd: run.costUsd });
  }

  upsertNode(n: NodeRun) {
    this.db
      .prepare(
        `INSERT INTO node_runs (run_id, node_id, status, started_at, finished_at, prompt, output, error, session_id, cost_usd, events)
         VALUES (@runId, @nodeId, @status, @startedAt, @finishedAt, @prompt, @output, @error, @sessionId, @costUsd, @events)
         ON CONFLICT (run_id, node_id) DO UPDATE SET
           status = excluded.status, started_at = excluded.started_at, finished_at = excluded.finished_at,
           prompt = excluded.prompt, output = excluded.output, error = excluded.error,
           session_id = excluded.session_id, cost_usd = excluded.cost_usd, events = excluded.events`,
      )
      .run({
        runId: n.runId,
        nodeId: n.nodeId,
        status: n.status,
        startedAt: n.startedAt ?? null,
        finishedAt: n.finishedAt ?? null,
        prompt: n.prompt ?? null,
        output: n.output ? JSON.stringify(n.output) : null,
        error: n.error ?? null,
        sessionId: n.sessionId ?? null,
        costUsd: n.costUsd ?? null,
        events: JSON.stringify(n.events.slice(-MAX_EVENTS_PER_NODE)),
      });
  }

  listRuns(workflowId?: string, limit = 50): Run[] {
    return this.queryRuns({ workflowId, limit }).runs;
  }

  /** Filtered, paged run history (dashboard "Recent runs"). */
  queryRuns(f: { workflowId?: string; status?: string; trigger?: string; since?: number; q?: string; limit?: number; offset?: number }) {
    const where: string[] = [];
    const args: unknown[] = [];
    if (f.workflowId) (where.push('workflow_id = ?'), args.push(f.workflowId));
    if (f.status) (where.push('status = ?'), args.push(f.status));
    if (f.trigger) (where.push('trigger_kind = ?'), args.push(f.trigger));
    if (f.since) (where.push('started_at >= ?'), args.push(f.since));
    if (f.q) (where.push('(workflow_name LIKE ? OR error LIKE ?)'), args.push(`%${f.q}%`, `%${f.q}%`));
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM runs ${w}`).get(...args) as { n: number }).n;
    const rows = this.db.prepare(`SELECT * FROM runs ${w} ORDER BY started_at DESC LIMIT ? OFFSET ?`).all(...args, f.limit ?? 50, f.offset ?? 0);
    const runs = rows.map(toRun);
    // File counts per run, for the table's "files" column.
    const counts = new Map<string, number>();
    const stepErrors = new Map<string, string>();
    if (runs.length) {
      const ids = runs.map((x) => x.id);
      const ph = ids.map(() => '?').join(',');
      // Distinct names: a Save action's copy is the same file as its Output.
      const q = `SELECT run_id, COUNT(DISTINCT name) AS n FROM files WHERE run_id IN (${ph}) GROUP BY run_id`;
      for (const r of this.db.prepare(q).all(...ids) as Array<{ run_id: string; n: number }>) counts.set(r.run_id, r.n);
      // The failing step's own error explains more than the run's summary.
      const eq = `SELECT run_id, error FROM node_runs WHERE run_id IN (${ph}) AND status = 'failed' AND error IS NOT NULL`;
      for (const r of this.db.prepare(eq).all(...ids) as Array<{ run_id: string; error: string }>) if (!stepErrors.has(r.run_id)) stepErrors.set(r.run_id, r.error.split('\n')[0]);
    }
    return { total, runs: runs.map((r) => ({ ...r, fileCount: counts.get(r.id) ?? 0, error: stepErrors.get(r.id) ?? r.error })) };
  }

  /** Runs per local day, by outcome, for the activity chart. */
  dailyCounts(since: number, workflowId?: string) {
    const q = `SELECT date(started_at / 1000, 'unixepoch', 'localtime') AS day,
        SUM(status = 'success') AS success, SUM(status = 'failed') AS failed, SUM(status = 'cancelled') AS cancelled,
        SUM(status IN ('running','queued')) AS running, SUM(cost_usd) AS cost
      FROM runs WHERE started_at >= ? ${workflowId ? 'AND workflow_id = ?' : ''} GROUP BY day ORDER BY day`;
    return this.db.prepare(q).all(...[since, ...(workflowId ? [workflowId] : [])]) as Array<{ day: string; success: number; failed: number; cancelled: number; running: number; cost: number }>;
  }

  /** Per-workflow stats since a time, plus each workflow's last 20 outcomes. */
  workflowStats(since: number) {
    const agg = this.db
      .prepare(
        `SELECT workflow_id AS id, COUNT(*) AS runs, SUM(status = 'success') AS success, SUM(status = 'failed') AS failed, SUM(cost_usd) AS cost,
           AVG(CASE WHEN finished_at IS NOT NULL THEN finished_at - started_at END) AS avgMs, MAX(started_at) AS lastAt
         FROM runs WHERE started_at >= ? GROUP BY workflow_id`,
      )
      .all(since) as Array<{ id: string; runs: number; success: number; failed: number; cost: number; avgMs: number | null; lastAt: number }>;
    const recent = this.db
      .prepare(
        `SELECT workflow_id, id, status, started_at FROM (
           SELECT workflow_id, id, status, started_at, ROW_NUMBER() OVER (PARTITION BY workflow_id ORDER BY started_at DESC) AS rn FROM runs
         ) WHERE rn <= 20 ORDER BY started_at ASC`,
      )
      .all() as Array<{ workflow_id: string; id: string; status: string; started_at: number }>;
    const last = new Map<string, Array<{ id: string; status: string; at: number }>>();
    for (const r of recent) {
      const a = last.get(r.workflow_id) ?? [];
      a.push({ id: r.id, status: r.status, at: r.started_at });
      last.set(r.workflow_id, a);
    }
    return { agg, last };
  }

  /** Most frequent step/run errors since a time, grouped by message. */
  topErrors(since: number, limit = 6) {
    const rows = this.db
      .prepare(
        `SELECT n.error AS message, r.workflow_id AS workflowId, r.workflow_name AS workflowName, r.id AS runId, n.node_id AS nodeId, r.started_at AS at
         FROM node_runs n JOIN runs r ON r.id = n.run_id WHERE n.status = 'failed' AND n.error IS NOT NULL AND r.started_at >= ? ORDER BY r.started_at DESC`,
      )
      .all(since) as Array<{ message: string; workflowId: string; workflowName: string; runId: string; nodeId: string; at: number }>;
    const groups = new Map<string, { message: string; count: number; lastAt: number; workflowId: string; workflowName: string; runId: string; nodeId: string }>();
    for (const r of rows) {
      // Collapse ids, paths and numbers so repeats of the same problem group together.
      const key = r.message.split('\n')[0].replace(/\/[^\s'"]+/g, '<path>').replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<id>').replace(/\d+/g, '#').slice(0, 160);
      const g = groups.get(key);
      if (g) g.count++;
      else groups.set(key, { message: r.message.split('\n')[0].slice(0, 240), count: 1, lastAt: r.at, workflowId: r.workflowId, workflowName: r.workflowName, runId: r.runId, nodeId: r.nodeId });
    }
    return [...groups.values()].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt).slice(0, limit);
  }

  latestFiles(limit = 12) {
    return (
      this.db
        .prepare(
          `SELECT f.id, f.path, f.name, f.format, f.bytes, f.created_at AS createdAt, f.run_id AS runId, f.node_id AS nodeId, r.workflow_id AS workflowId, r.workflow_name AS workflowName
           FROM files f JOIN runs r ON r.id = f.run_id ORDER BY f.created_at DESC LIMIT ?`,
        )
        .all(limit * 3) as Array<OutputFile & { createdAt: number; runId: string; nodeId: string; workflowId: string; workflowName: string }>
    )
      .filter((f, i, a) => a.findIndex((x) => x.path === f.path || (x.runId === f.runId && x.name === f.name)) === i)
      .slice(0, limit);
  }

  getRun(id: string): { run: Run; nodes: NodeRun[] } | null {
    const row = this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id);
    if (!row) return null;
    const nodes = this.db.prepare(`SELECT * FROM node_runs WHERE run_id = ?`).all(id).map(toNodeRun);
    return { run: toRun(row), nodes };
  }

  upsertRequest(r: HumanRequest) {
    this.db
      .prepare(
        `INSERT INTO human_requests (id, run_id, workflow_id, status, created_at, data) VALUES (@id, @runId, @workflowId, @status, @createdAt, @data)
         ON CONFLICT (id) DO UPDATE SET status = excluded.status, data = excluded.data`,
      )
      .run({ id: r.id, runId: r.runId, workflowId: r.workflowId, status: r.status, createdAt: r.createdAt, data: JSON.stringify(r) });
  }

  /** Every request made during a run (reviews and questions), oldest first. */
  requestsForRun(runId: string): HumanRequest[] {
    return this.db
      .prepare(`SELECT data, status FROM human_requests WHERE run_id = ? ORDER BY created_at`)
      .all(runId)
      .map((r: any) => ({ ...JSON.parse(r.data), status: r.status }));
  }

  /** Registers a produced file; only registered files can be downloaded through the API. */
  addFile(f: Omit<OutputFile, 'id'> & { runId: string; workflowId: string; nodeId: string }): OutputFile {
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO files (id, run_id, workflow_id, node_id, path, name, format, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, f.runId, f.workflowId, f.nodeId, f.path, f.name, f.format, f.bytes, Date.now());
    return { id, path: f.path, name: f.name, format: f.format, bytes: f.bytes };
  }

  getFile(id: string): OutputFile | null {
    const r = this.db.prepare(`SELECT * FROM files WHERE id = ?`).get(id) as any;
    return r ? { id: r.id, path: r.path, name: r.name, format: r.format, bytes: r.bytes } : null;
  }

  deleteRunsForWorkflow(workflowId: string) {
    this.db.prepare(`DELETE FROM files WHERE workflow_id = ?`).run(workflowId);
    this.db.prepare(`DELETE FROM human_requests WHERE workflow_id = ?`).run(workflowId);
    this.db.prepare(`DELETE FROM node_runs WHERE run_id IN (SELECT id FROM runs WHERE workflow_id = ?)`).run(workflowId);
    this.db.prepare(`DELETE FROM runs WHERE workflow_id = ?`).run(workflowId);
  }
}

function toRun(r: any): Run {
  return {
    id: r.id,
    workflowId: r.workflow_id,
    workflowName: r.workflow_name,
    triggerNodeId: r.trigger_node_id,
    triggerKind: r.trigger_kind,
    triggerPayload: r.trigger_payload ? JSON.parse(r.trigger_payload) : null,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at ?? undefined,
    error: r.error ?? undefined,
    costUsd: r.cost_usd ?? 0,
  };
}

function toNodeRun(r: any): NodeRun {
  return {
    runId: r.run_id,
    nodeId: r.node_id,
    status: r.status,
    startedAt: r.started_at ?? undefined,
    finishedAt: r.finished_at ?? undefined,
    prompt: r.prompt ?? undefined,
    output: r.output ? JSON.parse(r.output) : undefined,
    error: r.error ?? undefined,
    sessionId: r.session_id ?? undefined,
    costUsd: r.cost_usd ?? undefined,
    events: JSON.parse(r.events || '[]') as NodeEvent[],
  };
}
