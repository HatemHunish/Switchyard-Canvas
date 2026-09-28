import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { runInNewContext } from 'vm';
import { existsSync, mkdirSync, statSync } from 'fs';
import { basename, join } from 'path';
import { DATA_DIR, expandHome, loadSettings } from '../common/paths';
import { ActionData, AgentData, HumanData, MemoryData, NodeEvent, OrchestratorData, OutputData, OutputFile, NodeOutput, NodeRun, NodeStatus, Run, WfNode, Workflow } from '../common/types';
import { ActionsService, freePath, safeName } from '../actions/actions.service';
import { MemoryService, storeIdFor } from '../memory/memory.service';
import { convert, EXT } from '../output/convert';
import { validateWorkflow } from '../workflows/validate';
import { ClaudeCliService, CliResult, CliRunOptions, eventsFromMessage, toolResultText } from './claude-cli.service';
import { EventBus } from './event-bus';
import { InboxService, RequestClosedError } from './inbox.service';
import { ProcessQueue } from './queue';
import { RunsStore } from './runs.store';
import { renderTemplate } from './template';

const JUDGE_SCHEMA = JSON.stringify({
  type: 'object',
  properties: { pass: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['pass', 'reason'],
});

const QUESTION_MARKER = 'QUESTION FOR USER:';
// Headless runs look conversational to the model, so it must be told plainly that text replies reach nobody.
const ASK_PROTOCOL = `You are running unattended inside an automated workflow. No human reads your text replies until the whole task is finished, so a question written in your reply will never be answered. The ONLY way to reach the user is the mcp__agent_canvas__ask_user tool: if you need information or a decision only the user can give, call it with one clear question and then end your turn. Otherwise complete the task without asking.`;

/** Fallback for agents that ask in plain text instead of calling ask_user. */
function extractQuestion(text: string): string | null {
  const m = text.match(/(?:^|\n)\s*\**QUESTION FOR USER:\**\s*([\s\S]+)$/);
  return m ? m[1].trim() : null;
}

interface ActiveRun {
  run: Run;
  controller: AbortController;
}

type EdgeState = 'pending' | 'active' | 'dead';

const FORMAT_NAMES: Record<string, string> = {
  pdf: 'PDF',
  pptx: 'PowerPoint (.pptx)',
  docx: 'Word (.docx)',
  xlsx: 'Excel (.xlsx)',
  html: 'HTML',
  md: 'Markdown',
  csv: 'CSV',
  json: 'JSON',
  txt: 'plain text',
};

type LoopBack = (reviewId: string, feedback: string, round: number) => Promise<Array<{ from: WfNode; out?: NodeOutput }> | null>;

interface RunHelpers {
  loopBack: LoopBack;
  workerRun: (nodeId: string) => NodeRun;
}

/** Best machine-readable view of a node's output, for expressions and templates. */
function valueOf(out?: NodeOutput): unknown {
  if (!out) return undefined;
  if (out.structured !== undefined) return out.structured;
  try {
    return JSON.parse(out.text);
  } catch {
    return out.text;
  }
}

/** A review's "↩ revise" edge: a loop back to an earlier agent, not a forward step. */
export const isLoopEdge = (e: { sourceHandle?: string | null }) => e.sourceHandle === 'revise';
/** An orchestrator's "team" edge: the target agent is a worker it can delegate to, not a flow step. */
export const isTeamEdge = (e: { sourceHandle?: string | null }) => e.sourceHandle === 'team';

/** Subagent key for a worker (what the orchestrator passes as subagent_type). */
export const workerKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'worker';

/** Strips the CLI's hand-back preamble and trailing agentId/usage metadata from a subagent's final report. */
function handBackText(raw: string): string {
  const t = raw
    .replace(/<usage>[\s\S]*?<\/usage>\s*$/, '')
    .replace(/\n?agentId: [^\n]*\(use SendMessage[^\n]*\)\s*$/, '')
    .trim();
  if (!t.startsWith('[Subagent hand-back]')) return t;
  const cut = t.indexOf('\n\n');
  return cut > 0 ? t.slice(cut).trim() : t.replace(/^\[Subagent hand-back\][^\n]*\n?/, '').trim();
}

function joinInputs(inputs: Array<{ from: WfNode; out?: NodeOutput }>): string {
  return inputs.length === 1
    ? textOf(inputs[0].out)
    : inputs.map((i) => `### From ${i.from.data?.name || i.from.label || i.from.kind}\n${textOf(i.out)}`).join('\n\n---\n\n');
}

function textOf(out?: NodeOutput): string {
  if (!out) return '';
  return out.structured !== undefined ? JSON.stringify(out.structured, null, 2) : out.text;
}

@Injectable()
export class ExecutorService {
  private readonly logger = new Logger(ExecutorService.name);
  private readonly active = new Map<string, ActiveRun>();

  constructor(
    private readonly cli: ClaudeCliService,
    private readonly queue: ProcessQueue,
    private readonly store: RunsStore,
    private readonly bus: EventBus,
    private readonly inbox: InboxService,
    private readonly memory: MemoryService,
    private readonly actions: ActionsService,
  ) {}

  /** Stores already refreshed during a run, so "re-index before run" happens once per run. */
  private readonly indexedInRun = new Map<string, Set<string>>();

  /** True while a run started by this trigger is still going (used to avoid overlapping monitor runs). */
  isRunning(workflowId: string, triggerNodeId: string): boolean {
    for (const { run } of this.active.values()) {
      if (run.workflowId === workflowId && run.triggerNodeId === triggerNodeId) return true;
    }
    return false;
  }

  activeRuns(): Run[] {
    return [...this.active.values()].map((a) => a.run);
  }

  cancel(runId: string): boolean {
    const a = this.active.get(runId);
    if (!a) return false;
    a.controller.abort();
    return true;
  }

  cancelWorkflow(workflowId: string) {
    for (const a of this.active.values()) if (a.run.workflowId === workflowId) a.controller.abort();
  }

  /** Starts a run in the background and returns it immediately. */
  start(wf: Workflow, triggerNodeId: string, payload: unknown): Run {
    const issues = validateWorkflow(wf);
    if (issues.length) throw new BadRequestException({ message: 'Workflow is not runnable', issues });
    const trigger = wf.nodes.find((n) => n.id === triggerNodeId);
    if (!trigger || !trigger.kind.startsWith('trigger.')) throw new BadRequestException('Unknown trigger node');

    const run: Run = {
      id: randomUUID(),
      workflowId: wf.id,
      workflowName: wf.name,
      triggerNodeId,
      triggerKind: trigger.kind,
      triggerPayload: payload ?? null,
      status: 'running',
      startedAt: Date.now(),
      costUsd: 0,
    };
    const controller = new AbortController();
    this.active.set(run.id, { run, controller });
    this.store.insertRun(run);
    this.bus.emit({ type: 'run', run });

    this.execute(wf, trigger, run, controller.signal)
      .catch((err) => {
        this.logger.error(err);
        run.status = 'failed';
        run.error = String(err?.message ?? err);
      })
      .finally(() => {
        run.finishedAt = Date.now();
        this.active.delete(run.id);
        this.indexedInRun.delete(run.id);
        this.store.updateRun(run);
        this.bus.emit({ type: 'run', run });
      });
    return run;
  }

  private async execute(wf: Workflow, trigger: WfNode, run: Run, signal: AbortSignal) {
    const byId = new Map(wf.nodes.map((n) => [n.id, n]));

    // Only the part of the graph downstream of this trigger takes part in the run.
    // Loop edges don't make nodes reachable or gate them; they're only followed on a rejection.
    const flowEdges = wf.edges.filter((e) => !isLoopEdge(e) && !isTeamEdge(e));
    const reachable = new Set<string>([trigger.id]);
    const stack = [trigger.id];
    while (stack.length) {
      const id = stack.pop()!;
      for (const e of flowEdges) {
        if (e.source === id && !reachable.has(e.target) && byId.has(e.target)) {
          reachable.add(e.target);
          stack.push(e.target);
        }
      }
    }
    const edges = flowEdges.filter((e) => reachable.has(e.source) && reachable.has(e.target));
    const edgeState = new Map<string, EdgeState>(edges.map((e) => [e.id, 'pending']));
    const incoming = (id: string) => edges.filter((e) => e.target === id);
    const outgoing = (id: string) => edges.filter((e) => e.source === id);

    const nodeRuns = new Map<string, NodeRun>();
    for (const id of reachable) {
      const nr: NodeRun = { runId: run.id, nodeId: id, status: 'pending', events: [] };
      nodeRuns.set(id, nr);
    }
    const save = (nr: NodeRun) => {
      this.store.upsertNode(nr);
      const { events, ...rest } = nr;
      this.bus.emit({ type: 'node', workflowId: wf.id, node: rest });
    };
    const setStatus = (nr: NodeRun, status: NodeStatus) => {
      nr.status = status;
      if (status === 'running' && !nr.startedAt) nr.startedAt = Date.now();
      if (['success', 'failed', 'skipped', 'cancelled'].includes(status)) nr.finishedAt = Date.now();
      save(nr);
    };
    nodeRuns.forEach(save);

    const outputs = new Map<string, NodeOutput>();
    const payloadText = run.triggerPayload == null ? '' : typeof run.triggerPayload === 'string' ? run.triggerPayload : JSON.stringify(run.triggerPayload, null, 2);
    const trig = nodeRuns.get(trigger.id)!;
    outputs.set(trigger.id, { text: payloadText, structured: typeof run.triggerPayload === 'object' && run.triggerPayload !== null ? run.triggerPayload : undefined });
    trig.output = outputs.get(trigger.id);
    setStatus(trig, 'success');

    const started = new Set<string>([trigger.id]);
    const inFlight = new Set<Promise<void>>();
    let anyFailed = false;

    const resolveOutgoing = (id: string, ok: boolean) => {
      const node = byId.get(id)!;
      const out = outputs.get(id);
      for (const e of outgoing(id)) {
        let active = ok;
        if (ok && (node.kind === 'condition' || node.kind === 'human')) active = (e.sourceHandle ?? 'true') === String(!!out?.pass);
        edgeState.set(e.id, active ? 'active' : 'dead');
      }
      for (const e of outgoing(id)) tryStart(e.target);
    };

    const tryStart = (id: string) => {
      if (started.has(id)) return;
      const node = byId.get(id)!;
      const states = incoming(id).map((e) => edgeState.get(e.id));
      const anyActive = states.includes('active');
      const allResolved = !states.includes('pending');
      let go: boolean | null = null; // null = keep waiting
      if (node.kind === 'merge' && node.data?.mode === 'any') {
        if (anyActive) go = true;
        else if (allResolved) go = false;
      } else if (allResolved) {
        go = node.kind === 'merge' ? states.every((s) => s === 'active') : anyActive;
      }
      if (go === null) return;
      started.add(id);
      const nr = nodeRuns.get(id)!;
      if (!go || signal.aborted) {
        setStatus(nr, signal.aborted ? 'cancelled' : 'skipped');
        resolveOutgoing(id, false);
        return;
      }
      const inputs = incoming(id)
        .filter((e) => edgeState.get(e.id) === 'active')
        .map((e) => ({ from: byId.get(e.source)!, out: outputs.get(e.source) }));
      const p = this.runNode(wf, node, nr, inputs, outputs, run, signal, setStatus, helpers)
        .then((ok) => {
          if (nr.status === 'failed') anyFailed = true;
          resolveOutgoing(id, ok);
        })
        .finally(() => inFlight.delete(p));
      inFlight.add(p);
    };

    /** Sends review feedback back to an agent that already ran, in its own session, and records its new output. */
    const resumeAgent = async (agentId: string, feedback: string, round: number): Promise<boolean> => {
      const anode = byId.get(agentId)!;
      const anr = nodeRuns.get(agentId);
      if (!anr?.sessionId) return false;
      const prompt = `The reviewer rejected the result (round ${round}). Their feedback:\n\n${feedback || '(no comment given)'}\n\nRevise your work accordingly and reply with the complete updated result.`;
      const emit = this.emitter(wf.id, run.id, anr);
      emit({ t: 'info', text: `Revision requested (round ${round})`, at: Date.now() });
      const stores = this.memoryFor(wf, anode, run, emit);
      const base =
        anode.kind === 'orchestrator'
          ? this.orchestratorOptions(wf, anode, prompt, stores, run, emit, setStatus, helpers)
          : this.agentOptions(anode.data as AgentData, prompt, stores, run);
      const res = await this.agentTurn(wf, anode, anr, run, { ...base, resumeSessionId: anr.sessionId }, signal, setStatus, emit, stores);
      if (!res.ok) {
        anr.error = res.error;
        setStatus(anr, res.cancelled ? 'cancelled' : 'failed');
        return false;
      }
      const out: NodeOutput = { text: res.text, structured: res.structured };
      outputs.set(agentId, out);
      anr.output = out;
      setStatus(anr, 'success');
      return true;
    };

    /** Active inputs of a node right now (used when re-running part of the graph after a revision). */
    const currentInputs = (id: string) =>
      incoming(id)
        .filter((e) => {
          const src = byId.get(e.source)!;
          const out = outputs.get(e.source);
          if (!out || nodeRuns.get(e.source)?.status !== 'success') return false;
          return src.kind === 'condition' || src.kind === 'human' ? (e.sourceHandle ?? 'true') === String(!!out.pass) : true;
        })
        .map((e) => ({ from: byId.get(e.source)!, out: outputs.get(e.source) }));

    /**
     * A rejected review loops back: the target agent revises in its own session,
     * then every step between it and the review runs again with the new output.
     * Returns the review's fresh inputs, or null if the loop couldn't complete.
     */
    const loopBack = async (reviewId: string, feedback: string, round: number) => {
      const loop = wf.edges.find((e) => e.source === reviewId && isLoopEdge(e));
      const targetId = loop?.target ?? currentInputs(reviewId).find((i) => i.from.kind === 'agent' || i.from.kind === 'orchestrator')?.from.id;
      if (!targetId || !(await resumeAgent(targetId, feedback, round))) return null;

      // Nodes strictly between the target and the review: descendants of one and ancestors of the other.
      const walk = (start: string, next: (id: string) => string[]) => {
        const seen = new Set<string>();
        const todo = [start];
        while (todo.length) for (const n of next(todo.pop()!)) if (!seen.has(n)) (seen.add(n), todo.push(n));
        return seen;
      };
      const below = walk(targetId, (id) => outgoing(id).map((e) => e.target));
      const above = walk(reviewId, (id) => incoming(id).map((e) => e.source));
      const segment = [...below].filter((id) => above.has(id) && id !== reviewId);
      // Topological order within the segment.
      const ordered: string[] = [];
      const pending = new Set(segment);
      while (pending.size) {
        const ready = [...pending].filter((id) => !incoming(id).some((e) => pending.has(e.source)));
        if (!ready.length) break;
        for (const id of ready) (pending.delete(id), ordered.push(id));
      }
      for (const id of ordered) {
        if (signal.aborted) return null;
        const node = byId.get(id)!;
        const nr = nodeRuns.get(id)!;
        const inputs = currentInputs(id);
        if (!inputs.length) {
          outputs.delete(id);
          setStatus(nr, 'skipped');
          continue;
        }
        this.emitter(wf.id, run.id, nr)({ t: 'info', text: `Re-running after revision (round ${round})`, at: Date.now() });
        nr.error = undefined;
        if (!(await this.runNode(wf, node, nr, inputs, outputs, run, signal, setStatus, helpers))) return null;
      }
      return currentInputs(reviewId);
    };

    /** Worker agents aren't flow steps; their run record appears when an orchestrator first delegates to them. */
    const workerRun = (id: string) => {
      let nr = nodeRuns.get(id);
      if (!nr) {
        nr = { runId: run.id, nodeId: id, status: 'pending', events: [] };
        nodeRuns.set(id, nr);
      }
      return nr;
    };
    const helpers: RunHelpers = { loopBack, workerRun };

    resolveOutgoing(trigger.id, true);
    while (inFlight.size) await Promise.race(inFlight);

    for (const nr of nodeRuns.values()) {
      if (nr.status === 'pending') setStatus(nr, signal.aborted ? 'cancelled' : 'skipped');
      // A worker still marked running means its orchestrator ended mid-delegation.
      if (nr.status === 'running' || nr.status === 'queued') setStatus(nr, 'cancelled');
    }
    run.status = signal.aborted ? 'cancelled' : anyFailed ? 'failed' : 'success';
    if (run.status === 'failed' && !run.error) run.error = 'One or more steps failed';
  }

  private emitter(workflowId: string, runId: string, nr: NodeRun) {
    return (e: NodeEvent) => {
      nr.events.push(e);
      this.bus.emit({ type: 'node.event', workflowId, runId, nodeId: nr.nodeId, event: e });
    };
  }

  /** Memory nodes wired into this agent (edges from a memory node to it). */
  private memoryFor(wf: Workflow, node: WfNode, run: Run, onEvent: (e: NodeEvent) => void): Array<{ id: string; data: MemoryData }> {
    const stores = wf.edges
      .filter((e) => e.target === node.id)
      .map((e) => wf.nodes.find((n) => n.id === e.source))
      .filter((n): n is WfNode => n?.kind === 'memory')
      .map((n) => ({ id: storeIdFor(wf.id, n), data: n.data as MemoryData }));
    let done = this.indexedInRun.get(run.id);
    if (!done) this.indexedInRun.set(run.id, (done = new Set()));
    for (const s of stores) {
      if (!s.data.reindexBeforeRun || !s.data.sources?.length || done.has(s.id)) continue;
      done.add(s.id);
      const r = this.memory.index(s.id, s.data.sources);
      if (r.added || r.updated || r.removed) onEvent({ t: 'info', text: `Memory "${s.data.name}" re-indexed: +${r.added} new, ${r.updated} changed, ${r.removed} removed files`, at: Date.now() });
    }
    return stores;
  }

  /**
   * Orchestrator = an agent whose team members are Claude Code subagents
   * (`--agents`). It decides who to delegate to; each delegation lights up
   * that worker's node, streams its activity there, and records its result.
   */
  private orchestratorOptions(
    wf: Workflow,
    node: WfNode,
    prompt: string,
    ownStores: Array<{ id: string; data: MemoryData }>,
    run: Run,
    onEvent: (e: NodeEvent) => void,
    setStatus: (nr: NodeRun, s: NodeStatus) => void,
    h: RunHelpers,
  ): CliRunOptions {
    const d = node.data as OrchestratorData;
    const team = wf.edges
      .filter((e) => e.source === node.id && isTeamEdge(e))
      .map((e) => wf.nodes.find((n) => n.id === e.target))
      .filter((n): n is WfNode => n?.kind === 'agent')
      .map((n) => ({ node: n, key: workerKey(n.data.name), stores: this.memoryFor(wf, n, run, onEvent) }));

    // One MCP tool server serves the orchestrator and its workers, so it gets every store any of them uses.
    const allStores = [...ownStores, ...team.flatMap((w) => w.stores)].filter((s, i, a) => a.findIndex((x) => x.id === s.id) === i);
    const opts = this.agentOptions(d, prompt, allStores, run);
    // The orchestrator's own context should only describe its own memory.
    opts.appendSystemPrompt = [d.systemPrompt?.trim(), ownStores.length ? this.memory.contextFor(ownStores, prompt) : '', d.canAsk ? ASK_PROTOCOL : ''].filter(Boolean).join('\n\n');

    opts.agents = {};
    for (const w of team) {
      const wd = w.node.data as AgentData;
      const memTools = w.stores.length ? ['mcp__agent_canvas__memory_search', ...(w.stores.some((s) => s.data.allowWrite) ? ['mcp__agent_canvas__memory_save'] : [])] : [];
      opts.agents[w.key] = {
        description: wd.description?.trim() || wd.name,
        prompt:
          [wd.systemPrompt?.trim(), wd.prompt?.trim() && `## Your standing instructions\n${wd.prompt.trim()}`, w.stores.length ? this.memory.contextFor(w.stores, wd.prompt ?? '') : '']
            .filter(Boolean)
            .join('\n\n') || `You are ${wd.name}.`,
        tools: [...(wd.allowedTools ?? []), ...memTools],
        model: wd.model || undefined,
      };
    }
    // Permissions are per session, so workers' tools must be allowed too (headless runs deny anything else).
    opts.allowedTools = [...new Set([...(d.allowedTools ?? []), ...team.flatMap((w) => w.node.data.allowedTools ?? []), 'Agent'])];
    // Delegations must return their result to the orchestrator's turn, so no background subagents or
    // wake-up polling: several Agent calls in one message still run in parallel in the foreground.
    opts.env = { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' };
    opts.disallowedTools = [...(opts.disallowedTools ?? []), 'ScheduleWakeup', 'CronCreate', 'Monitor', 'SendMessage', 'TaskStop'];

    const roster = team.map((w) => `- ${w.key}: ${(w.node.data.description || w.node.data.name).trim()}`).join('\n');
    opts.appendSystemPrompt += `\n\n## Your team\nYou are an orchestrator. Work out what the task needs, then delegate to your team with the Agent tool, setting subagent_type to one of these members (use only these):\n${roster || '- (no team members connected)'}\n\nEach member starts fresh and does not see this conversation, so give every delegation a complete, self-contained brief, including any results from other members it needs. ${
      d.parallel
        ? 'When sub-tasks are independent, make several Agent calls in the same message; they run in parallel and all results come back to you.'
        : 'Delegate one sub-task at a time.'
    } You may use a member more than once or not at all. Check the results, delegate again to fill gaps, then reply with the final, combined result.`;

    // Map delegations (Agent tool calls) to worker nodes.
    const byKey = new Map(team.map((w) => [w.key, w.node]));
    const delegations = new Map<string, string>();
    const active = new Map<string, number>();
    opts.onMessage = (msg) => {
      const parent: string | undefined = msg.parent_tool_use_id ?? undefined;
      const blocks: any[] = Array.isArray(msg.message?.content) ? msg.message.content : [];
      if (!parent && msg.type === 'assistant') {
        for (const b of blocks) {
          if (b.type !== 'tool_use' || b.name !== 'Agent') continue;
          const worker = byKey.get(workerKey(String(b.input?.subagent_type ?? '')));
          if (!worker) continue;
          delegations.set(b.id, worker.id);
          active.set(worker.id, (active.get(worker.id) ?? 0) + 1);
          const wnr = h.workerRun(worker.id);
          wnr.prompt = [wnr.prompt, String(b.input?.prompt ?? '')].filter(Boolean).join('\n\n---\n\n');
          wnr.error = undefined;
          this.emitter(wf.id, run.id, wnr)({ t: 'info', text: `Task from ${d.name}: ${b.input?.description ?? ''}`, at: Date.now() });
          setStatus(wnr, 'running');
        }
      } else if (parent && delegations.has(parent)) {
        const wnr = h.workerRun(delegations.get(parent)!);
        const emit = this.emitter(wf.id, run.id, wnr);
        for (const ev of eventsFromMessage(msg)) emit(ev);
      } else if (!parent && msg.type === 'user') {
        for (const b of blocks) {
          if (b.type !== 'tool_result' || !delegations.has(b.tool_use_id)) continue;
          const workerId = delegations.get(b.tool_use_id)!;
          const wnr = h.workerRun(workerId);
          const left = (active.get(workerId) ?? 1) - 1;
          active.set(workerId, left);
          const text = handBackText(toolResultText(b));
          if (b.is_error) {
            wnr.error = text;
            if (!left) setStatus(wnr, 'failed');
          } else {
            wnr.output = { text };
            if (!left) setStatus(wnr, 'success');
            else this.bus.emit({ type: 'node', workflowId: wf.id, node: (({ events, ...rest }) => rest)(wnr) });
          }
        }
      }
    };
    return opts;
  }

  private agentOptions(d: AgentData, prompt: string, stores: Array<{ id: string; data: MemoryData }> = [], run?: Run): CliRunOptions {
    const memoryContext = stores.length ? this.memory.contextFor(stores, prompt) : '';
    return {
      prompt,
      cwd: expandHome(d.cwd.trim()),
      model: d.model,
      effort: d.effort,
      memory: stores.length ? { search: stores.map((s) => s.id), write: stores.find((s) => s.data.allowWrite)?.id, runId: run?.id } : undefined,
      appendSystemPrompt: [d.systemPrompt?.trim(), memoryContext, d.canAsk ? ASK_PROTOCOL : ''].filter(Boolean).join('\n\n'),
      allowedTools: d.allowedTools,
      disallowedTools: d.disallowedTools,
      permissionMode: d.permissionMode,
      jsonSchema: d.outputSchema,
      askTool: !!d.canAsk,
    };
  }

  /** One `claude -p` call through the shared queue, with a single retry on rate limits. */
  private async callClaude(nr: NodeRun, run: Run, opts: CliRunOptions, signal: AbortSignal, setStatus: (nr: NodeRun, s: NodeStatus) => void, onEvent: (e: NodeEvent) => void) {
    if (!existsSync(opts.cwd)) throw new Error(`Working directory does not exist: ${opts.cwd}`);
    const exec = () =>
      this.queue.run(
        () => {
          setStatus(nr, 'running');
          return this.cli.run({ ...opts, signal, onEvent });
        },
        () => setStatus(nr, 'queued'),
      );
    let res: CliResult = await exec();
    if (!res.ok && res.rateLimited && !signal.aborted) {
      const wait = loadSettings().rateLimitRetryMs;
      onEvent({ t: 'info', text: `Rate limited — retrying once in ${Math.round(wait / 1000)}s`, at: Date.now() });
      await new Promise((r) => setTimeout(r, wait));
      if (!signal.aborted) res = await exec();
    }
    nr.sessionId = res.sessionId;
    nr.costUsd = (nr.costUsd ?? 0) + res.costUsd;
    run.costUsd += res.costUsd;
    return res;
  }

  /**
   * An agent turn. If the agent may ask questions and replies with one, the run
   * waits for the person's answer and then resumes the same session.
   */
  private async agentTurn(
    wf: Workflow,
    node: WfNode,
    nr: NodeRun,
    run: Run,
    opts: CliRunOptions,
    signal: AbortSignal,
    setStatus: (nr: NodeRun, s: NodeStatus) => void,
    onEvent: (e: NodeEvent) => void,
    stores: Array<{ id: string; data: MemoryData }> = [],
  ): Promise<CliResult> {
    const d = node.data as AgentData;
    let res = await this.callClaude(nr, run, opts, signal, setStatus, onEvent);
    const max = Math.max(1, Number(d.maxQuestions) || 3);
    let asked = 0;
    let question: string | null;
    while (res.ok && d.canAsk && (question = res.question ?? extractQuestion(res.text))) {
      if (asked >= max) {
        onEvent({ t: 'info', text: `Question limit (${max}) reached; continuing with the agent's last reply.`, at: Date.now() });
        break;
      }
      asked++;
      setStatus(nr, 'waiting');
      const answer = await this.inbox.ask(
        { runId: run.id, workflowId: wf.id, workflowName: wf.name, nodeId: node.id, nodeName: d.name, kind: 'question', title: question.split('\n')[0].slice(0, 120), body: question, round: asked },
        { signal, notify: d.askNotify, onNotify: (text, ok) => onEvent({ t: ok ? 'info' : 'error', text, at: Date.now() }) },
      );
      onEvent({ t: 'info', text: `You answered: ${answer.text}`, at: Date.now() });
      // Remember the answer so future runs find it in memory instead of asking again.
      for (const s of stores.filter((x) => x.data.rememberAnswers)) {
        this.memory.saveNote(s.id, question.slice(0, 300), answer.text ?? '', 'answer', run.id);
        onEvent({ t: 'info', text: `Saved your answer to memory "${s.data.name}"`, at: Date.now() });
      }
      res = await this.callClaude(
        nr,
        run,
        { ...opts, prompt: `The user answered your question:\n\n${answer.text}\n\nContinue the task.`, resumeSessionId: res.sessionId },
        signal,
        setStatus,
        onEvent,
      );
    }
    return res;
  }

  /** Runs a single node; resolves to whether it succeeded. */
  private async runNode(
    wf: Workflow,
    node: WfNode,
    nr: NodeRun,
    inputs: Array<{ from: WfNode; out?: NodeOutput }>,
    outputs: Map<string, NodeOutput>,
    run: Run,
    signal: AbortSignal,
    setStatus: (nr: NodeRun, s: NodeStatus) => void,
    h: RunHelpers,
  ): Promise<boolean> {
    const input = joinInputs(inputs);
    const nodesCtx: Record<string, unknown> = {};
    for (const [id, out] of outputs) {
      const n = wf.nodes.find((x) => x.id === id);
      const entry = { output: valueOf(out), text: textOf(out) };
      nodesCtx[id] = entry;
      if (n?.data?.name) nodesCtx[n.data.name] = entry;
    }
    const ctx = {
      input,
      inputs: inputs.map((i) => valueOf(i.out)),
      trigger: { kind: run.triggerKind, payload: run.triggerPayload },
      nodes: nodesCtx,
      date: new Date().toISOString(),
      // File-name friendly date parts.
      today: new Date().toISOString().slice(0, 10),
      time: new Date().toTimeString().slice(0, 5).replace(':', '-'),
      workflow: { id: wf.id, name: wf.name },
      runId: run.id,
    };
    const onEvent = this.emitter(wf.id, run.id, nr);
    // Files produced upstream (by Output nodes / Save actions) keep flowing down the graph.
    const upstreamFiles = inputs.flatMap((i) => i.out?.files ?? []).filter((f, i, a) => a.findIndex((x) => x.id === f.id) === i);
    const upstreamStructured = inputs.length === 1 ? inputs[0].out?.structured : undefined;

    try {
      if (node.kind === 'merge') {
        outputs.set(node.id, { text: input, structured: inputs.length > 1 ? ctx.inputs : undefined });
        nr.output = outputs.get(node.id);
        setStatus(nr, 'success');
        return true;
      }

      if (node.kind === 'output') {
        setStatus(nr, 'running');
        const d = node.data as OutputData;
        const settings = loadSettings();
        const folder = d.folder?.trim() ? expandHome(renderTemplate(d.folder, ctx).trim()) : join(settings.outputsDir, safeName(wf.name));
        mkdirSync(folder, { recursive: true });
        const path = freePath(folder, `${safeName(renderTemplate(d.fileName || '{{workflow.name}}-{{today}}', ctx))}.${EXT[d.format]}`);
        if (d.mode === 'claude') {
          const prompt = `Create a ${FORMAT_NAMES[d.format]} file at exactly this path:
${path}

Make it well designed, clear and professional, using the best tools you have (your document skills if available, or python/node libraries). Preserve the content and its language; right-to-left languages must read correctly.${d.title ? `
Title: ${renderTemplate(d.title, ctx)}` : ''}${d.instructions?.trim() ? `

Design notes: ${renderTemplate(d.instructions, ctx)}` : ''}

When the file is written, reply with one line: the path.

## Content
${input || '(empty)'}`;
          nr.prompt = prompt;
          const res = await this.callClaude(
            nr,
            run,
            { prompt, cwd: folder, model: d.model || 'sonnet', allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Skill'], permissionMode: 'dontAsk' },
            signal,
            setStatus,
            onEvent,
          );
          if (!res.ok) throw new Error(res.error || 'Claude could not create the file');
          if (!existsSync(path)) throw new Error(`Claude finished but no file was written at ${path}`);
        } else {
          await convert(d.format, { text: input, structured: upstreamStructured, title: d.title ? renderTemplate(d.title, ctx) : undefined }, path, { chromePath: settings.chromePath });
        }
        const file = this.store.addFile({ path, name: basename(path), format: d.format, bytes: statSync(path).size, runId: run.id, workflowId: wf.id, nodeId: node.id });
        onEvent({ t: 'info', text: `Created ${file.name} (${Math.max(1, Math.round(file.bytes / 1024))} KB) in ${folder}`, at: Date.now() });
        const out: NodeOutput = { text: input, structured: upstreamStructured, files: [...upstreamFiles, file] };
        outputs.set(node.id, out);
        nr.output = out;
        setStatus(nr, 'success');
        return true;
      }

      if (node.kind === 'action') {
        setStatus(nr, 'running');
        const r = await this.actions.run(node.data as ActionData, {
          text: input,
          structured: upstreamStructured,
          files: upstreamFiles,
          ctx: { ...ctx, files: upstreamFiles.map((f) => f.name).join(', ') },
          onEvent,
        });
        const saved: OutputFile[] = (r.files ?? []).map((f) => this.store.addFile({ ...f, runId: run.id, workflowId: wf.id, nodeId: node.id }));
        onEvent({ t: 'info', text: r.summary, at: Date.now() });
        // A saved copy stands in for the same file, so only genuinely new files (e.g. the text saved as .md) are added.
        const names = new Set(upstreamFiles.map((f) => f.name));
        const out: NodeOutput = { text: input, structured: upstreamStructured, files: [...upstreamFiles, ...saved.filter((f) => !names.has(f.name))], reason: r.summary };
        outputs.set(node.id, out);
        nr.output = out;
        setStatus(nr, 'success');
        return true;
      }

      if (node.kind === 'human') {
        return await this.runReview(wf, node, nr, inputs, input, outputs, run, signal, setStatus, onEvent, h.loopBack);
      }

      if (node.kind === 'condition' && node.data?.mode !== 'llm') {
        setStatus(nr, 'running');
        const upstream = inputs.length === 1 ? valueOf(inputs[0].out) : ctx.inputs;
        const pass = !!runInNewContext(`(${node.data.expression})`, { output: upstream, input, trigger: ctx.trigger, nodes: nodesCtx, JSON, Math, Number, String, Date }, { timeout: 1000 });
        onEvent({ t: 'info', text: `${node.data.expression} → ${pass}`, at: Date.now() });
        outputs.set(node.id, { text: input, structured: inputs.length === 1 ? inputs[0].out?.structured : undefined, pass });
        nr.output = outputs.get(node.id);
        setStatus(nr, 'success');
        return true;
      }

      // Agent node, or an LLM-judged condition: both are `claude -p` runs.
      let res: CliResult;
      if (node.kind === 'condition') {
        const prompt = `Answer this yes/no question about the input below.\n\nQuestion: ${renderTemplate(node.data.question, ctx)}\n\n## Input\n${input || '(empty)'}`;
        nr.prompt = prompt;
        const opts: CliRunOptions = {
          prompt,
          cwd: node.data.cwd?.trim() ? expandHome(node.data.cwd.trim()) : DATA_DIR,
          model: node.data.model || 'haiku',
          tools: [],
          jsonSchema: JUDGE_SCHEMA,
          permissionMode: 'dontAsk',
        };
        res = await this.callClaude(nr, run, opts, signal, setStatus, onEvent);
      } else {
        const d = node.data as AgentData;
        let prompt = renderTemplate(d.prompt, ctx);
        // Pipelines "just work": if the prompt doesn't place {{input}} itself, append it.
        // (A step fed only by the trigger that already uses {{trigger...}} doesn't need it twice.)
        const placesInput = /\{\{\s*input\s*\}\}/.test(d.prompt);
        const onlyTrigger = inputs.every((i) => i.from.kind.startsWith('trigger.'));
        const placesTrigger = /\{\{\s*trigger[.\s}]/.test(d.prompt);
        if (input.trim() && !placesInput && !(onlyTrigger && placesTrigger)) {
          prompt += `\n\n## Input from ${onlyTrigger ? 'the trigger' : 'the previous step'}\n${input}`;
        }
        nr.prompt = prompt;
        const stores = this.memoryFor(wf, node, run, onEvent);
        if (node.kind === 'orchestrator') {
          const opts = this.orchestratorOptions(wf, node, prompt, stores, run, onEvent, setStatus, h);
          res = await this.agentTurn(wf, node, nr, run, opts, signal, setStatus, onEvent, stores);
        } else {
          res = await this.agentTurn(wf, node, nr, run, this.agentOptions(d, prompt, stores, run), signal, setStatus, onEvent, stores);
        }
      }

      if (!res.ok) {
        nr.error = res.error;
        setStatus(nr, res.cancelled ? 'cancelled' : 'failed');
        return false;
      }
      const out: NodeOutput = { text: res.text, structured: res.structured };
      if (node.kind === 'condition') {
        const s = res.structured as { pass?: boolean; reason?: string } | undefined;
        out.pass = !!s?.pass;
        out.reason = s?.reason;
        out.text = input; // conditions pass their input through unchanged
        out.structured = inputs.length === 1 ? inputs[0].out?.structured : undefined;
        onEvent({ t: 'info', text: `Judge: ${out.pass ? 'yes' : 'no'} — ${s?.reason ?? ''}`, at: Date.now() });
      }
      outputs.set(node.id, out);
      nr.output = out;
      setStatus(nr, 'success');
      return true;
    } catch (err: any) {
      if (err instanceof RequestClosedError || signal.aborted) {
        setStatus(nr, 'cancelled');
        return false;
      }
      nr.error = String(err?.message ?? err);
      onEvent({ t: 'error', text: nr.error, at: Date.now() });
      setStatus(nr, 'failed');
      return false;
    }
  }

  /**
   * Human review: waits for approve/reject. In revise mode (a "↩ revise" loop
   * edge, or onReject = 'revise'), a rejection loops back to an earlier agent,
   * re-runs the steps in between, and asks again, up to maxRounds.
   */
  private async runReview(
    wf: Workflow,
    node: WfNode,
    nr: NodeRun,
    inputs: Array<{ from: WfNode; out?: NodeOutput }>,
    input: string,
    outputs: Map<string, NodeOutput>,
    run: Run,
    signal: AbortSignal,
    setStatus: (nr: NodeRun, s: NodeStatus) => void,
    onEvent: (e: NodeEvent) => void,
    loopBack: LoopBack,
  ): Promise<boolean> {
    const d = node.data as HumanData;
    const title = d.title?.trim() || node.label || 'Review';
    const loopTarget = wf.nodes.find((n) => n.id === wf.edges.find((e) => e.source === node.id && isLoopEdge(e))?.target);
    const reviseAgent = loopTarget ?? (d.onReject === 'revise' ? inputs.find((i) => i.from.kind === 'agent' || i.from.kind === 'orchestrator')?.from : undefined);
    const reviseMode = !!reviseAgent;
    const maxRounds = reviseMode ? Math.max(1, Number(d.maxRounds) || 3) : 1;
    let content = input;
    let structured = inputs.length === 1 ? inputs[0].out?.structured : undefined;

    for (let round = 1; ; round++) {
      setStatus(nr, 'waiting');
      const resp = await this.inbox.ask(
        {
          runId: run.id,
          workflowId: wf.id,
          workflowName: wf.name,
          nodeId: node.id,
          nodeName: title,
          kind: 'review',
          title,
          instructions: d.instructions,
          body: content || '(the previous step produced no output)',
          round,
          // Tells the UI what "reject" will do this round.
          reviseTo: reviseMode && round < maxRounds ? reviseAgent!.data?.name || reviseAgent!.id : undefined,
          maxRounds: reviseMode ? maxRounds : undefined,
        },
        { signal, timeoutMinutes: d.timeoutMinutes, notify: d.notify, onNotify: (text, ok) => onEvent({ t: ok ? 'info' : 'error', text, at: Date.now() }) },
      );
      const approved = resp.decision === 'approve';
      const comment = resp.text?.trim() ?? '';
      onEvent({ t: 'info', text: `Round ${round}: ${resp.timedOut ? 'timed out' : approved ? 'approved' : 'rejected'}${comment ? ` — ${comment}` : ''}`, at: Date.now() });

      if (!approved && !resp.timedOut && reviseMode && round < maxRounds) {
        setStatus(nr, 'running');
        const fresh = await loopBack(node.id, comment, round);
        if (signal.aborted) throw new RequestClosedError('Run cancelled');
        if (fresh?.length) {
          content = joinInputs(fresh);
          structured = fresh.length === 1 ? fresh[0].out?.structured : undefined;
          continue;
        }
        onEvent({ t: 'error', text: 'The revision failed; treating this as rejected.', at: Date.now() });
      } else if (!approved && reviseMode && round >= maxRounds && !resp.timedOut) {
        onEvent({ t: 'info', text: `Still rejected after ${maxRounds} round(s); taking the "no" path.`, at: Date.now() });
      }

      const note = comment ? `\n\n## Reviewer ${approved ? 'note' : 'feedback'}\n${comment}` : '';
      const out: NodeOutput = { text: `${content}${note}`, structured: note ? undefined : structured, pass: approved, reason: comment || undefined };
      outputs.set(node.id, out);
      nr.output = out;
      setStatus(nr, 'success');
      return true;
    }
  }
}
