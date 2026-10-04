import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { AgentDefinition, HookCallbackMatcher, HookEvent, McpServerConfig, Options, SDKMessage, SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { childPath } from '../../common/paths';
import { NodeEvent, UsageInfo } from '../../common/types';
import { AppToolScope, appToolDefs, appToolNames, mcpToolName, workerServerName } from '../app-tools';
import type { ToolResult } from '../app-tools.service';
import { AgentResult, AgentRunOptions, appScope, ASK_TOOL, clip, importEsm, MCP_SERVER_NAME, RATE_LIMIT_RE, toolResultText } from '../agent-runner.service';

const logger = new Logger('ClaudeAgent');

type ClaudeSdk = typeof import('@anthropic-ai/claude-agent-sdk');
let sdk: Promise<ClaudeSdk> | null = null;
const loadSdk = () => (sdk ??= importEsm<ClaudeSdk>('@anthropic-ai/claude-agent-sdk'));

export type CallTool = (name: string, args: Record<string, any> | undefined, scope: AppToolScope) => Promise<ToolResult>;

export interface ClaudeDeps {
  onUsage: (u: UsageInfo) => void;
  callTool: CallTool;
}

/** An in-process MCP server serving one scope's app tools (exact JSON Schemas, no extra process). */
export function toolServer(name: string, scope: AppToolScope, callTool: CallTool): McpServerConfig {
  const mcp = new McpServer({ name, version: '0.3.0' }, { capabilities: { tools: {} } });
  // Loaded up front: these are few, and deferring them costs the agent a ToolSearch round-trip first.
  const tools = appToolDefs(scope).map((t) => ({ ...t, _meta: { 'anthropic/alwaysLoad': true } }));
  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools as any }));
  mcp.server.setRequestHandler(CallToolRequestSchema, async (req) => (await callTool(req.params.name, req.params.arguments, scope)) as any);
  return { type: 'sdk', name, instance: mcp };
}

const hook = (fn: (input: any) => Record<string, unknown> | void, matcher?: string): HookCallbackMatcher => ({
  matcher,
  hooks: [async (input) => fn(input) ?? {}],
});

export function buildOptions(o: AgentRunOptions, sessionId: string, abortController: AbortController, onStderr: (s: string) => void, callTool: CallTool): Options {
  const mcpServers: Record<string, McpServerConfig> = {};
  const own = appScope(o);
  const ownTools = appToolNames(own).map((t) => mcpToolName(MCP_SERVER_NAME, t));
  if (ownTools.length) mcpServers[MCP_SERVER_NAME] = toolServer(MCP_SERVER_NAME, own, callTool);

  // Each team member gets its own tool server, so it only sees its own memory, datasets and plugin tools.
  let agents: Record<string, AgentDefinition> | undefined;
  const memberTools: string[] = [];
  if (o.agents && Object.keys(o.agents).length) {
    agents = {};
    for (const [key, w] of Object.entries(o.agents)) {
      const server = workerServerName(key);
      const names = w.appTools ? appToolNames(w.appTools).map((t) => mcpToolName(server, t)) : [];
      if (names.length) mcpServers[server] = toolServer(server, w.appTools!, callTool);
      memberTools.push(...names);
      agents[key] = {
        description: w.description,
        prompt: w.prompt,
        tools: [...(w.tools ?? []), ...names],
        model: w.model,
        maxTurns: w.maxTurns,
        ...(names.length ? { mcpServers: [server] } : {}),
      };
    }
  }

  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
  // Asking ends the turn here, whatever the model would have written next; the answer resumes the session.
  if (o.askTool) hooks.PostToolUse = [hook(() => ({ continue: false, stopReason: 'Waiting for the user to answer' }), ASK_TOOL)];
  if (o.team) {
    const team = o.team;
    hooks.SubagentStart = [hook((i) => team.onStart(i.agent_type, i.agent_id))];
    hooks.SubagentStop = [hook((i) => team.onStop(i.agent_type, i.agent_id, i.last_assistant_message))];
    hooks.PreToolUse = [
      hook((i) => {
        if (i.agent_id || !team.mainThreadDeny) return;
        const reason = team.mainThreadDeny(i.tool_name);
        if (reason) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
      }),
    ];
  }

  const allowed = [...(o.allowedTools ?? []), ...ownTools, ...memberTools];
  const append = o.appendSystemPrompt?.trim();
  return {
    cwd: o.cwd,
    abortController,
    ...(o.resumeSessionId ? { resume: o.resumeSessionId } : { sessionId }),
    // Runs see only what the app gives them: not the user's own hooks, plugins, MCP servers or CLAUDE.md.
    settingSources: o.settingSources ?? [],
    strictMcpConfig: !o.userMcpServers,
    ...(o.persistSession === false ? { persistSession: false } : {}),
    // Headless: anything that would prompt is denied instead of hanging.
    permissionPrompts: 'none',
    permissionMode: o.permissionMode || 'dontAsk',
    allowDangerouslySkipPermissions: o.permissionMode === 'bypassPermissions',
    model: o.model || undefined,
    effort: (o.effort || undefined) as Options['effort'],
    maxTurns: o.maxTurns || undefined,
    maxBudgetUsd: o.maxBudgetUsd || undefined,
    // Claude Code's own system prompt plus the agent's persona; one-off calls without tools use a short prompt of their own.
    systemPrompt: o.systemPrompt ? [o.systemPrompt, append].filter(Boolean).join('\n\n') : { type: 'preset', preset: 'claude_code', ...(append ? { append } : {}) },
    tools: o.tools,
    allowedTools: allowed.length ? allowed : undefined,
    // Nobody can answer Claude Code's own question prompt in headless mode; agents ask through the app instead.
    disallowedTools: [...(o.disallowedTools ?? []), 'AskUserQuestion'],
    mcpServers: Object.keys(mcpServers).length ? mcpServers : undefined,
    hooks: Object.keys(hooks).length ? hooks : undefined,
    outputFormat: o.jsonSchema?.trim() ? { type: 'json_schema', schema: JSON.parse(o.jsonSchema) } : undefined,
    ...(agents ? { agents, forwardSubagentText: true } : {}),
    env: { ...process.env, PATH: childPath(), ...o.env },
    stderr: onStderr,
  };
}

/** resetsAt may come in seconds or milliseconds. */
const toMs = (t?: number) => (!t ? undefined : t < 1e12 ? t * 1000 : t);

/** Plain-language error for a result that didn't succeed. */
export function resultError(result: any, o: Pick<AgentRunOptions, 'maxTurns' | 'maxBudgetUsd'>, text: string): string {
  switch (result.subtype) {
    case 'error_max_turns':
      return `Stopped after ${result.num_turns ?? o.maxTurns} turns, the limit for this step (Max turns). Raise it in the step's settings if the task needs more.`;
    case 'error_max_budget_usd':
      return `Stopped at the spending limit for this step ($${o.maxBudgetUsd}, Max spend). Raise it in the step's settings if the task needs more.`;
    case 'error_max_structured_output_retries':
      return 'The agent could not produce output matching the JSON Schema.';
    default:
      return clip(text || result.errors?.join('\n') || result.subtype || 'Run failed', 1500);
  }
}

/**
 * One turn on the Claude Agent SDK. Auth is whatever Claude Code is logged in
 * with (the user's subscription or an API key from the environment).
 */
export async function runClaude(o: AgentRunOptions, deps: ClaudeDeps): Promise<AgentResult> {
  const sessionId = o.resumeSessionId ?? randomUUID();
  const emit = (e: Omit<NodeEvent, 'at'>) => o.onEvent?.({ ...e, at: Date.now() });
  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  o.signal?.addEventListener('abort', onAbort, { once: true });

  let result: any = null;
  let lastText = '';
  let question: string | undefined;
  let stderr = '';
  let limit: SDKRateLimitInfo | undefined;
  const limitResult = (error: string) => {
    const rejected = limit?.status === 'rejected';
    return { rateLimited: rejected || RATE_LIMIT_RE.test(error), retryAt: rejected ? toMs(limit?.resetsAt) : undefined };
  };

  try {
    const { query } = await loadSdk();
    let options: Options;
    try {
      options = buildOptions(o, sessionId, abortController, (d) => (stderr = (stderr + d).slice(-4000)), deps.callTool);
    } catch (err: any) {
      const error = `Invalid output schema: ${err.message}`;
      emit({ t: 'error', text: error });
      return { ok: false, text: '', sessionId, costUsd: 0, error, rateLimited: false, cancelled: false };
    }

    for await (const msg of query({ prompt: o.prompt, options }) as AsyncIterable<SDKMessage & Record<string, any>>) {
      o.onMessage?.(msg);
      // Usage limits apply to the whole session, members included.
      if (msg.type === 'rate_limit_event') {
        const info: any = (limit = msg.rate_limit_info) ?? {};
        const w = info.unifiedWindows ?? {};
        deps.onUsage({ status: info.status, fiveHour: w.five_hour, sevenDay: w.seven_day, updatedAt: Date.now() });
        continue;
      }
      // Subagent messages belong to the worker, not to this node's own activity.
      if (msg.parent_tool_use_id) continue;
      switch (msg.type) {
        case 'system':
          if (msg.subtype === 'init') emit({ t: 'info', text: `Session started · ${msg.model ?? ''} · ${msg.cwd}` });
          break;
        case 'assistant':
          for (const block of msg.message?.content ?? []) {
            if (block.type === 'text' && block.text) {
              lastText = block.text;
              emit({ t: 'text', text: block.text });
            } else if (block.type === 'tool_use') {
              const input = block.input as any;
              if (block.name === ASK_TOOL && typeof input?.question === 'string') question = input.question;
              emit({ t: 'tool', name: block.name === ASK_TOOL ? 'ask_user' : block.name, input });
            }
          }
          break;
        case 'user':
          for (const block of Array.isArray(msg.message?.content) ? msg.message.content : []) {
            if (block.type !== 'tool_result') continue;
            emit({ t: 'tool_result', text: clip(toolResultText(block), 1500) });
          }
          break;
        case 'result':
          result = msg;
          break;
      }
    }
  } catch (err: any) {
    // The SDK throws after yielding an error result (e.g. max turns); that result explains it better.
    if (!abortController.signal.aborted && !result) {
      const error = clip(stderr.trim() || err?.message || String(err), 1500);
      logger.warn(error);
      emit({ t: 'error', text: error });
      return { ok: false, text: lastText, sessionId, costUsd: result?.total_cost_usd ?? 0, error, cancelled: false, ...limitResult(error) };
    }
  } finally {
    o.signal?.removeEventListener('abort', onAbort);
  }

  if (abortController.signal.aborted) {
    return { ok: false, text: lastText, sessionId, costUsd: result?.total_cost_usd ?? 0, error: 'Cancelled', rateLimited: false, cancelled: true };
  }
  if (!result) {
    const error = clip(stderr.trim() || 'Claude finished without a result', 1500);
    emit({ t: 'error', text: error });
    return { ok: false, text: lastText, sessionId, costUsd: 0, error, cancelled: false, ...limitResult(error) };
  }
  const text: string = typeof result.result === 'string' && result.result ? result.result : lastText;
  // A turn the ask hook ended is a finished turn: the question is its outcome.
  const ok = (!result.is_error && result.subtype === 'success') || (!!question && result.subtype !== 'error_max_budget_usd');
  const error = ok ? undefined : resultError(result, o, text);
  const rate = ok ? { rateLimited: false } : result.api_error_status === 429 ? { rateLimited: true, retryAt: limit?.status === 'rejected' ? toMs(limit.resetsAt) : undefined } : limitResult(error!);
  if (error) emit({ t: 'error', text: error });
  return {
    ok,
    text,
    structured: result.structured_output,
    sessionId: result.session_id ?? sessionId,
    costUsd: result.total_cost_usd ?? 0,
    error,
    cancelled: false,
    question,
    ...rate,
  };
}
