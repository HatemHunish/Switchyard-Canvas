// How AgentRunOptions become Claude Agent SDK options:
// Fix 2 (settings isolation), Fix 3 (turn/spend limits), Fix 4 (ask hook ends the turn),
// Fix 5 (team hooks), Fix 6 (short system prompt, no session file), Fix 1/7 (member tool servers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOptions, resultError } from '../../src/engine/providers/claude';
import type { AgentRunOptions } from '../../src/engine/agent-runner.service';

const noTool = async () => ({ content: [{ type: 'text' as const, text: '' }] });
const build = (o: Partial<AgentRunOptions>) => buildOptions({ prompt: 'p', cwd: '/tmp', ...o } as AgentRunOptions, 'sid', new AbortController(), () => {}, noTool);
const runHook = async (opts: any, event: string, input: any) => {
  const out: any[] = [];
  for (const m of opts.hooks?.[event] ?? []) for (const h of m.hooks) out.push({ matcher: m.matcher, result: await h(input, undefined, { signal: new AbortController().signal }) });
  return out;
};

test('Fix 2: runs load no settings files and only the app’s MCP servers by default', () => {
  const o = build({});
  assert.deepEqual(o.settingSources, []);
  assert.equal(o.strictMcpConfig, true);
});

test('Fix 2: opting in loads the user’s settings and MCP servers', () => {
  const o = build({ settingSources: ['user', 'project', 'local'], userMcpServers: true });
  assert.deepEqual(o.settingSources, ['user', 'project', 'local']);
  assert.equal(o.strictMcpConfig, false);
});

test('Fix 3: turn and spend limits reach the SDK, and members get their own turn limit', () => {
  const o = build({ maxTurns: 12, maxBudgetUsd: 2.5, agents: { a: { description: 'd', prompt: 'p', maxTurns: 5 } } });
  assert.equal(o.maxTurns, 12);
  assert.equal(o.maxBudgetUsd, 2.5);
  assert.equal(o.agents!.a.maxTurns, 5);
  assert.equal(build({ maxBudgetUsd: 0 }).maxBudgetUsd, undefined, '0 means no spending limit');
});

test('Fix 3: limit stops become plain explanations', () => {
  assert.match(resultError({ subtype: 'error_max_turns', num_turns: 13 }, { maxTurns: 12 }, ''), /Stopped after 13 turns.*Max turns/);
  assert.match(resultError({ subtype: 'error_max_budget_usd' }, { maxBudgetUsd: 2.5 }, ''), /\$2\.5.*Max spend/);
  assert.equal(resultError({ subtype: 'error_during_execution', errors: ['boom'] }, {}, ''), 'boom');
});

test('Fix 4: asking ends the turn through a PostToolUse hook on ask_user only', async () => {
  const o = build({ askTool: true });
  const [h] = await runHook(o, 'PostToolUse', { tool_name: 'mcp__agent_canvas__ask_user' });
  assert.equal(h.matcher, 'mcp__agent_canvas__ask_user');
  assert.equal(h.result.continue, false);
  assert.equal(build({}).hooks, undefined, 'no hooks when the agent can’t ask');
});

test('Fix 5: team hooks report member start/stop and guard the orchestrator’s own tool calls', async () => {
  const events: any[] = [];
  const o = build({
    team: {
      onStart: (k, id) => events.push(['start', k, id]),
      onStop: (k, id, last) => events.push(['stop', k, id, last]),
      mainThreadDeny: (t) => (t === 'Bash' ? 'members only' : undefined),
    },
  });
  await runHook(o, 'SubagentStart', { agent_type: 'researcher', agent_id: 'a1' });
  await runHook(o, 'SubagentStop', { agent_type: 'researcher', agent_id: 'a1', last_assistant_message: 'Result' });
  assert.deepEqual(events, [
    ['start', 'researcher', 'a1'],
    ['stop', 'researcher', 'a1', 'Result'],
  ]);

  const [main] = await runHook(o, 'PreToolUse', { tool_name: 'Bash' });
  assert.equal(main.result.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(main.result.hookSpecificOutput.permissionDecisionReason, 'members only');
  const [member] = await runHook(o, 'PreToolUse', { tool_name: 'Bash', agent_id: 'a1', agent_type: 'researcher' });
  assert.deepEqual(member.result, {}, 'members keep their tools');
  const [other] = await runHook(o, 'PreToolUse', { tool_name: 'Read' });
  assert.deepEqual(other.result, {});
});

test('Fix 1/7: each member gets its own in-process tool server; the orchestrator keeps its own', () => {
  const o = build({
    memory: { search: ['orch'], write: 'orch' },
    allowedTools: ['Agent'],
    agents: {
      alpha: { description: 'A', prompt: 'p', tools: ['WebSearch'], appTools: { memory: { search: ['store-a'], write: 'store-a' } } },
      beta: { description: 'B', prompt: 'p', appTools: { memory: { search: ['store-b'] } } },
      plain: { description: 'C', prompt: 'p' },
    },
  });
  assert.deepEqual(Object.keys(o.mcpServers!).sort(), ['agent_canvas', 'agent_canvas_m_alpha', 'agent_canvas_m_beta']);
  for (const s of Object.values(o.mcpServers!)) assert.equal((s as any).type, 'sdk', 'served in process, no child process');
  assert.deepEqual(o.agents!.alpha.mcpServers, ['agent_canvas_m_alpha']);
  assert.deepEqual(o.agents!.alpha.tools, ['WebSearch', 'mcp__agent_canvas_m_alpha__memory_search', 'mcp__agent_canvas_m_alpha__memory_save']);
  assert.deepEqual(o.agents!.beta.tools, ['mcp__agent_canvas_m_beta__memory_search']);
  assert.equal(o.agents!.plain.mcpServers, undefined);
  assert.ok(o.allowedTools!.includes('mcp__agent_canvas__memory_save'));
  assert.ok(o.allowedTools!.includes('mcp__agent_canvas_m_alpha__memory_save'), 'permissions are per session, so members’ tools are allowed too');
});

test('Fix 6: one-off calls replace Claude Code’s system prompt and keep no session file', () => {
  const o = build({ systemPrompt: 'Judge it.', appendSystemPrompt: 'Extra note.', persistSession: false, tools: [] });
  assert.equal(o.systemPrompt, 'Judge it.\n\nExtra note.');
  assert.equal(o.persistSession, false);
  assert.deepEqual(o.tools, []);
  const agent = build({ appendSystemPrompt: 'Persona' });
  assert.deepEqual(agent.systemPrompt, { type: 'preset', preset: 'claude_code', append: 'Persona' });
  assert.equal('persistSession' in agent, false, 'agents keep their session so questions and revisions can resume it');
});
