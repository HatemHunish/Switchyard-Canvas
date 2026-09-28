import dagre from '@dagrejs/dagre';
import type { Edge, Node } from '@xyflow/react';

export const NODE_W = 240;
export const NODE_H = 86;

const isMemory = (n: Node) => (n.data as { kind?: string })?.kind === 'memory';

/**
 * Left-to-right auto layout, the natural reading order for pipelines.
 * Memory nodes aren't steps, so they sit above the first agent they feed.
 */
export function autoLayout<N extends Node>(nodes: N[], edges: Edge[]): N[] {
  const memoryIds = new Set(nodes.filter(isMemory).map((n) => n.id));
  // Team members aren't flow steps either; they line up under their orchestrator.
  const teamEdges = edges.filter((e) => e.sourceHandle === 'team');
  const workerIds = new Set(teamEdges.map((e) => e.target));
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 50, ranksep: 90 });
  g.setDefaultEdgeLabel(() => ({}));
  nodes.filter((n) => !memoryIds.has(n.id) && !workerIds.has(n.id)).forEach((n) => g.setNode(n.id, { width: NODE_W, height: NODE_H }));
  edges
    .filter((e) => !memoryIds.has(e.source) && !workerIds.has(e.target) && !workerIds.has(e.source) && e.sourceHandle !== 'revise')
    .forEach((e) => g.setEdge(e.source, e.target));
  dagre.layout(g);

  const placed = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    if (memoryIds.has(n.id) || workerIds.has(n.id)) continue;
    const p = g.node(n.id);
    placed.set(n.id, { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 });
  }
  const stacked = new Map<string, number>();
  const top = Math.min(...[...placed.values()].map((p) => p.y), 0);
  for (const n of nodes) {
    if (!memoryIds.has(n.id)) continue;
    const target = edges.find((e) => e.source === n.id && placed.has(e.target))?.target;
    const anchor = target ? placed.get(target)! : { x: 0, y: top };
    const k = target ?? '_';
    const i = stacked.get(k) ?? 0;
    stacked.set(k, i + 1);
    placed.set(n.id, { x: anchor.x + i * (NODE_W + 30), y: top - NODE_H - 90 });
  }
  const bottom = Math.max(...[...placed.values()].map((p) => p.y), 0);
  const perLead = new Map<string, number>();
  for (const e of teamEdges) {
    const lead = placed.get(e.source);
    if (!lead || placed.has(e.target)) continue;
    const i = perLead.get(e.source) ?? 0;
    perLead.set(e.source, i + 1);
    placed.set(e.target, { x: lead.x + i * (NODE_W + 30), y: bottom + NODE_H + 110 });
  }
  return nodes.map((n) => ({ ...n, position: placed.get(n.id) ?? n.position }));
}
