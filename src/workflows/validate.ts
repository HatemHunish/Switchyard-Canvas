import { Workflow } from '../common/types';

export interface ValidationIssue {
  nodeId?: string;
  message: string;
}

const isTrigger = (kind: string) => kind.startsWith('trigger.');
const isLoop = (e: { sourceHandle?: string | null }) => e.sourceHandle === 'revise';
const isTeam = (e: { sourceHandle?: string | null }) => e.sourceHandle === 'team';

/** Problems that would stop a workflow from running. Saving is still allowed. */
export function validateWorkflow(wf: Workflow): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byId = new Map(wf.nodes.map((n) => [n.id, n]));

  if (!wf.nodes.some((n) => isTrigger(n.kind))) {
    issues.push({ message: 'Add a trigger node (manual, schedule, file watch or webhook).' });
  }

  const flow = wf.edges.filter((e) => !isLoop(e) && !isTeam(e));
  const ancestors = (id: string) => {
    const seen = new Set<string>();
    const todo = [id];
    while (todo.length) {
      const cur = todo.pop()!;
      for (const e of flow) if (e.target === cur && !seen.has(e.source)) (seen.add(e.source), todo.push(e.source));
    }
    return seen;
  };
  for (const e of wf.edges.filter(isLoop)) {
    const src = byId.get(e.source);
    const tgt = byId.get(e.target);
    if (src?.kind !== 'human') issues.push({ message: 'Only Human review nodes can loop back.' });
    else if (tgt?.kind !== 'agent' && tgt?.kind !== 'orchestrator') issues.push({ nodeId: src.id, message: 'A revise loop must point to an Agent or Orchestrator.' });
    else if (!ancestors(src.id).has(tgt.id)) issues.push({ nodeId: src.id, message: `The revise loop must point to an agent that runs before this review ("${tgt.data?.name}" doesn't).` });
  }

  const workers = new Set<string>();
  for (const e of wf.edges.filter(isTeam)) {
    const src = byId.get(e.source);
    const tgt = byId.get(e.target);
    if (src?.kind !== 'orchestrator') issues.push({ message: 'Only Orchestrator nodes have a team.' });
    else if (tgt?.kind !== 'agent') issues.push({ nodeId: src.id, message: 'Team members must be Agent nodes.' });
    else workers.add(tgt.id);
  }
  for (const id of workers) {
    if (flow.some((e) => e.target === id || e.source === id)) {
      issues.push({ nodeId: id, message: `"${byId.get(id)?.data?.name}" is a team member, so it runs when the orchestrator delegates. Remove its other flow connections.` });
    }
  }

  for (const e of flow) {
    if (!byId.has(e.source) || !byId.has(e.target)) {
      issues.push({ message: `Edge ${e.id} points at a missing node.` });
    }
    const target = byId.get(e.target);
    const source = byId.get(e.source);
    if (source?.kind === 'memory' && target && target.kind !== 'agent' && target.kind !== 'orchestrator') {
      issues.push({ nodeId: source.id, message: 'Memory can only be connected to Agent or Orchestrator nodes.' });
    }
    if (target?.kind === 'memory') {
      issues.push({ nodeId: target.id, message: 'Memory is a store, not a step: connect it from Memory to an Agent.' });
    }
    if (target && isTrigger(target.kind)) {
      issues.push({ nodeId: target.id, message: 'Triggers cannot have incoming connections.' });
    }
  }

  for (const n of wf.nodes) {
    const d = n.data || {};
    switch (n.kind) {
      case 'agent':
        if (!d.prompt?.trim()) issues.push({ nodeId: n.id, message: `Agent "${d.name || n.id}" needs a prompt.` });
        if (!d.cwd?.trim()) issues.push({ nodeId: n.id, message: `Agent "${d.name || n.id}" needs a working directory.` });
        if (d.outputSchema?.trim()) {
          try {
            JSON.parse(d.outputSchema);
          } catch {
            issues.push({ nodeId: n.id, message: `Agent "${d.name || n.id}" output schema is not valid JSON.` });
          }
        }
        break;
      case 'condition':
        if (d.mode === 'llm' ? !d.question?.trim() : !d.expression?.trim()) {
          issues.push({ nodeId: n.id, message: 'Condition needs an expression or a question.' });
        }
        break;
      case 'trigger.schedule':
        if (d.mode === 'cron' ? !d.cron?.trim() : !(Number(d.everyMinutes) >= 1)) {
          issues.push({ nodeId: n.id, message: 'Schedule needs a cron expression or an interval of at least 1 minute.' });
        }
        break;
      case 'output':
        if (!['pdf', 'pptx', 'docx', 'xlsx', 'html', 'md', 'csv', 'json', 'txt'].includes(d.format)) issues.push({ nodeId: n.id, message: 'Output needs a file format.' });
        break;
      case 'action':
        if (d.action === 'email' && !d.to?.trim()) issues.push({ nodeId: n.id, message: 'Email action needs a recipient.' });
        if (d.action === 'http' && !/^https?:\/\//.test(d.url?.trim() ?? '')) issues.push({ nodeId: n.id, message: 'HTTP action needs an http(s) URL.' });
        if (d.action === 'save' && !d.folder?.trim()) issues.push({ nodeId: n.id, message: 'Save action needs a folder.' });
        break;
      case 'orchestrator': {
        if (!d.prompt?.trim()) issues.push({ nodeId: n.id, message: `Orchestrator "${d.name || n.id}" needs a task prompt.` });
        if (!d.cwd?.trim()) issues.push({ nodeId: n.id, message: `Orchestrator "${d.name || n.id}" needs a working directory.` });
        const team = wf.edges.filter((e) => e.source === n.id && isTeam(e)).map((e) => byId.get(e.target)).filter((t) => t?.kind === 'agent');
        if (!team.length) issues.push({ nodeId: n.id, message: `Orchestrator "${d.name || n.id}" has no team: drag from its team handle to one or more agents.` });
        const keys = team.map((t) => String(t!.data?.name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-'));
        if (new Set(keys).size < keys.length) issues.push({ nodeId: n.id, message: 'Team members need distinct names.' });
        break;
      }
      case 'human':
        if (d.onReject === 'revise' && !wf.edges.some((e) => (e.target === n.id && ['agent', 'orchestrator'].includes(byId.get(e.source)?.kind ?? '')) || (e.source === n.id && isLoop(e)))) {
          issues.push({ nodeId: n.id, message: 'Review set to "send feedback back" needs an Agent connected directly before it.' });
        }
        break;
      case 'memory':
        if (!d.name?.trim()) issues.push({ nodeId: n.id, message: 'Memory needs a name.' });
        break;
      case 'trigger.file':
        if (!d.path?.trim()) issues.push({ nodeId: n.id, message: 'File watch needs a path.' });
        break;
    }
  }

  // Cycle check (Kahn's algorithm).
  const indeg = new Map(wf.nodes.map((n) => [n.id, 0]));
  for (const e of flow) if (indeg.has(e.target)) indeg.set(e.target, indeg.get(e.target)! + 1);
  const queue = [...indeg].filter(([, d]) => d === 0).map(([id]) => id);
  let seen = 0;
  while (queue.length) {
    const id = queue.shift()!;
    seen++;
    for (const e of flow) {
      if (e.source !== id || !indeg.has(e.target)) continue;
      indeg.set(e.target, indeg.get(e.target)! - 1);
      if (indeg.get(e.target) === 0) queue.push(e.target);
    }
  }
  if (seen < wf.nodes.length) issues.push({ message: 'The workflow has a loop. Steps must flow one way; use a Human review’s ↩ revise handle to loop back.' });

  return issues;
}
