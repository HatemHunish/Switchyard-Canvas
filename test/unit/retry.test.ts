// Fix 9: rate limits are retried from the reported reset time, with backoff, and give up clearly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimitDecision, sleep } from '../../src/engine/retry';

const s = { rateLimitRetryMs: 1000, rateLimitRetries: 2, rateLimitMaxWaitMs: 30 * 60_000 };
const now = 1_000_000;

test('not rate limited: no decision', () => {
  assert.equal(rateLimitDecision({ rateLimited: false }, 0, s, now), null);
});

test('known reset within the wait window: wait until just after it', () => {
  assert.deepEqual(rateLimitDecision({ rateLimited: true, retryAt: now + 10 * 60_000 }, 0, s, now), { waitMs: 10 * 60_000 + 5000 });
  assert.deepEqual(rateLimitDecision({ rateLimited: true, retryAt: now - 5000 }, 0, s, now), { waitMs: 1000 }, 'a reset already passed still waits a moment');
});

test('known reset too far away: give up and say when it resets', () => {
  const d = rateLimitDecision({ rateLimited: true, retryAt: now + 3 * 3600_000 }, 0, s, now) as any;
  assert.match(d.giveUp, /resets at/);
});

test('unknown reset: exponential backoff, then give up', () => {
  assert.deepEqual(rateLimitDecision({ rateLimited: true }, 0, s, now), { waitMs: 1000 });
  assert.deepEqual(rateLimitDecision({ rateLimited: true }, 1, s, now), { waitMs: 2000 });
  assert.match((rateLimitDecision({ rateLimited: true }, 2, s, now) as any).giveUp, /after 2 retries/);
});

test('sleep ends early when the run is cancelled', async () => {
  const c = new AbortController();
  const t = Date.now();
  setTimeout(() => c.abort(), 20);
  assert.equal(await sleep(10_000, c.signal), false);
  assert.ok(Date.now() - t < 2000);
  assert.equal(await sleep(5), true);
});
