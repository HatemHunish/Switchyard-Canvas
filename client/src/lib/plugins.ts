import { useEffect, useSyncExternalStore } from 'react';
import { api, type PluginInfo, type PluginList, type PluginSource } from '../api';

// One shared copy of the installed plugins: the palette, node titles and the
// inspector all read it, and the Plugins page refreshes it after changes.
let catalog: PluginList | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

export function refreshPlugins(): Promise<void> {
  loading = api
    .plugins()
    .then((c) => {
      catalog = c;
      listeners.forEach((l) => l());
    })
    .catch(() => undefined)
    .finally(() => (loading = null));
  return loading;
}

export function usePlugins(): PluginList | null {
  const value = useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => catalog,
  );
  useEffect(() => {
    if (!catalog && !loading) void refreshPlugins();
  }, []);
  return value;
}

export const pluginById = (id?: string): PluginInfo | undefined => catalog?.plugins.find((p) => p.id === id);

export function sourceDef(plugin?: string, source?: string): { plugin?: PluginInfo; def?: PluginSource } {
  const p = pluginById(plugin);
  return { plugin: p, def: p?.sources?.find((s) => s.id === source) };
}

/** Default config values for a source's fields. */
export function sourceDefaults(def: PluginSource): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  for (const f of def.fields) if (f.default !== undefined) c[f.key] = f.default;
  return c;
}
