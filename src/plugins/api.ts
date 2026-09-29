// The contract between Agent Canvas and a plugin. Built-in plugins (./builtin)
// and folder plugins (~/.agent-canvas/plugins/<id>/plugin.json + index.js)
// implement the same shape. See docs/plugins.md.
import { Item, ItemKind, Point } from '../common/types';

export interface PluginField {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'select' | 'list' | 'boolean';
  required?: boolean;
  placeholder?: string;
  help?: string;
  default?: unknown;
  /** select: allowed values. */
  options?: Array<string | { value: string; label: string }>;
}

export interface PluginCredential {
  key: string;
  label: string;
  /** Optional credentials unlock more (higher limits, more data); the plugin works without them. */
  optional?: boolean;
  help?: string;
  placeholder?: string;
}

export interface PluginSourceDef {
  id: string;
  title: string;
  hint?: string;
  /** What kind of items it mostly returns (for the palette). */
  kind?: ItemKind;
  fields: PluginField[];
  /** Credential keys this source can't work without. */
  needs?: string[];
}

export interface PluginToolDef {
  /** Unique across plugins; lowercase letters, digits and underscores. */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Extra Insights panels, in generic types (plugins ship no UI code). */
export interface PluginInsightDef {
  title: string;
  panel: 'top' | 'timeseries';
  /** top: item field path to group by, e.g. "extra.subreddit" or "author". */
  by?: string;
  /** timeseries: series name prefix to plot, e.g. "trends:". */
  series?: string;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  icon?: string;
  description?: string;
  /** Shown on the plugin card: limits, terms, what you need. */
  notice?: string;
  homepage?: string;
  credentials?: PluginCredential[];
  sources?: PluginSourceDef[];
  tools?: PluginToolDef[];
  insights?: PluginInsightDef[];
  /** Folder plugins: workflow JSON files (relative paths) offered as templates. */
  templates?: string[];
}

export interface SourceResult {
  items: Item[];
  points?: Point[];
  /** A line shown in the run log, e.g. "quota: 90/100 left". */
  note?: string;
}

export interface PluginContext {
  /** fetch with a timeout, the run's cancel signal, a polite per-host pace and one retry on 429. Throws on non-2xx. */
  fetch(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response>;
  json<T = any>(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<T>;
  text(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<string>;
  /** Parses RSS/Atom (or any XML) into plain objects. */
  xml(text: string): any;
  /** A saved credential of this plugin, or null. */
  secret(key: string): Promise<string | null>;
  log(text: string): void;
  signal: AbortSignal;
  /** Small JSON object that persists per node between runs (cursors, last hash…). */
  state: Record<string, any>;
}

export interface PluginModule {
  sources?: Record<string, (config: Record<string, any>, ctx: PluginContext) => Promise<SourceResult>>;
  tools?: Record<string, (args: Record<string, any>, ctx: PluginContext) => Promise<unknown>>;
  /** "Test connection": resolve with a short success text or throw. */
  test?: (ctx: PluginContext) => Promise<string | void>;
}

export interface BuiltinPlugin {
  manifest: PluginManifest;
  module: PluginModule;
}

// ---- helpers shared by built-in plugins ----

export const toMs = (v: unknown): number | undefined => {
  if (v == null || v === '') return undefined;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? undefined : t;
};

export const asList = (v: unknown): string[] =>
  (Array.isArray(v) ? v : String(v ?? '').split(/[\n,]/)).map((s) => String(s).trim()).filter(Boolean);

export const arr = <T = any>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** Text content of an XML node that may be a string or {#text}. */
export const xt = (v: any): string => (v == null ? '' : typeof v === 'object' ? String(v['#text'] ?? v.__cdata ?? '') : String(v));

export const stripHtml = (s: string) =>
  s
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();

export const num = (v: unknown): number | undefined => {
  if (v == null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,+]/g, ''));
  return Number.isFinite(n) ? n : undefined;
};

/** Dot-path lookup, e.g. get(obj, "data.children"). */
export const get = (o: any, path?: string): any => (!path ? o : path.split('.').reduce((a, k) => (a == null ? a : a[k]), o));
