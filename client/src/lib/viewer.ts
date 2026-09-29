import { useSyncExternalStore } from 'react';

export interface ViewerFile {
  id: string;
  name: string;
  format?: string;
}

// The file viewer is one app-wide overlay; anything that lists files opens it here.
let state: { files: ViewerFile[]; index: number } | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function openViewer(files: ViewerFile[], index = 0) {
  if (!files.length) return;
  state = { files, index: Math.max(0, Math.min(index, files.length - 1)) };
  emit();
}

export function closeViewer() {
  state = null;
  emit();
}

export function moveViewer(delta: number) {
  if (!state) return;
  state = { ...state, index: (state.index + delta + state.files.length) % state.files.length };
  emit();
}

export function useViewer() {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => state,
  );
}
