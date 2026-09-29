import { randomBytes, timingSafeEqual } from 'crypto';

/**
 * Process-wide facts the bundled MCP tool server needs to call back into the
 * app: where the API listens, and a secret only this process and its children know.
 */
export const runtime = {
  apiBase: `http://127.0.0.1:${process.env.PORT || 3002}`,
  internalToken: randomBytes(24).toString('base64url'),
};

/** Guards /api/internal/* endpoints: only our own MCP tool server knows the token. */
export function isInternal(token?: string): boolean {
  const a = Buffer.from(token ?? '');
  const b = Buffer.from(runtime.internalToken);
  return a.length === b.length && timingSafeEqual(a, b);
}
