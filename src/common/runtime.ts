import { randomBytes } from 'crypto';

/**
 * Process-wide facts the bundled MCP tool server needs to call back into the
 * app: where the API listens, and a secret only this process and its children know.
 */
export const runtime = {
  apiBase: `http://127.0.0.1:${process.env.PORT || 3002}`,
  internalToken: randomBytes(24).toString('base64url'),
};
