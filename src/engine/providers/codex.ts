import { Logger } from '@nestjs/common';
import type { CodexOptions, ModelReasoningEffort, SandboxMode, ThreadItem, ThreadOptions } from '@openai/codex-sdk';
import { childPath } from '../../common/paths';
import { NodeEvent } from '../../common/types';
import { AgentResult, AgentRunOptions, appToolsServer, clip, importEsm, MCP_SERVER_NAME, RATE_LIMIT_RE } from '../agent-runner.service';

const logger = new Logger('CodexAgent');

type CodexSdk = typeof import('@openai/codex-sdk');
let sdk: Promise<CodexSdk> | null = null;
const loadSdk = () => (sdk ??= importEsm<CodexSdk>('@openai/codex-sdk'));

/** Claude model aliases mean nothing to Codex; fall back to Codex's own default model. */
const CLAUDE_MODEL = /^(haiku|sonnet|opus|fable)$|^claude-/i;

/**
 * Codex has no per-tool allow-list, only a sandbox. Map the agent's permissions onto it:
 * no tools / plan → read-only; bypass → full access; otherwise it may write inside its folder.
 */
function sandboxFor(o: AgentRunOptions): SandboxMode {
  if (o.permissionMode === 'bypassPermissions') return 'danger-full-access';
  if (o.permissionMode === 'plan' || (o.tools && !o.tools.length)) return 'read-only';
  const writes = (o.allowedTools ?? []).some((t) => /^(Write|Edit|MultiEdit|NotebookEdit|Bash)\b/.test(t));
  return writes || o.permissionMode === 'acceptEdits' ? 'workspace-write' : 'read-only';
}

function threadOptions(o: AgentRunOptions): ThreadOptions {
  const tools = o.tools ?? o.allowedTools ?? [];
  const web = o.permissionMode === 'bypassPermissions' || tools.some((t) => /^Web(Search|Fetch)\b/.test(t));
  return {
    model: o.model && !CLAUDE_MODEL.test(o.model) ? o.model : undefined,
    modelReasoningEffort: (o.effort || undefined) as ModelReasoningEffort | undefined,
    workingDirectory: o.cwd,
    skipGitRepoCheck: true,
    sandboxMode: sandboxFor(o),
    // Headless: never stop to ask for approval.
    approvalPolicy: 'never',
    networkAccessEnabled: web,
    webSearchMode: tools.some((t) => /^WebSearch\b/.test(t)) || o.permissionMode === 'bypassPermissions' ? 'live' : 'disabled',
  };
}

function codexOptions(o: AgentRunOptions): CodexOptions {
  const server = appToolsServer(o);
  const config: NonNullable<CodexOptions['config']> = {};
  if (o.appendSystemPrompt?.trim()) config.developer_instructions = o.appendSystemPrompt;
  // The app's own tools are safe to run unattended; without this, Codex blocks them under approval "never".
  if (server) config.mcp_servers = { [MCP_SERVER_NAME]: { ...server, default_tools_approval_mode: 'approve' } };
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, PATH: childPath(), ...o.env })) if (v !== undefined) env[k] = v;
  return { config, env };
}

/** The tool name the rest of the app knows (matches Claude's mcp__server__tool naming). */
const mcpName = (server: string, tool: string) => (server === MCP_SERVER_NAME && tool === 'ask_user' ? 'ask_user' : `mcp__${server}__${tool}`);

function mcpResultText(item: Extract<ThreadItem, { type: 'mcp_tool_call' }>): string {
  if (item.error) return item.error.message;
  return (item.result?.content ?? []).map((c: any) => c.text ?? '').join('\n');
}

/**
 * One turn on the OpenAI Codex SDK. Auth is whatever Codex is logged in with
 * (`codex login`: a ChatGPT plan or an API key).
 */
export async function runCodex(o: AgentRunOptions): Promise<AgentResult> {
  const emit = (e: Omit<NodeEvent, 'at'>) => o.onEvent?.({ ...e, at: Date.now() });
  let sessionId = o.resumeSessionId ?? '';
  let lastText = '';
  let question: string | undefined;
  let error: string | undefined;
  let completed = false;

  let outputSchema: unknown;
  if (o.jsonSchema?.trim()) {
    try {
      outputSchema = JSON.parse(o.jsonSchema);
    } catch (err: any) {
      error = `Invalid output schema: ${err.message}`;
      emit({ t: 'error', text: error });
      return { ok: false, text: '', sessionId, costUsd: 0, error, rateLimited: false, cancelled: false };
    }
  }

  try {
    const { Codex } = await loadSdk();
    const codex = new Codex(codexOptions(o));
    const thread = o.resumeSessionId ? codex.resumeThread(o.resumeSessionId, threadOptions(o)) : codex.startThread(threadOptions(o));
    const { events } = await thread.runStreamed(o.prompt, { outputSchema, signal: o.signal });

    for await (const ev of events) {
      switch (ev.type) {
        case 'thread.started':
          sessionId = ev.thread_id;
          emit({ t: 'info', text: `Session started · Codex${threadOptions(o).model ? ` · ${threadOptions(o).model}` : ''} · ${o.cwd}` });
          break;
        case 'item.started': {
          const item = ev.item;
          if (item.type === 'command_execution') emit({ t: 'tool', name: 'Bash', input: { command: item.command } });
          else if (item.type === 'web_search') emit({ t: 'tool', name: 'WebSearch', input: { query: item.query } });
          else if (item.type === 'mcp_tool_call') {
            const args = item.arguments as any;
            if (item.server === MCP_SERVER_NAME && item.tool === 'ask_user' && typeof args?.question === 'string') question = args.question;
            emit({ t: 'tool', name: mcpName(item.server, item.tool), input: args });
          }
          break;
        }
        case 'item.completed': {
          const item = ev.item;
          if (item.type === 'agent_message' && item.text) {
            lastText = item.text;
            emit({ t: 'text', text: item.text });
          } else if (item.type === 'command_execution') emit({ t: 'tool_result', text: clip(item.aggregated_output || `exit ${item.exit_code ?? '?'}`, 1500) });
          else if (item.type === 'file_change') emit({ t: 'tool', name: 'Edit', input: { changes: item.changes, status: item.status } });
          else if (item.type === 'mcp_tool_call') emit({ t: 'tool_result', text: clip(mcpResultText(item), 1500) });
          else if (item.type === 'error') emit({ t: 'info', text: item.message });
          break;
        }
        case 'turn.completed':
          completed = true;
          break;
        case 'turn.failed':
          error = ev.error.message;
          break;
        case 'error':
          error = ev.message;
          break;
      }
    }
  } catch (err: any) {
    if (!o.signal?.aborted) error = err?.message || String(err);
  }

  if (o.signal?.aborted) return { ok: false, text: lastText, sessionId, costUsd: 0, error: 'Cancelled', rateLimited: false, cancelled: true };
  if (!error && !completed) error = 'Codex finished without a result';
  if (error) {
    error = clip(error, 1500);
    logger.warn(error);
    emit({ t: 'error', text: error });
    return { ok: false, text: lastText, sessionId, costUsd: 0, error, rateLimited: RATE_LIMIT_RE.test(error), cancelled: false };
  }

  let structured: unknown;
  if (outputSchema !== undefined) {
    try {
      structured = JSON.parse(lastText);
    } catch {
      /* leave unstructured; the text is still the result */
    }
  }
  // Codex reports tokens, not dollars; ChatGPT-plan usage has no per-run price.
  return { ok: true, text: lastText, structured, sessionId, costUsd: 0, rateLimited: false, cancelled: false, question };
}
