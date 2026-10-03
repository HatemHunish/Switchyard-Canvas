import { Injectable } from '@nestjs/common';
import { join } from 'path';
import { runtime } from '../common/runtime';
import { AgentProvider, NodeEvent, PermissionMode } from '../common/types';
import { EventBus } from './event-bus';
import { runClaude } from './providers/claude';
import { runCodex } from './providers/codex';

export interface AgentRunOptions {
  /** Which agent runtime runs this turn; default 'claude'. */
  provider?: AgentProvider;
  prompt: string;
  cwd: string;
  model?: string;
  effort?: string;
  appendSystemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  /** Restrict the built-in tool set; [] disables every tool. */
  tools?: string[];
  permissionMode?: PermissionMode;
  jsonSchema?: string;
  /** Continue an earlier session (keeps its full context) instead of starting a new one. */
  resumeSessionId?: string;
  /** Give the agent the app's `ask_user` tool (see src/mcp/tools-server.ts). */
  askTool?: boolean;
  /** Connected memory stores: searchable ones, and the one notes are saved to (if writable). */
  memory?: { search: string[]; write?: string; runId?: string };
  /** Connected datasets (dataset_* tools). */
  datasets?: string[];
  /** Plugin tools with their schemas (served by the same MCP server, run by the app). */
  pluginTools?: Array<{ name: string; description: string; inputSchema: unknown }>;
  /** Subagents this session may delegate to (orchestrator nodes; Claude only). */
  agents?: Record<string, { description: string; prompt: string; tools?: string[]; model?: string }>;
  /** Extra environment variables for the agent process. */
  env?: Record<string, string>;
  /** Every raw Claude SDK message, including subagent traffic (which is not emitted as this node's events). */
  onMessage?: (msg: any) => void;
  signal?: AbortSignal;
  onEvent?: (e: NodeEvent) => void;
}

export interface AgentResult {
  ok: boolean;
  text: string;
  structured?: unknown;
  sessionId: string;
  costUsd: number;
  error?: string;
  rateLimited: boolean;
  cancelled: boolean;
  /** Set when the agent called ask_user during this turn. */
  question?: string;
}

export const MCP_SERVER_NAME = 'agent_canvas';
export const ASK_TOOL = `mcp__${MCP_SERVER_NAME}__ask_user`;
const TOOLS_SERVER = join(__dirname, '..', 'mcp', 'tools-server.js');

export const clip = (s: string, n = 4000) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more chars]` : s);

export const RATE_LIMIT_RE = /rate.?limit|usage limit|\b429\b/i;

export function toolResultText(block: any): string {
  return Array.isArray(block.content) ? block.content.map((c: any) => c.text ?? '').join('\n') : String(block.content ?? '');
}

/** UI events for one assistant/user message (used for subagent traffic of orchestrators). */
export function eventsFromMessage(msg: any): NodeEvent[] {
  const at = Date.now();
  const out: NodeEvent[] = [];
  for (const block of Array.isArray(msg.message?.content) ? msg.message.content : []) {
    if (msg.type === 'assistant' && block.type === 'text' && block.text) out.push({ t: 'text', text: block.text, at });
    else if (msg.type === 'assistant' && block.type === 'tool_use') out.push({ t: 'tool', name: block.name, input: block.input, at });
    else if (msg.type === 'user' && block.type === 'tool_result') out.push({ t: 'tool_result', text: clip(toolResultText(block), 1500), at });
  }
  return out;
}

/** The app's own tools this turn needs (bare names, served by src/mcp/tools-server.ts). */
export function appToolNames(o: AgentRunOptions): string[] {
  return [
    ...(o.askTool ? ['ask_user'] : []),
    ...(o.memory?.search.length ? ['memory_search'] : []),
    ...(o.memory?.write ? ['memory_save'] : []),
    ...(o.datasets?.length ? ['dataset_search', 'dataset_stats', 'dataset_top'] : []),
    ...(o.pluginTools ?? []).map((t) => t.name),
  ];
}

/** Stdio MCP server config for the app's tools, or undefined when the turn needs none. */
export function appToolsServer(o: AgentRunOptions): { command: string; args: string[]; env: Record<string, string> } | undefined {
  const tools = appToolNames(o);
  if (!tools.length) return undefined;
  return {
    command: process.execPath,
    args: [TOOLS_SERVER],
    env: {
      AC_TOOLS: tools.join(','),
      AC_API: runtime.apiBase,
      AC_TOKEN: runtime.internalToken,
      AC_SEARCH_STORES: JSON.stringify(o.memory?.search ?? []),
      AC_WRITE_STORE: o.memory?.write ?? '',
      AC_RUN_ID: o.memory?.runId ?? '',
      AC_DATASETS: JSON.stringify(o.datasets ?? []),
      AC_EXTRA_TOOLS: JSON.stringify(o.pluginTools ?? []),
    },
  };
}

/** Both SDKs are ESM-only; a plain `import()` would be compiled to `require()` in this CommonJS build. */
export const importEsm = new Function('s', 'return import(s)') as <T>(specifier: string) => Promise<T>;

/**
 * Runs one headless agent turn on the selected provider:
 * - claude: the Claude Agent SDK, authenticated however Claude Code is logged in.
 * - codex: the OpenAI Codex SDK, authenticated however Codex is logged in (ChatGPT or API key).
 * This app never handles credentials itself.
 */
@Injectable()
export class AgentRunnerService {
  constructor(private readonly bus: EventBus) {}

  async run(o: AgentRunOptions): Promise<AgentResult> {
    // A step cancelled while it waited in the queue must not start at all.
    if (o.signal?.aborted) {
      return { ok: false, text: '', sessionId: o.resumeSessionId ?? '', costUsd: 0, error: 'Cancelled', rateLimited: false, cancelled: true };
    }
    return o.provider === 'codex' ? runCodex(o) : runClaude(o, (usage) => this.bus.emit({ type: 'usage', usage }));
  }
}
