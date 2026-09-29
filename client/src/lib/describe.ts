import type { WfEdge, WfNode } from '../types';
import { metaOf } from './nodeMeta';
import { capsText, qualityLabel, ruleText, scheduleText } from './plain';
import { sourceDef } from './plugins';

// Plain-language outline of a workflow: used by the "describe it" preview,
// template wizards and the Steps view.

const FORMAT: Record<string, string> = { pdf: 'PDF', pptx: 'PowerPoint', docx: 'Word', xlsx: 'Excel', html: 'web page', md: 'Markdown', csv: 'CSV', json: 'JSON', txt: 'text' };
const firstSentence = (s: string, n = 150) => {
  const t = s.replace(/\s+/g, ' ').trim();
  const cut = t.search(/(?<=[.!?])\s/);
  const one = cut > 20 ? t.slice(0, cut) : t;
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

/** One sentence for one step. */
export function describeNode(n: WfNode | { kind: string; label?: string; data: Record<string, any> }): string {
  const d = n.data ?? {};
  switch (n.kind) {
    case 'trigger.manual':
      return 'Starts when you press Run';
    case 'trigger.schedule':
      return scheduleText(d);
    case 'trigger.file':
      return `When a file ${d.events?.includes('change') ? 'is added or changed' : 'is added'} in ${d.path || 'a folder'}`;
    case 'trigger.webhook':
      return 'When another app calls its web address';
    case 'source': {
      const { plugin, def } = sourceDef(d.plugin, d.source);
      const main = def?.fields.find((f) => f.required) ?? def?.fields[0];
      const v = main ? d.config?.[main.key] : undefined;
      const val = Array.isArray(v) ? v.join(', ') : v ? String(v) : '';
      return `Collect ${def?.title ?? d.source ?? 'items'}${plugin && def && !def.title.toLowerCase().includes(plugin.name.toLowerCase().split(' ')[0]) ? ` (${plugin.name})` : ''}${val ? `: “${val.slice(0, 80)}”` : ''}`;
    }
    case 'insight': {
      const f: string[] = d.fields ?? [];
      const parts = [f.includes('sentiment') && 'positive or negative', f.includes('topics') && 'topics', f.includes('relevance') && 'relevance', f.includes('entities') && 'names mentioned', f.includes('summary') && 'a one-line summary'].filter(Boolean);
      return `Label each new item: ${parts.join(', ') || 'custom labels'}`;
    }
    case 'dataset':
      return `Everything collected in “${d.name}”`;
    case 'memory':
      return `Notes & documents: ${d.name}`;
    case 'agent':
      return `${n.label || d.name}: ${firstSentence(d.prompt || 'no instructions yet')}`;
    case 'orchestrator':
      return `AI team “${d.name}”: ${firstSentence(d.prompt || '')}`;
    case 'condition':
      return d.mode === 'llm' ? `Ask Claude: ${d.question || '…'}` : d.rule ? ruleText(d.rule) : n.label ? `If ${n.label.charAt(0).toLowerCase()}${n.label.slice(1)}` : `If ${d.expression || '…'}`;
    case 'merge':
      return 'Wait for the steps before to finish';
    case 'human':
      return `You check it: ${d.title || 'Review'}`;
    case 'output':
      return `Make a ${FORMAT[d.format] ?? d.format} file${d.mode === 'claude' ? ' (designed by Claude)' : ''}`;
    case 'action':
      switch (d.action) {
        case 'email':
          return `Email ${d.to || '(recipient not set)'}${d.via === 'smtp' || d.sendNow ? '' : ' as a draft for you to send'}${d.attach ? ' with the files' : ''}`;
        case 'save':
          return `Save ${d.what === 'text' ? 'the text' : 'the files'} to ${d.folder || 'a folder'}`;
        case 'notify':
          return `Show a notification on this Mac: “${d.title || ''}”`;
        case 'http':
          return `Post it to ${d.preset === 'slack' ? 'Slack' : d.preset === 'teams' ? 'Teams' : String(d.url || '').replace(/^https?:\/\//, '').split('/')[0] || 'a web address'}`;
        case 'open':
          return 'Open the file on this Mac';
      }
  }
  return metaOf(n.kind, d).title;
}

/** Detail line under a step (what the AI may use, which quality…). */
export function describeDetail(n: WfNode): string {
  const d = n.data ?? {};
  if (n.kind === 'agent' || n.kind === 'orchestrator') return `${qualityLabel(d.model)} · ${capsText(d.allowedTools)}${d.canAsk ? ' · can ask you questions' : ''}`;
  if (n.kind === 'source') return d.stopIfEmpty ? 'Stops here if nothing is new' : '';
  if (n.kind === 'insight') return `${qualityLabel(d.model)}${d.brief ? ` · focus: ${firstSentence(d.brief, 80)}` : ''}`;
  return '';
}

export interface OutlineStep {
  node: WfNode;
  text: string;
  detail: string;
  icon: string;
  /** How deep inside If/Otherwise branches it is. */
  depth: number;
  /** "If yes" / "If no" of the condition or review just above, shown on the first step of a branch. */
  branch?: { label: 'yes' | 'no'; of: string };
  parallel: boolean;
  uses: WfNode[];
  team: WfNode[];
  loopTo?: WfNode;
}

const isFlow = (e: WfEdge) => e.sourceHandle !== 'revise' && e.sourceHandle !== 'team';
const branching = (k: string) => k === 'condition' || k === 'human';

/**
 * The steps in the order they run. Each step carries the branch it's in
 * (the longest If/Otherwise context shared by all paths into it).
 */
export function outline(nodes: WfNode[], edges: WfEdge[]): OutlineStep[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const stores = new Set(nodes.filter((n) => n.kind === 'memory' || n.kind === 'dataset').map((n) => n.id));
  const workers = new Set(edges.filter((e) => e.sourceHandle === 'team').map((e) => e.target));
  const flow = edges.filter((e) => isFlow(e) && !stores.has(e.source) && byId.has(e.source) && byId.has(e.target));
  const steps = nodes.filter((n) => !stores.has(n.id) && !workers.has(n.id));

  // Topological order, triggers first, then left-to-right on the canvas as a tie-break.
  const indeg = new Map(steps.map((n) => [n.id, 0]));
  for (const e of flow) if (indeg.has(e.target)) indeg.set(e.target, indeg.get(e.target)! + 1);
  const ready = steps.filter((n) => indeg.get(n.id) === 0).sort((a, b) => Number(b.kind.startsWith('trigger.')) - Number(a.kind.startsWith('trigger.')) || a.position.x - b.position.x || a.position.y - b.position.y);
  const order: WfNode[] = [];
  while (ready.length) {
    const n = ready.shift()!;
    order.push(n);
    const next = flow.filter((e) => e.source === n.id).map((e) => byId.get(e.target)!).sort((a, b) => a.position.y - b.position.y);
    for (const t of next) {
      indeg.set(t.id, indeg.get(t.id)! - 1);
      if (indeg.get(t.id) === 0) ready.push(t);
    }
  }
  for (const n of steps) if (!order.includes(n)) order.push(n); // cycles or loose steps: keep them visible

  type Ctx = Array<{ node: string; handle: string }>;
  const ctx = new Map<string, Ctx>();
  const common = (list: Ctx[]) => {
    if (!list.length) return [];
    const out: Ctx = [];
    for (let i = 0; i < Math.min(...list.map((c) => c.length)); i++) {
      const a = list[0][i];
      if (list.every((c) => c[i].node === a.node && c[i].handle === a.handle)) out.push(a);
      else break;
    }
    return out;
  };
  const shown = new Set<string>();
  return order.map((n) => {
    const incoming = flow.filter((e) => e.target === n.id);
    const c = common(
      incoming.map((e) => {
        const src = byId.get(e.source)!;
        const base = ctx.get(src.id) ?? [];
        return branching(src.kind) ? [...base, { node: src.id, handle: e.sourceHandle === 'false' ? 'no' : 'yes' }] : base;
      }),
    );
    ctx.set(n.id, c);
    const last = c[c.length - 1];
    const key = last ? `${last.node}:${last.handle}` : '';
    const firstInBranch = !!last && !shown.has(key);
    if (key) shown.add(key);
    const preds = incoming.map((e) => byId.get(e.source)!);
    const parallel = preds.some((p) => !branching(p.kind) && flow.filter((e) => e.source === p.id).length > 1);
    const uses = edges.filter((e) => e.target === n.id && stores.has(e.source)).map((e) => byId.get(e.source)!);
    const team = edges.filter((e) => e.source === n.id && e.sourceHandle === 'team').map((e) => byId.get(e.target)!).filter(Boolean);
    const loopTo = byId.get(edges.find((e) => e.source === n.id && e.sourceHandle === 'revise')?.target ?? '');
    return {
      node: n,
      text: describeNode(n),
      detail: describeDetail(n),
      icon: metaOf(n.kind, n.data).icon,
      depth: c.length,
      branch: firstInBranch ? { label: last.handle as 'yes' | 'no', of: byId.get(last.node)?.kind === 'human' ? 'approved' : 'condition' } : undefined,
      parallel,
      uses,
      team,
      loopTo,
    };
  });
}
