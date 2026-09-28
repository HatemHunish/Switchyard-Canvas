/** "12s", "4m 10s", "1h 5m". */
export function dur(ms?: number | null): string {
  if (ms == null || !isFinite(ms)) return '–';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "just now", "5 min ago", "3h ago", "yesterday", else a date. */
export function ago(ts?: number | null): string {
  if (!ts) return '–';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 172800) return 'yesterday';
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** "in 12 min", "in 3h", "Mon 09:00". */
export function until(ts?: number | null): string {
  if (!ts) return '–';
  const s = Math.round((ts - Date.now()) / 1000);
  if (s < 60) return 'in <1 min';
  if (s < 3600) return `in ${Math.floor(s / 60)} min`;
  if (s < 6 * 3600) {
    const m = Math.floor((s % 3600) / 60);
    return `in ${Math.floor(s / 3600)}h${m ? ` ${m}m` : ''}`;
  }
  return new Date(ts).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

export const clock = (ts?: number | null) => (ts ? new Date(ts).toLocaleString() : '');
export const pct = (v?: number | null) => (v == null ? '–' : `${Math.round(v * 100)}%`);
export const money = (v?: number | null) => (v == null ? '–' : v < 0.01 && v > 0 ? '<$0.01' : `$${v.toFixed(v < 10 ? 2 : 0)}`);
export const shortDay = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

export const STATUS_ICON: Record<string, string> = {
  success: '✓',
  failed: '✕',
  cancelled: '⊘',
  running: '◐',
  queued: '◌',
  waiting: '⏸',
  skipped: '–',
  pending: '○',
};
