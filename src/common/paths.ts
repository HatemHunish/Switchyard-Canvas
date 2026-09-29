import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { delimiter } from 'path';
import { homedir } from 'os';
import { join } from 'path';

// Everything the app persists lives under one folder, overridable for tests.
export const DATA_DIR = process.env.AGENT_CANVAS_HOME || join(homedir(), '.agent-canvas');
export const WORKFLOWS_DIR = join(DATA_DIR, 'workflows');
export const DB_PATH = join(DATA_DIR, 'runs.db');
export const PLUGINS_DIR = join(DATA_DIR, 'plugins');
/** Default folder for AI steps that don't need your files: they can't see anything else. */
export const WORKSPACE_DIR = join(DATA_DIR, 'workspace');
const SETTINGS_PATH = join(DATA_DIR, 'settings.json');

mkdirSync(WORKFLOWS_DIR, { recursive: true });
mkdirSync(PLUGINS_DIR, { recursive: true });
mkdirSync(WORKSPACE_DIR, { recursive: true });

export interface Settings {
  /** Max `claude` processes running at once (they share one subscription). */
  concurrency: number;
  /** Path/name of the Claude Code CLI binary. */
  claudeBin: string;
  /** Retry once after this delay when a run hits a rate limit. */
  rateLimitRetryMs: number;
  /** macOS notification when a run needs your review or answer. */
  desktopNotifications: boolean;
  /** Where Output nodes write by default (per-workflow subfolders). */
  outputsDir: string;
  /** Chrome/Chromium used for PDF; empty = auto-detect. */
  chromePath: string;
  /** Base URL used in links inside notifications; empty = this machine (http://127.0.0.1:<port>). */
  publicUrl: string;
  /** Outgoing mail for Email actions set to SMTP. The password lives in the Keychain. */
  smtp: { host: string; port: number; secure: boolean; user: string; from: string };
  /** Per-plugin switches. Built-ins default on; plugins from the folder default off until you enable them. */
  plugins: Record<string, { enabled?: boolean }>;
  /** 'simple' hides technical settings and uses plain language; 'advanced' shows everything. */
  uiMode: 'simple' | 'advanced';
  /** The first-run setup was completed or skipped. */
  setupDone: boolean;
  /** The user's own email: the default recipient for "send it to me" steps and notifications. */
  userEmail: string;
}

const DEFAULT_SETTINGS: Settings = {
  concurrency: 2,
  claudeBin: process.env.CLAUDE_BIN || 'claude',
  rateLimitRetryMs: 60_000,
  desktopNotifications: true,
  outputsDir: join(DATA_DIR, 'outputs'),
  chromePath: '',
  publicUrl: '',
  smtp: { host: '', port: 587, secure: false, user: '', from: '' },
  plugins: {},
  uiMode: 'simple',
  setupDone: false,
  userEmail: '',
};

export function loadSettings(): Settings {
  if (!existsSync(SETTINGS_PATH)) return { ...DEFAULT_SETTINGS };
  try {
    const saved = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
    return { ...DEFAULT_SETTINGS, ...saved, smtp: { ...DEFAULT_SETTINGS.smtp, ...saved.smtp }, plugins: { ...saved.plugins } };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

/**
 * Started from Finder (the Mac app), PATH is only /usr/bin:/bin, so look where
 * the Claude Code installers put the CLI as well.
 */
export const EXTRA_BIN_DIRS = [join(homedir(), '.local', 'bin'), join(homedir(), '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.npm-global', 'bin'), join(homedir(), '.bun', 'bin')];

export function resolveClaude(configured: string): string {
  if (configured.includes('/')) return expandHome(configured);
  const dirs = [...(process.env.PATH ?? '').split(delimiter), ...EXTRA_BIN_DIRS].filter(Boolean);
  for (const d of dirs) {
    const p = join(d, configured);
    if (existsSync(p)) return p;
  }
  return configured;
}

/** PATH for child processes, including the usual install locations (Finder-launched apps get a bare PATH). */
export const childPath = () => [...new Set([...(process.env.PATH ?? '').split(delimiter), ...EXTRA_BIN_DIRS])].filter(Boolean).join(delimiter);

export const expandHome = (p: string) => p.replace(/^~(?=$|\/)/, homedir());
