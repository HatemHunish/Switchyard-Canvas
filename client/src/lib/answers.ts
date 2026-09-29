// Client copy of src/workflows/answers.ts applyAnswers (for the live preview); the server applies the real one.
import type { SetupQuestion, WfNode } from '../types';

const getAt = (o: any, path: string) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
function setAt(o: any, path: string, v: unknown) {
  const keys = path.split('.');
  let cur = o;
  for (const k of keys.slice(0, -1)) cur = cur[k] && typeof cur[k] === 'object' ? cur[k] : (cur[k] = {});
  cur[keys[keys.length - 1]] = v;
}

const asList = (v: string) =>
  v
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);

/** Fills a workflow's nodes with the answers to its setup questions. Unanswered questions keep the defaults. */
export function applyAnswers(nodes: WfNode[], questions: SetupQuestion[] = [], answers: Record<string, string> = {}): WfNode[] {
  const out = structuredClone(nodes);
  for (const q of questions) {
    const raw = answers[q.id];
    if (raw == null || String(raw).trim() === '') continue;
    const value = String(raw).trim();
    for (const t of q.targets ?? []) {
      const node = out.find((n) => n.id === t.node);
      if (!node) continue;
      node.data ??= {};
      if (t.path === '@time') {
        // Keep the schedule's days, change its time of day.
        const [h, m] = value.split(':').map((x) => Number(x) || 0);
        const parts = String(node.data.cron || '0 9 * * *').trim().split(/\s+/);
        if (parts.length === 5) node.data.cron = [m, h, ...parts.slice(2)].join(' ');
        node.data.mode = 'cron';
        continue;
      }
      const current = getAt(node.data, t.path);
      const fill = (s: string) => (t.format ? t.format.replace(/\{\{\s*value\s*\}\}/g, value) : t.replace ? s.split(t.replace).join(value) : value);
      let next: unknown;
      if (Array.isArray(current) || q.type === 'list') {
        const list = q.type === 'list' ? asList(value) : [value];
        next = t.replace && Array.isArray(current) ? current.flatMap((x) => (typeof x === 'string' && x.includes(t.replace!) ? list.map((v) => x.split(t.replace!).join(v)) : [x])) : list;
      } else if (typeof current === 'string' && (t.replace || t.format)) next = t.replace && !current.includes(t.replace) ? current : fill(current);
      else if (q.type === 'number') next = Number(value);
      else next = t.format ? fill('') : value;
      setAt(node.data, t.path, next);
    }
  }
  return out;
}

