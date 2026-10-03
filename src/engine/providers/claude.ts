import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { childPath } from '../../common/paths';
import { NodeEvent, UsageInfo } from '../../common/types';
import { AgentResult, AgentRunOptions, appToolNames, appToolsServer, ASK_TOOL, clip, importEsm, MCP_SERVER_NAME, RATE_LIMIT_RE, toolResultText } from '../agent-runner.service';

const logger = new Logger('ClaudeAgent');

type ClaudeSdk = typeof import('@anthropic-ai/claude-agent-sdk');
let sdk: Promise<ClaudeSdk> | null = null;
const loadSdk = () => (sdk ??= importEsm<ClaudeSdk>('@anthropic-ai/claude-agent-sdk'));

function buildOptions(o: AgentRunOptions, sessionId: string, abortController: AbortController, onStderr: (s: string) => void): Options {
  const server = appToolsServer(o);
  const allowed = [...(o.allowedTools ?? []), ...appToolNames(o).map((t) => `mcp__${MCP_SERVER_NAME}__${t}`)];
  return {
    cwd: o.cwd,
    abortController,
    ...(o.resumeSessionId ? { resume: o.resumeSessionId } : { sessionId }),
    // Headless: anything that would prompt is denied instead of hanging.
    permissionPrompts: 'none',
    permissionMode: o.permissionMode || 'dontAsk',
    allowDangerouslySkipPermissions: o.permissionMode === 'bypassPermissions',
    model: o.model || undefined,
    effort: (o.effort || undefined) as Options['effort'],
    // Same system prompt as Claude Code, plus the agent's persona.
    systemPrompt: { type: 'preset', preset: 'claude_code', ...(o.appendSystemPrompt?.trim() ? { append: o.appendSystemPrompt } : {}) },
    tools: o.tools,
    allowedTools: allowed.length ? allowed : undefined,
    // Nobody can answer Claude Code's own question prompt in headless mode; agents ask through the app instead.
    disallowedTools: [...(o.disallowedTools ?? []), 'AskUserQuestion'],
    mcpServers: server ? { [MCP_SERVER_NAME]: { type: 'stdio', ...server } } : undefined,
    outputFormat: o.jsonSchema?.trim() ? { type: 'json_schema', schema: JSON.parse(o.jsonSchema) } : undefined,
    ...(o.agents && Object.keys(o.agents).length ? { agents: o.agents, forwardSubagentText: true } : {}),
    env: { ...process.env, PATH: childPath(), ...o.env },
    stderr: onStderr,
  };
}

/**
 * One turn on the Claude Agent SDK. Auth is whatever Claude Code is logged in
 * with (the user's subscription or an API key from the environment).
 */
export async function runClaude(o: AgentRunOptions, onUsage: (u: UsageInfo) => void): Promise<AgentResult> {
  const sessionId = o.resumeSessionId ?? randomUUID();
  const emit = (e: Omit<NodeEvent, 'at'>) => o.onEvent?.({ ...e, at: Date.now() });
  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  o.signal?.addEventListener('abort', onAbort, { once: true });

  let result: any = null;
  let lastText = '';
  let question: string | undefined;
  let stderr = '';

  try {
    const { query } = await loadSdk();
    let options: Options;
    try {
      options = buildOptions(o, sessionId, abortController, (d) => (stderr = (stderr + d).slice(-4000)));
    } catch (err: any) {
      const error = `Invalid output schema: ${err.message}`;
      emit({ t: 'error', text: error });
      return { ok: false, text: '', sessionId, costUsd: 0, error, rateLimited: false, cancelled: false };
    }

    for await (const msg of query({ prompt: o.prompt, options }) as AsyncIterable<SDKMessage & Record<string, any>>) {
      o.onMessage?.(msg);
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
        case 'rate_limit_event': {
          const info: any = msg.rate_limit_info ?? {};
          const w = info.unifiedWindows ?? {};
          onUsage({ status: info.status, fiveHour: w.five_hour, sevenDay: w.seven_day, updatedAt: Date.now() });
          break;
        }
        case 'result':
          result = msg;
          break;
      }
    }
  } catch (err: any) {
    if (!abortController.signal.aborted) {
      const error = clip(stderr.trim() || err?.message || String(err), 1500);
      logger.warn(error);
      emit({ t: 'error', text: error });
      return { ok: false, text: lastText, sessionId, costUsd: result?.total_cost_usd ?? 0, error, rateLimited: RATE_LIMIT_RE.test(error), cancelled: false };
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
    return { ok: false, text: lastText, sessionId, costUsd: 0, error, rateLimited: RATE_LIMIT_RE.test(stderr), cancelled: false };
  }
  const text: string = typeof result.result === 'string' ? result.result : lastText;
  const ok = !result.is_error && result.subtype === 'success';
  const error = ok ? undefined : clip(text || result.errors?.join('\n') || result.subtype || 'Run failed', 1500);
  const rateLimited = !ok && (result.api_error_status === 429 || RATE_LIMIT_RE.test(text));
  if (error) emit({ t: 'error', text: error });
  return {
    ok,
    text,
    structured: result.structured_output,
    sessionId: result.session_id ?? sessionId,
    costUsd: result.total_cost_usd ?? 0,
    error,
    rateLimited,
    cancelled: false,
    question,
  };
}
