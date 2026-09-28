/**
 * Stdio MCP server started inside each agent's `claude` process. It exposes
 * only the tools that agent is wired to on the canvas:
 *
 *  - ask_user       acknowledges only; the app sees the call in the CLI stream,
 *                   waits for the person's answer, then resumes the session.
 *  - memory_search  full-text search over the connected memory stores.
 *  - memory_save    save a note to the connected writable store.
 *
 * Memory calls go back to the app's API with a per-process secret.
 * Config comes from env vars set by ClaudeCliService.
 */
import { createInterface } from 'readline';

const enabled = new Set((process.env.AC_TOOLS ?? '').split(',').filter(Boolean));
const api = process.env.AC_API ?? '';
const token = process.env.AC_TOKEN ?? '';
const searchStores: string[] = JSON.parse(process.env.AC_SEARCH_STORES || '[]');
const writeStore = process.env.AC_WRITE_STORE || '';
const runId = process.env.AC_RUN_ID || undefined;

const TOOLS = [
  {
    name: 'ask_user',
    description:
      'Ask the user a question when you cannot continue without information or a decision only they can give. After calling this, end your turn immediately without further output; the answer arrives as the next user message.',
    inputSchema: { type: 'object', properties: { question: { type: 'string', description: 'One clear question for the user.' } }, required: ['question'] },
  },
  {
    name: 'memory_search',
    description: 'Search the connected memory: saved notes (facts, earlier answers from the user) and indexed documents. Returns the best matches, most relevant first.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Keywords or a question.' }, limit: { type: 'number', description: 'Max results (default 6).' } },
      required: ['query'],
    },
  },
  {
    name: 'memory_save',
    description: 'Save a durable note to memory for future runs, e.g. a decision, preference, name or answer. Saving with an existing key overwrites it.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', description: 'Short descriptive key, e.g. "customer:acme:export format".' }, content: { type: 'string' } },
      required: ['key', 'content'],
    },
  },
].filter((t) => enabled.has(t.name));

const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], isError });

async function call(path: string, body: unknown) {
  const res = await fetch(`${api}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-token': token }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

async function runTool(name: string, args: any) {
  switch (name) {
    case 'ask_user':
      return text('Your question was sent to the user. End your turn now with no further output.');
    case 'memory_search': {
      const hits: Array<{ kind: string; key: string; content: string }> = await call('/api/internal/memory/search', { stores: searchStores, query: String(args?.query ?? ''), limit: args?.limit });
      if (!hits.length) return text('No matches in memory.');
      return text(hits.map((h, i) => `[${i + 1}] ${h.kind === 'note' ? 'NOTE' : 'DOC'} ${h.key}\n${h.content}`).join('\n\n---\n\n'));
    }
    case 'memory_save': {
      if (!writeStore) return text('This memory is read-only.', true);
      await call('/api/internal/memory/save', { store: writeStore, key: String(args?.key ?? ''), content: String(args?.content ?? ''), runId });
      return text(`Saved "${args?.key}".`);
    }
    default:
      return text(`Unknown tool ${name}`, true);
  }
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
      return reply({ protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'agent-canvas', version: '0.2.0' } });
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
