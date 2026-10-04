/**
 * Stdio MCP server started inside a Codex agent's process. It exposes only the
 * tools in that agent's scope (see src/engine/app-tools.ts) and runs them through
 * the app's /api/internal/tools/call with a per-process secret.
 *
 * Claude agents don't use this: they get the same tools from an in-process server.
 * Config comes from env vars set by the Codex provider.
 */
import { createInterface } from 'readline';
import { AppToolScope, appToolDefs } from '../engine/app-tools';

const api = process.env.AC_API ?? '';
const token = process.env.AC_TOKEN ?? '';
const scope: AppToolScope = JSON.parse(process.env.AC_SCOPE || '{}');
const TOOLS = appToolDefs(scope);

const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], isError });

async function runTool(name: string, args: unknown) {
  const res = await fetch(`${api}/api/internal/tools/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': token },
    body: JSON.stringify({ tool: name, args: args ?? {}, scope }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return; // notifications need no reply
  const reply = (result: unknown) => send({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      return reply({ protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'agent-canvas', version: '0.3.0' } });
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call':
      try {
        return reply(await runTool(msg.params?.name, msg.params?.arguments));
      } catch (err: any) {
        return reply(text(`Tool failed: ${err.message}`, true));
      }
    case 'ping':
      return reply({});
    default:
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  }
});
