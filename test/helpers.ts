import { randomUUID } from 'crypto';
import { ActionsService } from '../src/actions/actions.service';
import { Run, WfEdge, WfNode, Workflow } from '../src/common/types';
import { DatasetsService } from '../src/datasets/datasets.service';
import { AgentResult, AgentRunnerService, AgentRunOptions } from '../src/engine/agent-runner.service';
import { AppToolsService } from '../src/engine/app-tools.service';
import { EventBus } from '../src/engine/event-bus';
import { ExecutorService } from '../src/engine/executor.service';
import { InboxService } from '../src/engine/inbox.service';
import { ProcessQueue } from '../src/engine/queue';
import { RunsStore } from '../src/engine/runs.store';
import { MemoryService } from '../src/memory/memory.service';
import { PluginsService } from '../src/plugins/plugins.service';

export type Handler = (opts: AgentRunOptions, call: number) => Promise<Partial<AgentResult>> | Partial<AgentResult>;

/** Stands in for the agent runtime: records every call's options and answers from a script. */
export class FakeRunner {
  calls: AgentRunOptions[] = [];
  constructor(private handler: Handler = () => ({ text: 'done' })) {}
  async run(o: AgentRunOptions): Promise<AgentResult> {
    this.calls.push(o);
    const r = await this.handler(o, this.calls.length - 1);
    return { ok: true, text: '', sessionId: randomUUID(), costUsd: 0, rateLimited: false, cancelled: false, ...r };
  }
}

/** The real services wired by hand (as Nest would), with an optional fake runner. */
export function makeServices(runner?: FakeRunner) {
  const bus = new EventBus();
  const store = new RunsStore();
  const memory = new MemoryService();
  const datasets = new DatasetsService(bus);
  const plugins = new PluginsService();
  const actions = new ActionsService();
  const inbox = new InboxService(store, bus, actions);
  const queue = new ProcessQueue();
  const tools = new AppToolsService(memory, datasets, plugins);
  const agents = (runner as unknown as AgentRunnerService) ?? new AgentRunnerService(bus, tools);
  const executor = new ExecutorService(agents, queue, store, bus, inbox, memory, actions, plugins, datasets);
  return { bus, store, memory, datasets, plugins, actions, inbox, queue, tools, agents, executor };
}

let n = 0;
export const node = (kind: string, data: Record<string, any> = {}, id = `${kind.replace(/\W/g, '')}${++n}`): WfNode => ({ id, kind: kind as any, position: { x: 0, y: 0 }, data });
export const edge = (source: WfNode, target: WfNode, sourceHandle?: string): WfEdge => ({ id: `e${++n}`, source: source.id, target: target.id, sourceHandle });

export const agentData = (name: string, extra: Record<string, any> = {}) => ({
  name,
  prompt: `You are ${name}.`,
  model: 'haiku',
  allowedTools: [],
  disallowedTools: [],
  permissionMode: 'dontAsk',
  cwd: process.env.AGENT_CANVAS_HOME!,
  ...extra,
});

export const memoryData = (name: string, extra: Record<string, any> = {}) => ({
  name,
  scope: 'workflow',
  sources: [],
  allowWrite: true,
  rememberAnswers: false,
  injectNotes: false,
  autoRetrieve: 0,
  ...extra,
});

export function workflow(nodes: WfNode[], edges: WfEdge[], name = 'Test workflow'): Workflow {
  return { id: `wf-${randomUUID().slice(0, 8)}`, name, enabled: true, webhookToken: 't', nodes, edges, createdAt: '', updatedAt: '' };
}

/** Starts a run and resolves when it has finished. */
export async function runToEnd(executor: ExecutorService, store: RunsStore, wf: Workflow, trigger: WfNode, payload: unknown = null, timeoutMs = 600_000) {
  const run: Run = executor.start(wf, trigger.id, payload);
  const until = Date.now() + timeoutMs;
  while (executor.activeRuns().some((r) => r.id === run.id)) {
    if (Date.now() > until) throw new Error('run timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
  return store.getRun(run.id)!;
}

/** Polls until fn returns something truthy. */
export async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 300_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}
