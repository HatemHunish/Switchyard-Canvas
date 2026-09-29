import type { PluginInfo } from '../api';
import type { NodeKind } from '../types';
import { pluginById, sourceDef, sourceDefaults } from './plugins';
import { capsText, qualityLabel, ruleText, scheduleText } from './plain';

export interface KindMeta {
  /** Palette entry id; several entries can share a kind (e.g. the action types). */
  key: string;
  kind: NodeKind;
  title: string;
  icon: string;
  group: 'Triggers' | 'Sources' | 'Steps' | 'People' | 'Context' | 'Logic' | 'Output' | 'Actions';
  hint: string;
  color: string;
  defaults: () => Record<string, any>;
  /** Plain name and hint for Simple mode. */
  simple?: { title: string; hint: string };
  /** Hidden from the palette in Simple mode. */
  advancedOnly?: boolean;
}

export const KINDS: KindMeta[] = [
  {
    key: 'trigger.manual',
    simple: { title: "Run button", hint: "Start it yourself, whenever you want" },
    kind: 'trigger.manual',
    title: 'Manual',
    icon: '▶',
    group: 'Triggers',
    hint: 'Start with the Run button',
    color: 'var(--c-trigger)',
    defaults: () => ({}),
  },
  {
    key: 'trigger.schedule',
    simple: { title: "On a schedule", hint: "Every morning, every hour, every Monday…" },
    kind: 'trigger.schedule',
    title: 'Schedule',
    icon: '⏱',
    group: 'Triggers',
    hint: 'Monitor: run every N minutes or on a cron',
    color: 'var(--c-trigger)',
    defaults: () => ({ mode: 'interval', everyMinutes: 15, cron: '0 9 * * 1-5' }),
  },
  {
    key: 'trigger.file',
    simple: { title: "When a file arrives", hint: "Start when a file is added or changed in a folder" },
    kind: 'trigger.file',
    title: 'File watch',
    icon: '📁',
    group: 'Triggers',
    hint: 'Run when files appear or change',
    color: 'var(--c-trigger)',
    defaults: () => ({ path: '', events: ['add', 'change'], debounceMs: 1000 }),
  },
  {
    key: 'trigger.webhook',
    advancedOnly: true,
    kind: 'trigger.webhook',
    title: 'Webhook',
    icon: '⚡',
    group: 'Triggers',
    hint: 'Run when something POSTs to a URL',
    color: 'var(--c-trigger)',
    defaults: () => ({}),
  },
  {
    key: 'agent',
    simple: { title: "AI step", hint: "Claude does a task: write, research, summarise, analyse" },
    kind: 'agent',
    title: 'Agent',
    icon: '✦',
    group: 'Steps',
    hint: 'One Claude Code run with its own prompt and tools',
    color: 'var(--c-agent)',
    defaults: () => ({
      name: 'new-agent',
      description: '',
      prompt: '',
      systemPrompt: '',
      model: 'sonnet',
      effort: '',
      allowedTools: ['Read', 'Grep', 'Glob'],
      disallowedTools: [],
      permissionMode: 'dontAsk',
      cwd: '~',
      outputSchema: '',
      canAsk: false,
      maxQuestions: 3,
    }),
  },
  {
    key: 'orchestrator',
    simple: { title: "AI team", hint: "Claude splits a big task between helper steps" },
    kind: 'orchestrator',
    title: 'Orchestrator',
    icon: '⎈',
    group: 'Steps',
    hint: 'Gets a task and decides which team agents to use',
    color: 'var(--c-orch)',
    defaults: () => ({
      name: 'orchestrator',
      description: '',
      prompt: '',
      systemPrompt: '',
      model: 'sonnet',
      effort: '',
      allowedTools: [],
      disallowedTools: [],
      permissionMode: 'dontAsk',
      cwd: '~',
      outputSchema: '',
      canAsk: true,
      maxQuestions: 3,
      parallel: true,
    }),
  },
  {
    key: 'insight',
    simple: { title: "Label mentions", hint: "Mark each new item positive or negative, with topics" },
    kind: 'insight',
    title: 'Insight',
    icon: '💡',
    group: 'Steps',
    hint: 'Label new items: sentiment, topics, relevance…',
    color: 'var(--c-insight)',
    defaults: () => ({ dataset: '', fields: ['sentiment', 'topics', 'summary'], brief: '', custom: '', model: 'haiku', maxItems: 100, stopIfEmpty: false }),
  },
  {
    key: 'human',
    simple: { title: "Ask me to approve", hint: "Pause until you approve it or give feedback" },
    kind: 'human',
    title: 'Human review',
    icon: '👤',
    group: 'People',
    hint: 'Pause for your approval or feedback',
    color: 'var(--c-human)',
    defaults: () => ({ title: 'Review', instructions: '', onReject: 'branch', maxRounds: 3, timeoutMinutes: undefined }),
  },
  {
    key: 'memory',
    simple: { title: "Notes & documents", hint: "Things the AI should know, and remembers for next time" },
    kind: 'memory',
    title: 'Memory',
    icon: '🧠',
    group: 'Context',
    hint: 'Notes + documents (RAG) that agents search and save to',
    color: 'var(--c-memory)',
    defaults: () => ({
      name: 'Memory',
      scope: 'workflow',
      sources: [],
      allowWrite: true,
      rememberAnswers: true,
      injectNotes: true,
      autoRetrieve: 0,
      reindexBeforeRun: true,
    }),
  },
  {
    key: 'dataset',
    simple: { title: "Collected data", hint: "Let an AI step analyse what your sources collected" },
    kind: 'dataset',
    title: 'Dataset',
    icon: '🗂️',
    group: 'Context',
    hint: 'Collected media agents can search and analyse',
    color: 'var(--c-dataset)',
    defaults: () => ({ name: 'Dataset' }),
  },
  {
    key: 'condition',
    simple: { title: "If / Otherwise", hint: "Go one way or another depending on the result" },
    kind: 'condition',
    title: 'Condition',
    icon: '◇',
    group: 'Logic',
    hint: 'Branch on a rule or a yes/no question',
    color: 'var(--c-logic)',
    defaults: () => ({ mode: 'expression', expression: "output.severity === 'high'", question: '', model: 'haiku' }),
  },
  {
    key: 'merge',
    advancedOnly: true,
    kind: 'merge',
    title: 'Merge',
    icon: '⋈',
    group: 'Logic',
    hint: 'Wait for parallel branches, then continue',
    color: 'var(--c-logic)',
    defaults: () => ({ mode: 'all' }),
  },
  {
    key: 'output',
    simple: { title: "Make a file", hint: "Turn the result into a PDF, Word, PowerPoint, Excel…" },
    kind: 'output',
    title: 'Output file',
    icon: '📄',
    group: 'Output',
    hint: 'Turn the result into PDF, PowerPoint, Word, Excel…',
    color: 'var(--c-output)',
    defaults: () => ({ format: 'pdf', fileName: '{{workflow.name}}-{{today}}', folder: '', title: '', mode: 'quick', instructions: '', model: 'sonnet' }),
  },
  {
    key: 'action.save',
    kind: 'action',
    title: 'Save to folder',
    icon: '💾',
    group: 'Actions',
    hint: 'Copy the files (or text) to a folder',
    color: 'var(--c-action)',
    defaults: () => ({ action: 'save', folder: '~/Documents/Agent Canvas', fileName: '', what: 'files', overwrite: false }),
  },
  {
    key: 'action.email',
    kind: 'action',
    title: 'Send email',
    icon: '✉️',
    group: 'Actions',
    hint: 'Email the result with files attached',
    color: 'var(--c-action)',
    defaults: () => ({ action: 'email', via: 'mail', to: '', cc: '', subject: '{{workflow.name}}: {{today}}', body: '{{input}}', attach: true, sendNow: false }),
  },
  {
    key: 'action.http',
    kind: 'action',
    title: 'Slack / Teams / Webhook',
    icon: '🔗',
    group: 'Actions',
    hint: 'POST the result to a URL',
    color: 'var(--c-action)',
    defaults: () => ({ action: 'http', preset: 'slack', url: '', headers: '', bodyTemplate: '', message: '' }),
  },
  {
    key: 'action.notify',
    kind: 'action',
    title: 'Notify me',
    icon: '🔔',
    group: 'Actions',
    hint: 'Show a desktop notification',
    color: 'var(--c-action)',
    defaults: () => ({ action: 'notify', title: '{{workflow.name}} finished', message: '' }),
  },
  {
    key: 'action.open',
    advancedOnly: true,
    kind: 'action',
    title: 'Open file',
    icon: '↗',
    group: 'Actions',
    hint: 'Open the produced file on this Mac',
    color: 'var(--c-action)',
    defaults: () => ({ action: 'open' }),
  },
];

export const FORMATS: Array<{ value: string; label: string }> = [
  { value: 'pdf', label: 'PDF' },
  { value: 'pptx', label: 'PowerPoint (.pptx)' },
  { value: 'docx', label: 'Word (.docx)' },
  { value: 'xlsx', label: 'Excel (.xlsx)' },
  { value: 'html', label: 'Web page (.html)' },
  { value: 'md', label: 'Markdown (.md)' },
  { value: 'csv', label: 'CSV' },
  { value: 'json', label: 'JSON' },
  { value: 'txt', label: 'Plain text' },
];
const formatLabel = (f: string) => FORMATS.find((x) => x.value === f)?.label.replace(/ \(.*\)$/, '') ?? f;

/** Fallback for a source whose plugin isn't installed (or not loaded yet). */
const SOURCE_META: KindMeta = {
  key: 'source',
  kind: 'source',
  title: 'Source',
  icon: '📥',
  group: 'Sources',
  hint: 'Collect items from a plugin',
  color: 'var(--c-source)',
  defaults: () => ({ plugin: '', source: '', config: {}, dataset: '', onlyNew: true, stopIfEmpty: false, continueOnError: true, limit: 100 }),
};

/** Palette entries for every source of an enabled plugin (key "source:<plugin>.<source>"). */
export function sourceKinds(plugins: PluginInfo[]): KindMeta[] {
  return plugins
    .filter((p) => p.enabled)
    .flatMap((p) =>
      (p.sources ?? []).map((def) => ({
        ...SOURCE_META,
        key: `source:${p.id}.${def.id}`,
        title: def.title,
        icon: p.icon || SOURCE_META.icon,
        hint: def.hint || p.description || '',
        defaults: () => ({ ...SOURCE_META.defaults(), plugin: p.id, source: def.id, config: sourceDefaults(def) }),
      })),
    );
}

export const metaByKey = (key: string): KindMeta | undefined => {
  if (key.startsWith('source:')) {
    const [plugin, source] = key.slice(7).split('.');
    const { plugin: p, def } = sourceDef(plugin, source);
    return p && def ? sourceKinds([{ ...p, enabled: true, sources: [def] }])[0] : undefined;
  }
  return KINDS.find((k) => k.key === key);
};

/** Palette metadata for a node; action nodes are looked up by their action type, sources by plugin. */
export const metaOf = (kind: string, data?: Record<string, any>): KindMeta => {
  if (kind === 'source') return (data?.plugin && metaByKey(`source:${data.plugin}.${data.source}`)) || { ...SOURCE_META, icon: pluginById(data?.plugin)?.icon ?? SOURCE_META.icon };
  return (kind === 'action' && data?.action ? metaByKey(`action.${data.action}`) : undefined) ?? KINDS.find((k) => k.kind === kind) ?? KINDS.find((k) => k.kind === 'agent')!;
};

/** Stores wired into an agent's top socket (not flow steps). */
export const isStore = (kind: string) => kind === 'memory' || kind === 'dataset';

/** Agent-like nodes: run Claude with a prompt, tools, memory and a session. */
export const isAgentLike = (kind: string) => kind === 'agent' || kind === 'orchestrator';

/** Nodes with yes/no outputs. */
export const isBranching = (kind: string) => kind === 'condition' || kind === 'human';

export const isTrigger = (kind: string) => kind.startsWith('trigger.');

export function subtitle(kind: string, data: Record<string, any>, simple = false): string {
  if (simple) {
    switch (kind) {
      case 'trigger.schedule':
        return scheduleText(data);
      case 'agent':
        return `${qualityLabel(data.model)} · ${capsText(data.allowedTools)}${data.canAsk ? ' · can ask you' : ''}`;
      case 'orchestrator':
        return `${qualityLabel(data.model)} · leads a team`;
      case 'condition':
        return data.mode === 'llm' ? `Asks: ${data.question || '…'}` : data.rule ? ruleText(data.rule) : 'custom rule';
      case 'human':
        return data.onReject === 'revise' ? 'you approve or send it back' : 'you approve or reject';
    }
  }
  switch (kind) {
    case 'trigger.schedule':
      return data.mode === 'cron' ? `cron ${data.cron}` : `every ${data.everyMinutes} min`;
    case 'trigger.file':
      return data.path || 'no path set';
    case 'trigger.webhook':
      return 'POST /api/hooks/…';
    case 'trigger.manual':
      return 'Run button';
    case 'agent':
      return [data.model, data.allowedTools?.length ? `${data.allowedTools.length} tools` : 'no tools', data.canAsk ? 'can ask you' : ''].filter(Boolean).join(' · ');
    case 'orchestrator':
      return [data.model, data.parallel ? 'parallel' : 'one at a time', data.canAsk ? 'can ask you' : ''].filter(Boolean).join(' · ');
    case 'condition':
      return data.mode === 'llm' ? `asks: ${data.question || '…'}` : data.expression || '…';
    case 'merge':
      return data.mode === 'any' ? 'first branch wins' : 'wait for all';
    case 'memory':
      return [
        data.sources?.length ? `${data.sources.length} source${data.sources.length > 1 ? 's' : ''}` : 'notes only',
        data.scope === 'shared' ? 'shared' : '',
        data.rememberAnswers ? 'remembers answers' : '',
      ]
        .filter(Boolean)
        .join(' · ');
    case 'output':
      return `${formatLabel(data.format)} · ${data.mode === 'claude' ? 'designed by Claude' : 'quick convert'}`;
    case 'action':
      switch (data.action) {
        case 'save':
          return data.folder || 'no folder set';
        case 'email':
          return `${data.to || 'no recipient'} · ${data.via === 'smtp' ? 'SMTP' : data.sendNow ? 'Mail.app, send' : 'Mail.app draft'}`;
        case 'http':
          return data.url ? `${data.preset ?? 'json'} · ${data.url.replace(/^https?:\/\//, '').split('/')[0]}` : 'no URL set';
        case 'notify':
          return data.title || 'desktop notification';
        case 'open':
          return 'opens the file';
        default:
          return '';
      }
    case 'human':
      return data.onReject === 'revise' ? `reject → revise (max ${data.maxRounds || 3})` : 'approve / reject';
    case 'source': {
      const { plugin, def } = sourceDef(data.plugin, data.source);
      if (!plugin) return `plugin "${data.plugin}" not installed`;
      const first = def?.fields.find((f) => f.required) ?? def?.fields[0];
      const v = first ? data.config?.[first.key] : undefined;
      const shown = Array.isArray(v) ? v.join(', ') : v != null && v !== '' ? String(v) : '';
      return [shown || (first?.required ? `set ${first.label.toLowerCase()}` : plugin.name), `→ ${data.dataset?.trim() || 'workflow dataset'}`].join(' ');
    }
    case 'dataset':
      return 'agents can search it';
    case 'insight':
      return `${(data.fields ?? []).join(', ') || 'no fields'} · ${data.model || 'haiku'}`;
    default:
      return '';
  }
}

/** Palette group names in Simple mode. */
export const SIMPLE_GROUPS: Record<string, string> = {
  Triggers: 'Start',
  Sources: 'Collect',
  Steps: 'AI',
  People: 'You',
  Context: 'Knowledge',
  Logic: 'Decide',
  Output: 'Files',
  Actions: 'Then',
};

export const COMMON_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'Bash(git *)', 'WebFetch', 'WebSearch'];
export const MODELS = ['haiku', 'sonnet', 'opus', 'fable'];
