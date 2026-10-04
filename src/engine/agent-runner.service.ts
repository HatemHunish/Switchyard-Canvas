import { Injectable } from '@nestjs/common';
import { join } from 'path';
import { runtime } from '../common/runtime';
import { AgentProvider, NodeEvent, PermissionMode } from '../common/types';
import { AppToolScope, appToolNames, ASK_TOOL, MCP_SERVER_NAME, ToolDef } from './app-tools';
import { AppToolsService } from './app-tools.service';
import { EventBus } from './event-bus';
import { runClaude } from './providers/claude';
import { runCodex } from './providers/codex';

/** A team member (Claude Code subagent) of an orchestrator. */
export interface WorkerDef {
  description: string;
  prompt: string;
  tools?: string[];
  model?: string;
  maxTurns?: number;
  /** The member's own app tools (memory, datasets, plugin tools), served to it alone. */
  appTools?: AppToolScope;
}

/** Orchestrator hooks: which member started or finished, and tools the orchestrator itself may not use. */
export interface TeamHooks {
  onStart: (memberKey: string, agentId: string) => void;
  onStop: (memberKey: string, agentId: string, lastMessage?: string) => void;
  /** Reason to deny a tool called by the orchestrator itself (not a member), or undefined to allow. */
  mainThreadDeny?: (toolName: string) => string | undefined;
}

export type SettingSource = 'user' | 'project' | 'local';

export interface AgentRunOptions {
  /** Which agent runtime runs this turn; default 'claude'. */
  provider?: AgentProvider;
  prompt: string;
  cwd: string;
  model?: string;
  effort?: string;
  appendSystemPrompt?: string;
  /** Replaces Claude Code's own system prompt (for tool-less one-off calls like labelling and judging). */
  systemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  /** Restrict the built-in tool set; [] disables every tool. */
  tools?: string[];
  permissionMode?: PermissionMode;
  jsonSchema?: string;
  /** Continue an earlier session (keeps its full context) instead of starting a new one. */
  resumeSessionId?: string;
  /** Give the agent the app's `ask_user` tool. */
  askTool?: boolean;
  /** Connected memory stores: searchable ones, and the one notes are saved to (if writable). */
  memory?: { search: string[]; write?: string; runId?: string };
  /** Connected datasets (dataset_* tools). */
  datasets?: string[];
  /** Plugin tools with their schemas (run by the app). */
  pluginTools?: ToolDef[];
  /** Subagents this session may delegate to (orchestrator nodes; Claude only). */
  agents?: Record<string, WorkerDef>;
  team?: TeamHooks;
  /** Claude Code settings files to load. Default none, so the user's own hooks, plugins and CLAUDE.md stay out of runs. */
  settingSources?: SettingSource[];
  /** Also load the MCP servers from those settings (otherwise only the app's own tools are connected). */
  userMcpServers?: boolean;
  /** Stop after this many agentic turns. */
  maxTurns?: number;
  /** Stop once the estimated cost of this turn passes this many dollars. */
  maxBudgetUsd?: number;
  /** Keep the session on disk so it can be resumed later (default true). */
  persistSession?: boolean;
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
  /** When the usage limit that stopped this turn resets (ms since epoch), if known. */
  retryAt?: number;
  cancelled: boolean;
  /** Set when the agent called ask_user during this turn. */
  question?: string;
}

export { ASK_TOOL, MCP_SERVER_NAME };
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

/** The app tools this agent's own server exposes. */
export const appScope = (o: AgentRunOptions): AppToolScope => ({ ask: o.askTool, memory: o.memory, datasets: o.datasets, pluginTools: o.pluginTools });

/** Stdio MCP server config for a Codex agent's app tools, or undefined when it needs none. */
export function appToolsServer(o: AgentRunOptions): { command: string; args: string[]; env: Record<string, string> } | undefined {
  const scope = appScope(o);
  if (!appToolNames(scope).length) return undefined;
  return {
    command: process.execPath,
    args: [TOOLS_SERVER],
    env: { AC_API: runtime.apiBase, AC_TOKEN: runtime.internalToken, AC_SCOPE: JSON.stringify(scope) },
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
  constructor(
    private readonly bus: EventBus,
    private readonly tools: AppToolsService,
  ) {}

  async run(o: AgentRunOptions): Promise<AgentResult> {
    // A step cancelled while it waited in the queue must not start at all.
    if (o.signal?.aborted) {
      return { ok: false, text: '', sessionId: o.resumeSessionId ?? '', costUsd: 0, error: 'Cancelled', rateLimited: false, cancelled: true };
    }
    return o.provider === 'codex' ? runCodex(o) : runClaude(o, { onUsage: (usage) => this.bus.emit({ type: 'usage', usage }), callTool: (name, args, scope) => this.tools.call(name, args, scope) });
  }
}
