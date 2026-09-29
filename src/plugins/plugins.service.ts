import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { XMLParser } from 'fast-xml-parser';
import { join, resolve } from 'path';
import { loadSettings, PLUGINS_DIR, saveSettings } from '../common/paths';
import { deleteSecret, getSecret, setSecret } from '../common/secrets';
import { Item, ItemKind, Point } from '../common/types';
import { BuiltinPlugin, PluginContext, PluginManifest, PluginModule, PluginSourceDef, SourceResult } from './api';
import { BUILTIN_PLUGINS } from './builtin';
import { setSourceLookup } from '../workflows/validate';

export interface LoadedPlugin {
  manifest: PluginManifest;
  module: PluginModule;
  builtin: boolean;
  dir?: string;
  enabled: boolean;
  error?: string;
}

const ITEM_KINDS: ItemKind[] = ['post', 'comment', 'video', 'article', 'trend', 'review', 'page', 'other'];
const USER_AGENT = 'AgentCanvas/0.2 (local workflow app)';
const MIN_HOST_GAP_MS = 1000;
const secretName = (plugin: string, key: string) => `plugin:${plugin}:${key}`;
const clip = (s: unknown, n: number) => {
  const t = s == null ? '' : String(s);
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', textNodeName: '#text', cdataPropName: '__cdata', parseTagValue: false, trimValues: true });

/** Loads plugins, runs their sources and tools, and keeps their credentials in the Keychain. */
@Injectable()
export class PluginsService {
  private readonly logger = new Logger(PluginsService.name);
  private plugins: LoadedPlugin[] = [];
  /** Plugin folders that failed before a manifest could be read. */
  private broken: Array<{ dir: string; error: string }> = [];
  private readonly lastHit = new Map<string, number>();

  constructor() {
    this.reload();
    setSourceLookup((plugin, source) => {
      const p = this.plugins.find((x) => x.manifest.id === plugin);
      const def = p?.manifest.sources?.find((s) => s.id === source);
      return p && def ? { title: def.title, pluginName: p.manifest.name, enabled: p.enabled, fields: def.fields } : undefined;
    });
  }

  reload() {
    const settings = loadSettings();
    const enabled = (id: string, builtin: boolean) => settings.plugins[id]?.enabled ?? builtin;
    const list: LoadedPlugin[] = BUILTIN_PLUGINS.map((p: BuiltinPlugin) => ({ manifest: p.manifest, module: p.module, builtin: true, enabled: enabled(p.manifest.id, true) }));
    this.broken = [];

    for (const name of existsSync(PLUGINS_DIR) ? readdirSync(PLUGINS_DIR) : []) {
      const dir = join(PLUGINS_DIR, name);
      if (name.startsWith('.') || !statSync(dir).isDirectory()) continue;
      let manifest: PluginManifest;
      try {
        manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'));
        checkManifest(manifest);
      } catch (err: any) {
        this.broken.push({ dir, error: `plugin.json: ${err.message}` });
        continue;
      }
      if (list.some((p) => p.manifest.id === manifest.id)) {
        this.broken.push({ dir, error: `Another plugin already uses the id "${manifest.id}".` });
        continue;
      }
      const entry: LoadedPlugin = { manifest, module: {}, builtin: false, dir, enabled: enabled(manifest.id, false) };
      try {
        const main = join(dir, 'index.js');
        // Reload picks up edits: drop this plugin's files from Node's module cache.
        for (const k of Object.keys(require.cache)) if (k.startsWith(resolve(dir) + '/')) delete require.cache[k];
        if (existsSync(main)) entry.module = require(main);
      } catch (err: any) {
        entry.error = `index.js: ${err.message}`;
      }
      list.push(entry);
    }

    // Tool names are global (agents see them side by side).
    const seen = new Set<string>();
    for (const p of list) {
      for (const t of p.manifest.tools ?? []) {
        if (seen.has(t.name)) p.error = [p.error, `Tool "${t.name}" is also defined by another plugin; ignored.`].filter(Boolean).join(' ');
        seen.add(t.name);
      }
    }
    this.plugins = list;
    this.logger.log(`Plugins: ${list.map((p) => `${p.manifest.id}${p.enabled ? '' : ' (off)'}`).join(', ')}${this.broken.length ? ` · ${this.broken.length} failed to load` : ''}`);
  }

  all() {
    return this.plugins;
  }

  failures() {
    return this.broken;
  }

  get(id: string): LoadedPlugin {
    const p = this.plugins.find((x) => x.manifest.id === id);
    if (!p) throw new NotFoundException(`Plugin "${id}" is not installed.`);
    return p;
  }

  source(pluginId: string, sourceId: string): { plugin: LoadedPlugin; def: PluginSourceDef } {
    const plugin = this.get(pluginId);
    const def = plugin.manifest.sources?.find((s) => s.id === sourceId);
    if (!def) throw new NotFoundException(`Plugin "${plugin.manifest.name}" has no source "${sourceId}".`);
    return { plugin, def };
  }

  setEnabled(id: string, enabled: boolean) {
    const p = this.get(id);
    const s = loadSettings();
    s.plugins = { ...s.plugins, [id]: { ...s.plugins[id], enabled } };
    saveSettings(s);
    p.enabled = enabled;
  }

  async credentialStatus(id: string): Promise<Record<string, boolean>> {
    const p = this.get(id);
    const out: Record<string, boolean> = {};
    for (const c of p.manifest.credentials ?? []) out[c.key] = !!(await getSecret(secretName(id, c.key)));
    return out;
  }

  /** Saves the given credentials; an empty string removes one. */
  async setCredentials(id: string, values: Record<string, string>) {
    const p = this.get(id);
    for (const c of p.manifest.credentials ?? []) {
      if (!(c.key in values)) continue;
      const v = String(values[c.key] ?? '').trim();
      if (v) await setSecret(secretName(id, c.key), v);
      else await deleteSecret(secretName(id, c.key));
    }
  }

  /** The object a plugin's code gets: fetch helpers, its secrets, a log line, persisted state. */
  context(pluginId: string, opts: { signal?: AbortSignal; log?: (t: string) => void; state?: Record<string, any> } = {}): PluginContext {
    const signal = opts.signal ?? new AbortController().signal;
    const pace = async (url: string) => {
      let host = '';
      try {
        host = new URL(url).host;
      } catch {
        throw new Error(`Invalid URL: ${url}`);
      }
      const wait = (this.lastHit.get(host) ?? 0) + MIN_HOST_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait, signal);
      this.lastHit.set(host, Date.now());
    };
    const doFetch = async (url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> => {
      const { timeoutMs = 30_000, ...rest } = init;
      for (let attempt = 0; ; attempt++) {
        await pace(url);
        const res = await fetch(url, {
          ...rest,
          headers: { 'user-agent': USER_AGENT, accept: 'application/json, application/xml;q=0.9, */*;q=0.8', ...(rest.headers as Record<string, string>) },
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        });
        if (res.status === 429 && attempt === 0) {
          const after = Math.min(30, Number(res.headers.get('retry-after')) || 5);
          opts.log?.(`Rate limited by ${new URL(url).host}; retrying in ${after}s`);
          await sleep(after * 1000, signal);
          continue;
        }
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`${res.status} ${res.statusText} from ${new URL(url).host}${body ? `: ${clip(body.replace(/\s+/g, ' '), 300)}` : ''}`);
        }
        return res;
      }
    };
    return {
      fetch: doFetch,
      json: async (url, init) => (await doFetch(url, init)).json(),
      text: async (url, init) => (await doFetch(url, init)).text(),
      xml: (text: string) => xml.parse(text),
      secret: (key: string) => getSecret(secretName(pluginId, key)),
      log: (t: string) => opts.log?.(t),
      signal,
      state: opts.state ?? {},
    };
  }

  /** Runs a source and returns clean, bounded items. */
  async runSource(
    pluginId: string,
    sourceId: string,
    config: Record<string, unknown>,
    opts: { signal?: AbortSignal; log?: (t: string) => void; state?: Record<string, any> } = {},
  ): Promise<SourceResult> {
    const { plugin, def } = this.source(pluginId, sourceId);
    if (!plugin.enabled) throw new BadRequestException(`Plugin "${plugin.manifest.name}" is turned off. Enable it under Plugins.`);
    if (plugin.error && !plugin.module.sources) throw new BadRequestException(`Plugin "${plugin.manifest.name}" failed to load: ${plugin.error}`);
    const handler = plugin.module.sources?.[sourceId];
    if (typeof handler !== 'function') throw new BadRequestException(`Plugin "${plugin.manifest.name}" doesn't implement source "${sourceId}".`);

    const cfg: Record<string, unknown> = {};
    for (const f of def.fields) {
      const v = config[f.key];
      cfg[f.key] = v === undefined || v === '' ? f.default : f.type === 'number' ? Number(v) : v;
      if (f.required && (cfg[f.key] === undefined || cfg[f.key] === '' || (Array.isArray(cfg[f.key]) && !(cfg[f.key] as unknown[]).length))) {
        throw new BadRequestException(`${def.title}: "${f.label}" is required.`);
      }
    }
    const ctx = this.context(pluginId, opts);
    for (const key of def.needs ?? []) {
      if (!(await ctx.secret(key))) {
        const label = plugin.manifest.credentials?.find((c) => c.key === key)?.label ?? key;
        throw new BadRequestException(`${plugin.manifest.name} needs "${label}". Add it under Plugins → ${plugin.manifest.name}.`);
      }
    }
    const res = await handler(cfg, ctx);
    const items = (Array.isArray(res?.items) ? res.items : []).map(cleanItem).filter((i): i is Item => !!i);
    const points = (Array.isArray(res?.points) ? res.points : []).filter((p: Point) => p && typeof p.series === 'string' && Number.isFinite(p.t) && Number.isFinite(p.value));
    return { items, points, note: res?.note };
  }

  /** Every enabled tool definition, for the Agent inspector. */
  tools() {
    return this.plugins
      .filter((p) => p.enabled)
      .flatMap((p) => (p.manifest.tools ?? []).map((t) => ({ ...t, plugin: p.manifest.id, pluginName: p.manifest.name, icon: p.manifest.icon })));
  }

  toolDefs(names: string[]) {
    const want = new Set(names);
    return this.tools()
      .filter((t) => want.has(t.name))
      .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const p = this.plugins.find((x) => x.enabled && x.manifest.tools?.some((t) => t.name === name));
    const fn = p?.module.tools?.[name];
    if (!p || typeof fn !== 'function') throw new NotFoundException(`No enabled plugin provides the tool "${name}".`);
    const out = await fn(args ?? {}, this.context(p.manifest.id, { signal }));
    const text = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
    return clip(text, 20_000);
  }

  async test(id: string): Promise<string> {
    const p = this.get(id);
    if (!p.module.test) return 'This plugin has no connection test.';
    return (await p.module.test(this.context(id))) || 'Connection works.';
  }

  /** Workflow templates shipped by folder plugins. */
  templates(): Array<{ plugin: string; key: string; name: string; description: string; nodes: any[]; edges: any[] }> {
    const out: Array<{ plugin: string; key: string; name: string; description: string; nodes: any[]; edges: any[] }> = [];
    for (const p of this.plugins) {
      if (!p.enabled || !p.dir) continue;
      for (const rel of p.manifest.templates ?? []) {
        try {
          const t = JSON.parse(readFileSync(join(p.dir, rel), 'utf8'));
          if (Array.isArray(t.nodes) && Array.isArray(t.edges)) out.push({ plugin: p.manifest.id, key: `plugin:${p.manifest.id}:${rel}`, name: t.name || rel, description: t.description || '', nodes: t.nodes, edges: t.edges });
        } catch (err: any) {
          this.logger.warn(`Template ${rel} of plugin ${p.manifest.id}: ${err.message}`);
        }
      }
    }
    return out;
  }
}

function checkManifest(m: PluginManifest) {
  if (!m || typeof m !== 'object') throw new Error('not an object');
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(m.id ?? '')) throw new Error('"id" must be 2–41 lowercase letters, digits or dashes');
  if (!m.name?.trim()) throw new Error('"name" is required');
  for (const s of m.sources ?? []) {
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(s.id ?? '')) throw new Error(`source id "${s.id}" is invalid`);
    if (!s.title) throw new Error(`source "${s.id}" needs a title`);
    if (!Array.isArray(s.fields)) s.fields = [];
  }
  for (const t of m.tools ?? []) if (!/^[a-z0-9_]{2,48}$/.test(t.name ?? '')) throw new Error(`tool name "${t.name}" must be lowercase letters, digits or _`);
}

function cleanItem(i: any): Item | null {
  if (!i || i.id == null || String(i.id).trim() === '') return null;
  const numbers = (o: any) => {
    if (!o || typeof o !== 'object') return undefined;
    const m: Record<string, number> = {};
    for (const [k, v] of Object.entries(o)) if (Number.isFinite(Number(v)) && v !== null && v !== '') m[k] = Number(v);
    return Object.keys(m).length ? m : undefined;
  };
  const t = typeof i.publishedAt === 'number' ? i.publishedAt : i.publishedAt ? Date.parse(i.publishedAt) : NaN;
  return {
    id: clip(i.id, 500),
    kind: ITEM_KINDS.includes(i.kind) ? i.kind : 'other',
    title: i.title ? clip(i.title, 500) : undefined,
    text: i.text ? clip(i.text, 8000) : undefined,
    url: typeof i.url === 'string' && /^https?:\/\//.test(i.url) ? i.url : undefined,
    author: i.author ? clip(i.author, 200) : undefined,
    publishedAt: Number.isFinite(t) ? (t < 1e12 ? t * 1000 : t) : undefined,
    metrics: numbers(i.metrics),
    tags: Array.isArray(i.tags) ? i.tags.map((x: unknown) => clip(x, 80)).slice(0, 30) : undefined,
    media: Array.isArray(i.media) ? i.media.filter((m: any) => m?.url).slice(0, 10) : undefined,
    extra: i.extra && typeof i.extra === 'object' ? i.extra : undefined,
  };
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((res, rej) => {
    if (signal.aborted) return rej(new Error('Cancelled'));
    const t = setTimeout(res, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), rej(new Error('Cancelled'))), { once: true });
  });
}
