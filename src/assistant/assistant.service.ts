import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { homedir } from 'os';
import { loadSettings, WORKSPACE_DIR } from '../common/paths';
import { NodeKind, SetupQuestion, WfEdge, WfNode } from '../common/types';
import { AgentRunnerService } from '../engine/agent-runner.service';
import { ProcessQueue } from '../engine/queue';
import { PluginsService } from '../plugins/plugins.service';
import { applyAnswers, dummyAnswers, ruleToExpression } from '../workflows/answers';
import { validateWorkflow } from '../workflows/validate';

export interface Draft {
  name: string;
  description: string;
  notes?: string;
  nodes: WfNode[];
  edges: WfEdge[];
  questions: SetupQuestion[];
  /** Problems left after the repair turn (normally empty). */
  issues: string[];
  costUsd: number;
}

const KINDS: NodeKind[] = ['trigger.manual', 'trigger.schedule', 'trigger.file', 'agent', 'orchestrator', 'source', 'insight', 'dataset', 'condition', 'human', 'output', 'action', 'memory', 'merge'];
const TOOLS = new Set(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'WebSearch', 'WebFetch', 'Skill']);
const tilde = (p: string) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'step';

const SCHEMA = JSON.stringify({
  type: 'object',
  required: ['name', 'description', 'nodes', 'edges', 'questions'],
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    notes: { type: 'string' },
    nodes: {
      type: 'array',
      items: { type: 'object', required: ['id', 'kind', 'data'], properties: { id: { type: 'string' }, kind: { type: 'string', enum: KINDS }, label: { type: 'string' }, data: { type: 'object' } } },
    },
    edges: {
      type: 'array',
      items: { type: 'object', required: ['source', 'target'], properties: { source: { type: 'string' }, target: { type: 'string' }, sourceHandle: { type: ['string', 'null'], enum: [null, 'true', 'false', 'revise', 'team'] } } },
    },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'label', 'type', 'targets'],
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          help: { type: 'string' },
          placeholder: { type: 'string' },
          type: { type: 'string', enum: ['text', 'email', 'folder', 'list', 'time', 'number', 'url'] },
          default: { type: 'string' },
          required: { type: 'boolean' },
          targets: { type: 'array', items: { type: 'object', required: ['node', 'path'], properties: { node: { type: 'string' }, path: { type: 'string' }, replace: { type: 'string' }, format: { type: 'string' } } } },
        },
      },
    },
  },
});

/** Turns a plain-language description into a workflow draft, using the user's own Claude plan. */
@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);

  constructor(
    private readonly agents: AgentRunnerService,
    private readonly queue: ProcessQueue,
    private readonly plugins: PluginsService,
  ) {}

  private catalog() {
    return this.plugins
      .all()
      .filter((p) => p.enabled)
      .flatMap((p) =>
        (p.manifest.sources ?? []).map((s) => {
          const fields = s.fields
            .map((f) => `${f.key} (${f.type}${f.required ? ', required' : ''}${f.default !== undefined ? `, default ${JSON.stringify(f.default)}` : ''}${f.options ? `, one of ${f.options.map((o) => (typeof o === 'string' ? o : o.value)).join('|')}` : ''})`)
            .join('; ');
          const needs = (s.needs ?? []).map((k) => p.manifest.credentials?.find((c) => c.key === k)?.label ?? k);
          return `- plugin "${p.manifest.id}" source "${s.id}": ${s.title}. ${s.hint ?? ''}. Fields: ${fields || 'none'}.${needs.length ? ` NEEDS the user to add "${needs.join(', ')}" under Plugins (mention it in notes).` : ''}`;
        }),
      )
      .join('\n');
  }

  private systemPrompt() {
    const email = loadSettings().userEmail;
    const ws = tilde(WORKSPACE_DIR);
    return `You design automations for Agent Canvas, a local app where workflows are graphs of steps. The user is not technical. Design the smallest workflow that does what they describe (usually 3–7 steps) and return it as JSON.

## Step kinds and their "data"
- trigger.manual: {} (started with the Run button).
- trigger.schedule: {"mode":"interval","everyMinutes":N} or {"mode":"cron","cron":"M H DoM Mon DoW"} in local time, e.g. "0 9 * * 1-5" = weekdays 09:00, "0 8 * * *" = every day 08:00, "0 9 * * 1" = Mondays 09:00.
- trigger.file: {"path":"~/Desktop/inbox","events":["add"],"debounceMs":1500}; the new file's path is {{trigger.payload.path}}.
- agent (an AI step): {"name":"short-kebab-name","description":"one line","prompt":"clear instructions","model":"haiku"|"sonnet"|"opus","allowedTools":[…],"cwd":"…","canAsk":false}. It automatically receives the previous step's output after its prompt. allowedTools: [] = only thinks and writes (summaries, drafting, analysis of given input); ["WebSearch","WebFetch"] = research on the web; ["Read","Grep","Glob"] = read files in its folder; add "Edit","Write" only to create or change files; "Bash" only if unavoidable. cwd: "${ws}" (a private empty folder) unless the task needs the user's own files: then add a folder question targeting "cwd". model: "sonnet" by default, "haiku" for simple summaries/classification, "opus" only for hard reasoning.
- source (collects data without using AI): {"plugin":"…","source":"…","config":{fields},"dataset":"Dataset name","onlyNew":true,"stopIfEmpty":false,"continueOnError":true,"limit":50}. Available sources:
${this.catalog()}
  Prefer a source over an agent with web search whenever one fits (news, Reddit, Hacker News, Google Trends, YouTube, app reviews, RSS, web page changes). Its output is a digest of NEW items plus output.newCount.
- insight: {"dataset":"same dataset name","fields":["sentiment","topics","summary"],"brief":"what we care about","model":"haiku","stopIfEmpty":true} labels new items (fields may also include "relevance","entities","language"). Output: count, avgSentiment (−1..1), negativeShare/positiveShare (0..1), negative, topTopics, mostNegative.
- dataset: {"name":"same dataset name"}: connect it with an edge FROM the dataset TO an agent so the agent can query everything collected so far (stats, search, top items).
- condition (If / Otherwise): {"mode":"rule","rule":{"field":…,"op":…,"value":"…"}} or {"mode":"llm","question":"a yes/no question about the input"}. Rule fields: after an insight: negativeShare or positiveShare (value in percent, e.g. "30"), negative, avgSentiment, count; after one source: newCount; after several sources: newAll; always available: text (op contains | notContains | empty | notEmpty). Number ops: > >= < <= ===. Its outgoing edges MUST have sourceHandle "true" or "false".
- human (the user approves): {"title":"…","instructions":"what to check","onReject":"branch"|"revise","maxRounds":3}. Outgoing edges: sourceHandle "true" (approved) / "false" (rejected). To let rejection send feedback back to an earlier agent, set onReject "revise" and add an edge from the human step to that agent with sourceHandle "revise".
- output (make a file): {"format":"pdf"|"docx"|"pptx"|"xlsx"|"md"|"html"|"csv"|"json"|"txt","fileName":"report-{{today}}","mode":"quick"}. The file travels on to later steps (e.g. email attachments).
- action: email {"action":"email","via":"mail","to":"…","subject":"…","body":"{{input}}","attach":true,"sendNow":false} (sendNow false = a draft in the Mail app for the user to send; true only if they clearly want it sent automatically); save {"action":"save","folder":"~/Documents/…","what":"files"|"text"|"both"}; notify {"action":"notify","title":"…","message":"…"} (a notification on this Mac); http {"action":"http","preset":"slack"|"teams"|"json","url":"…"}.
- memory (notes and documents the AI can search): {"name":"…","scope":"workflow","sources":["folder"],"allowWrite":true,"rememberAnswers":true,"injectNotes":true,"autoRetrieve":0,"reindexBeforeRun":true}; edge FROM memory TO the agent.
- A step with several incoming edges waits for all of them; you never need a merge step.

Text fields may use {{today}}, {{input}} (previous step's output), {{files}}, {{nodes.<id>.output.<field>}} (e.g. {{nodes.label.output.negative}}), {{trigger.payload.path}}.

## Rules
- Exactly one trigger, the first step. Use a schedule when the user says "every…", "daily", "each Monday"; a file trigger when files arrive in a folder; otherwise manual.
- Node ids: short lowercase words (e.g. "daily", "news", "summary"). Every node except the trigger must be reachable from it; stores (dataset, memory) only connect to agents.
- Write agent prompts as clear, complete instructions with the expected format (headings, bullets, length). Put the user's specifics in them.
- ${email ? `The user's own email is ${email}: use it when results go "to me".` : 'If results go to the user by email, ask for their address.'}
- Put anything only the user knows into "questions" (at most 5): email recipients, brand or product names, competitors, folders, account IDs, links. Do not ask for anything already stated. In the node, put a sensible placeholder (e.g. "Acme") and target it with "replace": "Acme"; for a whole field use no replace. Targets: {"node": id, "path": "to" | "cwd" | "config.query" | "config.urls" | "prompt" | "brief" | …}. "@time" as the path sets a schedule's time of day (type "time"). Labels are plain questions ("What's your brand name?"). Give a "default" only for standard values (a time, a country code); never guess folders, email addresses or names.
- "name": a short title (3–6 words). "description": one plain sentence. "notes": short plain-language caveats (keys needed, limits), or "".
- Never ask the AI to do things the app does itself (collecting from supported sources, making files, emailing, scheduling).`;
  }

  private async ask(prompt: string, resume?: string) {
    const res = await this.queue.run(
      // Its own system prompt (no tools, so Claude Code's agent prompt would only cost tokens); kept on disk because fixes resume it.
      () => this.agents.run({ prompt, cwd: WORKSPACE_DIR, model: 'sonnet', tools: [], jsonSchema: SCHEMA, permissionMode: 'dontAsk', systemPrompt: this.systemPrompt(), maxTurns: 4, resumeSessionId: resume }),
      () => undefined,
    );
    if (!res.ok) throw new BadRequestException(res.rateLimited ? 'Claude is at its usage limit right now. Try again after it resets.' : `Claude couldn’t build it: ${res.error ?? 'no answer'}`);
    if (!res.structured || typeof res.structured !== 'object') throw new BadRequestException('Claude didn’t return a workflow. Try describing it a little differently.');
    return res;
  }

  /** Fills defaults, removes anything invalid, converts rules, and lays the steps out. */
  normalize(raw: any): Omit<Draft, 'issues' | 'costUsd'> {
    const ws = tilde(WORKSPACE_DIR);
    const userEmail = loadSettings().userEmail;
    const ids = new Set<string>();
    const nodes: WfNode[] = [];
    const idMap = new Map<string, string>();
    for (const n of Array.isArray(raw.nodes) ? raw.nodes : []) {
      if (!KINDS.includes(n?.kind)) continue;
      let id = slug(String(n.id || n.kind));
      while (ids.has(id)) id = `${id}-2`;
      ids.add(id);
      const d = { ...(n.data ?? {}) };
      let data: Record<string, any> = d;
      switch (n.kind as NodeKind) {
        case 'agent':
        case 'orchestrator':
          data = {
            description: '',
            prompt: '',
            systemPrompt: '',
            model: 'sonnet',
            effort: '',
            outputSchema: '',
            canAsk: false,
            maxQuestions: 3,
            ...d,
            name: slug(String(d.name || id)),
            allowedTools: (Array.isArray(d.allowedTools) ? d.allowedTools : []).filter((t: string) => TOOLS.has(t)),
            disallowedTools: [],
            permissionMode: 'dontAsk', // never anything looser from a generated draft
            cwd: String(d.cwd || ws),
            ...(n.kind === 'orchestrator' ? { parallel: d.parallel !== false } : {}),
          };
          break;
        case 'source': {
          let def;
          try {
            def = this.plugins.source(String(d.plugin), String(d.source)).def;
          } catch {
            continue; // made-up plugin: drop it
          }
          const config: Record<string, unknown> = {};
          for (const f of def.fields) if (f.default !== undefined) config[f.key] = f.default;
          data = { onlyNew: true, stopIfEmpty: false, continueOnError: true, limit: 50, dataset: '', ...d, config: { ...config, ...(d.config ?? {}) } };
          break;
        }
        case 'insight':
          data = { fields: ['sentiment', 'topics', 'summary'], brief: '', custom: '', model: 'haiku', maxItems: 100, stopIfEmpty: false, ...d };
          break;
        case 'condition': {
          if (d.rule && typeof d.rule === 'object') {
            const expression = ruleToExpression(d.rule);
            data = expression ? { mode: 'expression', rule: d.rule, expression } : { mode: 'llm', question: d.question || 'Is this important?', model: 'haiku' };
          } else data = { mode: d.mode === 'llm' ? 'llm' : 'expression', expression: d.expression ?? '', question: d.question ?? '', model: 'haiku' };
          break;
        }
        case 'human':
          data = { title: 'Review', instructions: '', onReject: 'branch', maxRounds: 3, ...d };
          break;
        case 'output':
          data = { fileName: '{{workflow.name}}-{{today}}', folder: '', title: '', mode: 'quick', instructions: '', model: 'sonnet', ...d, format: ['pdf', 'pptx', 'docx', 'xlsx', 'html', 'md', 'csv', 'json', 'txt'].includes(d.format) ? d.format : 'pdf' };
          break;
        case 'action':
          data =
            d.action === 'email'
              ? { via: 'mail', cc: '', subject: '{{workflow.name}}: {{today}}', body: '{{input}}', attach: true, sendNow: false, ...d, to: d.to === '{{me}}' ? userEmail : (d.to ?? '') }
              : d.action === 'save'
                ? { folder: '~/Documents/Agent Canvas', fileName: '', what: 'files', overwrite: false, ...d }
                : d.action === 'http'
                  ? { preset: 'slack', url: '', headers: '', bodyTemplate: '', message: '', ...d }
                  : d.action === 'open'
                    ? d
                    : { title: '{{workflow.name}} finished', message: '', ...d, action: 'notify' };
          break;
        case 'memory':
          data = { name: 'Memory', scope: 'workflow', sources: [], allowWrite: true, rememberAnswers: true, injectNotes: true, autoRetrieve: 0, reindexBeforeRun: true, ...d };
          break;
        case 'trigger.schedule':
          data = d.mode === 'cron' ? { mode: 'cron', cron: String(d.cron || '0 9 * * *'), everyMinutes: 60 } : { mode: 'interval', everyMinutes: Math.max(1, Number(d.everyMinutes) || 60), cron: '0 9 * * *' };
          break;
        case 'trigger.file':
          data = { path: '', events: ['add'], debounceMs: 1500, ...d };
          break;
      }
      idMap.set(String(n.id ?? id), id);
      nodes.push({ id, kind: n.kind, label: n.label ? String(n.label).slice(0, 60) : undefined, position: { x: 0, y: 0 }, data });
    }
    const has = (id: string) => nodes.some((n) => n.id === id);
    const mapId = (id: string) => idMap.get(id) ?? slug(id);
    const edges: WfEdge[] = [];
    for (const e of Array.isArray(raw.edges) ? raw.edges : []) {
      const source = mapId(String(e?.source ?? ''));
      const target = mapId(String(e?.target ?? ''));
      if (!has(source) || !has(target) || source === target) continue;
      const handle = ['true', 'false', 'revise', 'team'].includes(e.sourceHandle) ? e.sourceHandle : null;
      if (edges.some((x) => x.source === source && x.target === target && x.sourceHandle === handle)) continue;
      edges.push({ id: `${source}-${handle ?? 'out'}-${target}`, source, target, sourceHandle: handle });
    }
    const questions: SetupQuestion[] = (Array.isArray(raw.questions) ? raw.questions : []).slice(0, 6).map((q: any, i: number) => ({
      id: slug(String(q.id || `q${i}`)),
      label: String(q.label || 'Question'),
      help: q.help ? String(q.help) : undefined,
      placeholder: q.placeholder ? String(q.placeholder) : undefined,
      type: ['text', 'email', 'folder', 'list', 'time', 'number', 'url'].includes(q.type) ? q.type : 'text',
      default: q.type === 'email' && !q.default && userEmail ? userEmail : q.default ? String(q.default) : undefined,
      required: !!q.required,
      targets: (Array.isArray(q.targets) ? q.targets : []).map((t: any) => ({ ...t, node: mapId(String(t.node)) })).filter((t: any) => has(t.node) && typeof t.path === 'string'),
    })).filter((q: SetupQuestion) => q.targets.length);
    layout(nodes, edges);
    return { name: String(raw.name || 'New automation').slice(0, 80), description: String(raw.description || ''), notes: raw.notes ? String(raw.notes) : undefined, nodes, edges, questions };
  }

  private issues(d: Omit<Draft, 'issues' | 'costUsd'>) {
    // Validate as if every question were answered: missing answers aren't the draft's fault.
    const nodes = applyAnswers(d.nodes, d.questions, dummyAnswers(d.questions));
    const now = new Date().toISOString();
    return validateWorkflow({ id: 'draft', name: d.name, enabled: false, webhookToken: '', nodes, edges: d.edges, createdAt: now, updatedAt: now }).map((i) => i.message);
  }

  async draft(input: { description: string; previous?: Draft; change?: string }): Promise<Draft> {
    const description = String(input.description ?? '').trim();
    if (description.length < 8) throw new BadRequestException('Describe what it should do in a sentence or two.');
    const prompt =
      input.previous && input.change?.trim()
        ? `The user asked for: ${description}\n\nThis is the current workflow:\n${JSON.stringify({ ...input.previous, issues: undefined, costUsd: undefined })}\n\nChange it as follows, keeping everything else: ${input.change.trim()}\n\nReturn the complete updated workflow.`
        : `Build a workflow for this request:\n\n${description}`;
    let res = await this.ask(prompt);
    let cost = res.costUsd;
    let draft = this.normalize(res.structured);
    let issues = this.issues(draft);
    if (issues.length) {
      this.logger.log(`Draft had ${issues.length} issue(s); asking for a fix: ${issues.join(' | ')}`);
      res = await this.ask(`That workflow has these problems:\n${issues.map((i) => `- ${i}`).join('\n')}\n\nReturn the complete corrected workflow.`, res.sessionId);
      cost += res.costUsd;
      draft = this.normalize(res.structured);
      issues = this.issues(draft);
    }
    if (!draft.nodes.some((n) => n.kind.startsWith('trigger.'))) throw new BadRequestException('Claude’s design had no starting point. Try again with a bit more detail.');
    return { ...draft, issues, costUsd: cost };
  }
}

/** Left-to-right by depth from the trigger; stores above their agent; team members below their lead. */
export function layout(nodes: WfNode[], edges: WfEdge[]) {
  const flow = edges.filter((e) => e.sourceHandle !== 'revise' && e.sourceHandle !== 'team');
  const stores = new Set(nodes.filter((n) => n.kind === 'memory' || n.kind === 'dataset').map((n) => n.id));
  const workers = new Set(edges.filter((e) => e.sourceHandle === 'team').map((e) => e.target));
  const depth = new Map<string, number>();
  const visit = (id: string, d: number, seen: Set<string>) => {
    if (seen.has(id) || (depth.get(id) ?? -1) >= d) return;
    depth.set(id, d);
    seen.add(id);
    for (const e of flow) if (e.source === id && !stores.has(e.source)) visit(e.target, d + 1, seen);
    seen.delete(id);
  };
  for (const t of nodes.filter((n) => n.kind.startsWith('trigger.'))) visit(t.id, 0, new Set());
  const byDepth = new Map<number, WfNode[]>();
  for (const n of nodes) {
    if (stores.has(n.id) || workers.has(n.id)) continue;
    const d = depth.get(n.id) ?? 0;
    byDepth.set(d, [...(byDepth.get(d) ?? []), n]);
  }
  for (const [d, list] of byDepth) list.forEach((n, i) => (n.position = { x: d * 300, y: (i - (list.length - 1) / 2) * 170 }));
  const placedAbove = new Map<string, number>();
  for (const n of nodes.filter((x) => stores.has(x.id))) {
    const target = nodes.find((x) => x.id === edges.find((e) => e.source === n.id)?.target);
    const k = placedAbove.get(target?.id ?? '') ?? 0;
    placedAbove.set(target?.id ?? '', k + 1);
    n.position = { x: (target?.position.x ?? 0) + k * 220, y: (target?.position.y ?? 0) - 190 };
  }
  const leads = new Map<string, number>();
  for (const e of edges.filter((x) => x.sourceHandle === 'team')) {
    const lead = nodes.find((x) => x.id === e.source);
    const w = nodes.find((x) => x.id === e.target);
    if (!lead || !w) continue;
    const k = leads.get(lead.id) ?? 0;
    leads.set(lead.id, k + 1);
    w.position = { x: lead.position.x - 150 + k * 300, y: lead.position.y + 230 };
  }
}
