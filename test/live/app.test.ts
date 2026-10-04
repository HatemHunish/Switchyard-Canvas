// The compiled app (dist/), booted like src/main.ts, running real workflows with Claude and Codex agents
// that use their memory tools: Claude through the in-process server, Codex through the stdio server and
// the scoped /api/internal/tools/call endpoint. Needs `npm run build:server` first (test:live does it).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { agentData, edge, memoryData, node, runToEnd, workflow } from '../helpers';

const live = !!process.env.LIVE;
const dist = join(__dirname, '..', '..', 'dist');
let app: any;
let executor: any, store: any, memory: any, storeIdFor: (wfId: string, n: any) => string;

before(async () => {
  if (!live) return;
  require('reflect-metadata');
  const { NestFactory } = require('@nestjs/core');
  const { AppModule } = require(join(dist, 'app.module'));
  const { requestGuard } = require(join(dist, 'common', 'request-guard'));
  const { runtime } = require(join(dist, 'common', 'runtime'));
  app = await NestFactory.create(AppModule, { logger: ['error'] });
  app.use(requestGuard);
  await app.listen(Number(process.env.PORT), '127.0.0.1');
  runtime.apiBase = `http://127.0.0.1:${process.env.PORT}`;
  executor = app.get(require(join(dist, 'engine', 'executor.service')).ExecutorService);
  store = app.get(require(join(dist, 'engine', 'runs.store')).RunsStore);
  const mem = require(join(dist, 'memory', 'memory.service'));
  memory = app.get(mem.MemoryService);
  storeIdFor = mem.storeIdFor;
});

after(async () => {
  await app?.close();
});

async function memoryRun(provider: 'claude' | 'codex') {
  const trigger = node('trigger.manual');
  const a = node(
    'agent',
    agentData(`${provider} reader`, {
      provider,
      model: provider === 'codex' ? '' : 'haiku',
      prompt: 'Use the memory_search tool to find the code word, then save a note with the memory_save tool (key "seen", content: the code word), then reply with only the code word.',
    }),
  );
  const own = node('memory', memoryData('Own'));
  const other = node('memory', memoryData('Other'));
  const helper = node('agent', agentData('Helper'));
  const wf = workflow([trigger, a, own, other, helper], [edge(trigger, a), edge(own, a), edge(other, helper), edge(trigger, helper)]);
  const mine = storeIdFor(wf.id, own);
  const theirs = storeIdFor(wf.id, other);
  memory.saveNote(mine, 'code word', 'The code word is MANGO.', 'manual');
  memory.saveNote(theirs, 'code word', 'The code word is KIWI.', 'manual');
  helper.data.prompt = 'Reply with OK.';
  const { run, nodes } = await runToEnd(executor, store, wf, trigger);
  return { run, nr: nodes.find((n: any) => n.nodeId === a.id), mine, theirs };
}

test('Claude agent in the compiled app: in-process memory tools, scoped to its own store', { skip: !live }, async () => {
  const { run, nr, mine, theirs } = await memoryRun('claude');
  assert.equal(run.status, 'success', run.error);
  assert.match(nr.output.text, /MANGO/);
  assert.doesNotMatch(nr.output.text, /KIWI/);
  assert.equal(memory.search([mine], 'seen').length, 1);
  assert.equal(memory.search([theirs], 'seen').length, 0);
});

test('Codex agent in the compiled app: stdio tool server → /api/internal/tools/call, same scoping', { skip: !live || !codexLoggedIn() }, async () => {
  const { run, nr, mine, theirs } = await memoryRun('codex');
  assert.equal(run.status, 'success', run.error);
  assert.ok(nr.events.some((e: any) => e.t === 'tool' && /memory_search/.test(e.name)), 'Codex called memory_search');
  assert.match(nr.output.text, /MANGO/);
  assert.equal(memory.search([mine], 'seen').length, 1, 'saved through the internal endpoint to its own store');
  assert.equal(memory.search([theirs], 'seen').length, 0);
});

function codexLoggedIn() {
  // It reports on stderr.
  const r = spawnSync(join(__dirname, '..', '..', 'node_modules', '.bin', 'codex'), ['login', 'status'], { encoding: 'utf8' });
  return /Logged in/.test(`${r.stdout}${r.stderr}`);
}
