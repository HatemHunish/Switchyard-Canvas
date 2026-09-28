import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { createInterface } from 'readline';
import { loadSettings } from '../common/paths';
import { runtime } from '../common/runtime';
import { NodeEvent, PermissionMode } from '../common/types';
import { EventBus } from './event-bus';

export interface CliRunOptions {
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
  /** Subagents this session may delegate to (orchestrator nodes). */
  agents?: Record<string, { description: string; prompt: string; tools?: string[]; model?: string }>;
  /** Extra environment variables for the CLI process. */
  env?: Record<string, string>;
  /** Every raw stream-json message, including subagent traffic (which is not emitted as this node's events). */
  onMessage?: (msg: any) => void;
  signal?: AbortSignal;
  onEvent?: (e: NodeEvent) => void;
}

export interface CliResult {
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

export const ASK_TOOL = 'mcp__agent_canvas__ask_user';

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
const TOOLS_SERVER = join(__dirname, '..', 'mcp', 'tools-server.js');

const clip = (s: string, n = 4000) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more chars]` : s);

/**
 * Runs one headless turn of the user's own Claude Code CLI (`claude -p`).
 * Auth is whatever the CLI is logged in with (the user's subscription) — this
 * app never handles credentials. Never add `--bare`: it forces API-key auth.
 */
@Injectable()
export class ClaudeCliService {
  private readonly logger = new Logger(ClaudeCliService.name);

  constructor(private readonly bus: EventBus) {}

  buildArgs(o: CliRunOptions, sessionId: string): string[] {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      // Headless: anything that would prompt is denied instead of hanging.
      '--permission-prompts', 'none',
      '--permission-mode', o.permissionMode || 'dontAsk',
      ...(o.resumeSessionId ? ['--resume', o.resumeSessionId] : ['--session-id', sessionId]),
    ];
    if (o.permissionMode === 'bypassPermissions') args.push('--allow-dangerously-skip-permissions');
    if (o.model) args.push('--model', o.model);
    if (o.effort) args.push('--effort', o.effort);
    if (o.appendSystemPrompt?.trim()) args.push('--append-system-prompt', o.appendSystemPrompt);
    if (o.tools) args.push('--tools', o.tools.join(','));
    const appTools = [
      ...(o.askTool ? ['ask_user'] : []),
      ...(o.memory?.search.length ? ['memory_search'] : []),
      ...(o.memory?.write ? ['memory_save'] : []),
    ];
    const allowed = [...(o.allowedTools ?? []), ...appTools.map((t) => `mcp__agent_canvas__${t}`)];
    if (allowed.length) args.push('--allowedTools', allowed.join(','));
    if (appTools.length) {
      const env = {
        AC_TOOLS: appTools.join(','),
        AC_API: runtime.apiBase,
        AC_TOKEN: runtime.internalToken,
        AC_SEARCH_STORES: JSON.stringify(o.memory?.search ?? []),
        AC_WRITE_STORE: o.memory?.write ?? '',
        AC_RUN_ID: o.memory?.runId ?? '',
      };
      args.push('--mcp-config', JSON.stringify({ mcpServers: { agent_canvas: { command: process.execPath, args: [TOOLS_SERVER], env } } }));
    }
    // Nobody can answer the CLI's own question prompt in headless mode; agents ask through the app instead.
    const disallowed = [...(o.disallowedTools ?? []), 'AskUserQuestion'];
    args.push('--disallowedTools', disallowed.join(','));
    if (o.jsonSchema?.trim()) args.push('--json-schema', o.jsonSchema);
    if (o.agents && Object.keys(o.agents).length) args.push('--agents', JSON.stringify(o.agents), '--forward-subagent-text');
    return args;
  }

  run(o: CliRunOptions): Promise<CliResult> {
    const sessionId = o.resumeSessionId ?? randomUUID();
    const args = this.buildArgs(o, sessionId);
    const emit = (e: Omit<NodeEvent, 'at'>) => o.onEvent?.({ ...e, at: Date.now() });

    return new Promise<CliResult>((resolve) => {
      let result: any = null;
      let lastText = '';
      let question: string | undefined;
      let stderr = '';
      let settled = false;
      const finish = (r: CliResult) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };

      const child = spawn(loadSettings().claudeBin, args, {
        cwd: o.cwd,
        env: { ...process.env, ...o.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const onAbort = () => child.kill('SIGTERM');
      o.signal?.addEventListener('abort', onAbort, { once: true });

      // Prompt goes over stdin so text starting with "-" is never parsed as a flag.
      child.stdin.end(o.prompt);

      child.stderr.on('data', (d) => (stderr = (stderr + d.toString()).slice(-4000)));

      createInterface({ input: child.stdout }).on('line', (line) => {
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        o.onMessage?.(msg);
        // Subagent messages belong to the worker, not to this node's own activity.
        if (msg.parent_tool_use_id) return;
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
                if (block.name === ASK_TOOL && typeof block.input?.question === 'string') question = block.input.question;
                emit({ t: 'tool', name: block.name === ASK_TOOL ? 'ask_user' : block.name, input: block.input });
              }
            }
            break;
          case 'user':
            for (const block of msg.message?.content ?? []) {
              if (block.type !== 'tool_result') continue;
              emit({ t: 'tool_result', text: clip(toolResultText(block), 1500) });
            }
            break;
          case 'rate_limit_event': {
            const info = msg.rate_limit_info ?? {};
            const w = info.unifiedWindows ?? {};
            this.bus.emit({
              type: 'usage',
              usage: {
                status: info.status,
                fiveHour: w.five_hour,
                sevenDay: w.seven_day,
                updatedAt: Date.now(),
              },
            });
            break;
          }
          case 'result':
            result = msg;
            break;
        }
      });

      child.on('error', (err: NodeJS.ErrnoException) => {
        const message =
          err.code === 'ENOENT'
            ? `Could not find the Claude Code CLI ("${loadSettings().claudeBin}"). Install it and make sure it is on PATH.`
            : err.message;
        emit({ t: 'error', text: message });
        finish({ ok: false, text: '', sessionId, costUsd: 0, error: message, rateLimited: false, cancelled: false });
      });

      child.on('close', (code) => {
        o.signal?.removeEventListener('abort', onAbort);
        const cancelled = !!o.signal?.aborted;
        if (cancelled) {
          finish({ ok: false, text: lastText, sessionId, costUsd: result?.total_cost_usd ?? 0, error: 'Cancelled', rateLimited: false, cancelled: true });
          return;
        }
        if (!result) {
          const error = clip(stderr.trim() || `claude exited with code ${code} and no result`, 1500);
          this.logger.warn(error);
          emit({ t: 'error', text: error });
          finish({ ok: false, text: lastText, sessionId, costUsd: 0, error, rateLimited: /rate.?limit|usage limit/i.test(stderr), cancelled: false });
          return;
        }
        const text: string = typeof result.result === 'string' ? result.result : lastText;
        const ok = !result.is_error && result.subtype === 'success';
        const error = ok ? undefined : clip(text || result.subtype || 'Run failed', 1500);
        const rateLimited = !ok && (result.api_error_status === 429 || /rate.?limit|usage limit/i.test(text));
        if (error) emit({ t: 'error', text: error });
        finish({
          ok,
          text,
          structured: result.structured_output,
          sessionId: result.session_id ?? sessionId,
          costUsd: result.total_cost_usd ?? 0,
          error,
          rateLimited,
          cancelled: false,
          question,
        });
      });
    });
  }
}
