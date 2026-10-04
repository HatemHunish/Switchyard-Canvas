// Loaded with --require before every test file: a throwaway data folder and TypeScript support.
const { mkdtempSync, writeFileSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');

// A fresh folder per process: test files run in parallel and must not share SQLite databases.
process.env.AGENT_CANVAS_HOME = mkdtempSync(join(tmpdir(), 'agent-canvas-test-'));
// Fast retries for the rate-limit tests; everything else stays at its default.
writeFileSync(join(process.env.AGENT_CANVAS_HOME, 'settings.json'), JSON.stringify({ rateLimitRetryMs: 20, setupDone: true }));
process.env.PORT = process.env.PORT || '3999';
process.env.TS_NODE_TRANSPILE_ONLY = 'true';
process.env.TS_NODE_PROJECT = join(__dirname, '..', 'tsconfig.json');
require('ts-node/register');
