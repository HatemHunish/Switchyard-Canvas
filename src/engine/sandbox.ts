import { homedir } from 'os';
import { join } from 'path';
import { DATA_DIR } from '../common/paths';

/** How a Claude agent's shell commands are confined. `false` = not sandboxed. */
export type SandboxSpec = { writable: string[]; domains: string[] } | false;

/**
 * Places an agent must never read, even inside the sandbox: credentials, other
 * agents' sessions and logins, and the app's own data (memory, runs, settings,
 * workflows, plugin code). The workspace and outputs folders stay reachable.
 */
export function protectedPaths(): string[] {
  const home = homedir();
  return [
    ...['.ssh', '.aws', '.gnupg', '.config/gh', '.config/gcloud', '.netrc', '.npmrc', '.docker', '.kube', 'Library/Keychains', '.claude/projects', '.codex'].map((p) => join(home, p)),
    ...['memory', 'runs', 'datasets'].flatMap((db) => ['', '-wal', '-shm'].map((x) => join(DATA_DIR, `${db}.db${x}`))),
    ...['settings.json', 'usage.json', 'workflows', 'plugins'].map((p) => join(DATA_DIR, p)),
  ];
}

/** Permission rules for the file tools, which the OS sandbox doesn't cover ("//" marks an absolute path). */
export function protectedRules(paths = protectedPaths()): string[] {
  return paths.flatMap((p) => [`Read(/${p}/**)`, `Read(/${p})`, `Edit(/${p}/**)`, `Edit(/${p})`]);
}

/** Hostnames from user input ("https://pypi.org/simple", " GitHub.com ", "*.npmjs.org"), deduplicated; anything else dropped. */
export function cleanDomains(input: unknown): string[] {
  const list = Array.isArray(input) ? input : String(input ?? '').split(/[\s,]+/);
  const out = list
    .map((d) => String(d).trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/:?#].*$/, ''))
    .filter((d) => /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d));
  return [...new Set(out)];
}
