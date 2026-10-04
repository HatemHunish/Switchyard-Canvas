import type { AgentResult } from './agent-runner.service';

export interface RetrySettings {
  /** First wait when the reset time is unknown; doubles on each retry. */
  rateLimitRetryMs: number;
  rateLimitRetries: number;
  /** Longest wait for a known reset; beyond it the step fails with the reset time. */
  rateLimitMaxWaitMs: number;
}

export type RetryDecision = { waitMs: number } | { giveUp: string } | null;

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * What to do after a turn that hit a usage limit: wait for the reported reset when it's
 * near, back off when it's unknown, or give up with a clear reason. Null = not rate limited.
 */
export function rateLimitDecision(res: Pick<AgentResult, 'rateLimited' | 'retryAt'>, attempt: number, s: RetrySettings, now = Date.now()): RetryDecision {
  if (!res.rateLimited) return null;
  if (res.retryAt) {
    const wait = Math.max(1000, res.retryAt - now + 5000);
    if (wait > s.rateLimitMaxWaitMs) return { giveUp: `Claude's usage limit was reached; it resets at ${clock(res.retryAt)}.` };
    if (attempt >= s.rateLimitRetries) return { giveUp: `Still at Claude's usage limit after ${attempt} retr${attempt === 1 ? 'y' : 'ies'}.` };
    return { waitMs: wait };
  }
  if (attempt >= s.rateLimitRetries) return { giveUp: `Still rate limited after ${attempt} retr${attempt === 1 ? 'y' : 'ies'}.` };
  return { waitMs: s.rateLimitRetryMs * 2 ** attempt };
}

/** setTimeout that ends early (resolving false) when the run is cancelled. */
export function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const done = (ok: boolean) => {
      clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
      resolve(ok);
    };
    const onAbort = () => done(false);
    const t = setTimeout(() => done(true), ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
