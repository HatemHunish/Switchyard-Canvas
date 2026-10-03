import type { NextFunction, Request, Response } from 'express';
import { isIP } from 'net';
import { loadSettings } from './paths';

/**
 * Protects the local API from other websites open in the same browser.
 *
 * - Cross-site requests: any web page can POST a form or a no-preflight fetch to
 *   127.0.0.1. State-changing requests must come from this app's own origin.
 * - DNS rebinding: a hostile domain can re-point itself at 127.0.0.1 and then read
 *   responses as "same origin". Its requests still carry that domain in Host, so
 *   only hosts that can't be rebound are accepted: loopback names, IP literals,
 *   mDNS (.local) names, the configured public URL, and AGENT_CANVAS_ALLOWED_HOSTS.
 *
 * Webhooks (/api/hooks) and review links (/r/) are meant to be reached from
 * elsewhere and check their own secret tokens, so they are exempt.
 */
const EXEMPT = /^\/(api\/hooks\/|r\/)/;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const extraHosts = (process.env.AGENT_CANVAS_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

let publicHost: { at: number; host: string } | null = null;
function configuredPublicHost(): string {
  if (publicHost && Date.now() - publicHost.at < 5_000) return publicHost.host;
  let host = '';
  try {
    const url = loadSettings().publicUrl;
    if (url) host = new URL(url).hostname.toLowerCase();
  } catch {
    /* invalid URL: no extra host */
  }
  publicHost = { at: Date.now(), host };
  return host;
}

/** Hostname without port or IPv6 brackets. */
function hostname(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'));
  return h.replace(/:\d+$/, '');
}

export function isAllowedHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const h = hostname(hostHeader);
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    isIP(h) !== 0 ||
    h.endsWith('.local') ||
    extraHosts.includes(h) ||
    (!!h && h === configuredPublicHost())
  );
}

/** Origin is this app's own origin (same host:port the request was sent to). */
function isSameOrigin(req: Request): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) {
    // No Origin: not a cross-site browser request (curl, our own MCP tool server)
    // unless the browser marks it as such.
    return req.headers['sec-fetch-site'] !== 'cross-site';
  }
  // "null" = sandboxed frames (e.g. previews of generated files), file:// pages, etc.
  if (origin === 'null') return false;
  try {
    return new URL(origin).host.toLowerCase() === (req.headers.host ?? '').toLowerCase();
  } catch {
    return false;
  }
}

export function requestGuard(req: Request, res: Response, next: NextFunction) {
  if (EXEMPT.test(req.path)) return next();
  if (!isAllowedHost(req.headers.host)) {
    res.status(403).json({ statusCode: 403, message: `Host "${req.headers.host ?? ''}" is not allowed. Add it to AGENT_CANVAS_ALLOWED_HOSTS or set it as the public URL.` });
    return;
  }
  if (!SAFE_METHODS.has(req.method) && !isSameOrigin(req)) {
    res.status(403).json({ statusCode: 403, message: 'Cross-site request blocked.' });
    return;
  }
  next();
}
