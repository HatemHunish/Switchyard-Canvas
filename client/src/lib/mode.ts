import { useEffect, useSyncExternalStore } from 'react';
import { api } from '../api';

// Simple vs Advanced, plus the few settings the Simple UI needs everywhere.
interface ModeState {
  mode: 'simple' | 'advanced';
  workspaceDir: string;
  userEmail: string;
  setupDone: boolean;
  loaded: boolean;
}

let state: ModeState = { mode: 'simple', workspaceDir: '~/.agent-canvas/workspace', userEmail: '', setupDone: true, loaded: false };
let loading = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const set = (patch: Partial<ModeState>) => {
  state = { ...state, ...patch };
  emit();
};

export async function loadMode() {
  loading = true;
  try {
    const s = await api.settings();
    set({ mode: s.uiMode ?? 'simple', workspaceDir: s.workspaceDir ?? state.workspaceDir, userEmail: s.userEmail ?? '', setupDone: !!s.setupDone, loaded: true });
  } finally {
    loading = false;
  }
}

export async function setMode(mode: 'simple' | 'advanced') {
  set({ mode });
  await api.saveSettings({ uiMode: mode });
}

export async function saveProfile(patch: { userEmail?: string; setupDone?: boolean }) {
  await api.saveSettings(patch);
  set(patch);
}

function useModeState(): ModeState {
  const s = useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => state,
  );
  useEffect(() => {
    if (!state.loaded && !loading) void loadMode();
  }, []);
  return s;
}

export const useSettingsState = useModeState;
/** True when the plain-language interface is on. */
export const useSimple = () => useModeState().mode === 'simple';
export const modeNow = () => state;

/** "~/Documents/x" instead of "/Users/me/Documents/x". */
export function tildify(p: string, home?: string) {
  const h = home ?? (state.workspaceDir.match(/^(\/Users\/[^/]+|\/home\/[^/]+)/)?.[1] ?? '');
  return h && p.startsWith(h) ? `~${p.slice(h.length)}` : p;
}
