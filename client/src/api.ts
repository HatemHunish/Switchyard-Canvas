import type { DatasetItem, SetupQuestion, HumanRequest, HumanResponse, Item, MemoryItem, MemoryStats, NodeRun, NotifyConfig, Run, UsageInfo, WfEdge, WfNode, Workflow } from './types';

export interface ValidationIssue {
  nodeId?: string;
  message: string;
}

export interface TriggerStatus {
  nodeId: string;
  kind: string;
  armed: boolean;
  nextRunAt?: number;
  lastFiredAt?: number;
  lastSkippedAt?: number;
  error?: string;
}

export type WorkflowView = Workflow & { issues: ValidationIssue[]; triggers: TriggerStatus[] };

export interface TemplateInfo {
  key: string;
  name: string;
  description: string;
  pattern: 'monitor' | 'triggered' | 'pipeline' | 'human' | 'memory' | 'orchestrator' | 'output' | 'insights' | 'plugin';
  nodeCount: number;
  setup?: SetupQuestion[];
  nodes: WfNode[];
  edges: WfEdge[];
}

export interface Draft {
  name: string;
  description: string;
  notes?: string;
  nodes: WfNode[];
  edges: WfEdge[];
  questions: SetupQuestion[];
  issues: string[];
  costUsd: number;
}

export interface PluginField {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'select' | 'list' | 'boolean';
  required?: boolean;
  placeholder?: string;
  help?: string;
  default?: unknown;
  options?: Array<string | { value: string; label: string }>;
}

export interface PluginSource {
  id: string;
  title: string;
  hint?: string;
  kind?: string;
  fields: PluginField[];
  needs?: string[];
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  icon?: string;
  description?: string;
  notice?: string;
  homepage?: string;
  credentials?: Array<{ key: string; label: string; optional?: boolean; help?: string; placeholder?: string }>;
  sources?: PluginSource[];
  tools?: Array<{ name: string; description: string }>;
  insights?: Array<{ title: string; panel: string }>;
  builtin: boolean;
  dir?: string;
  enabled: boolean;
  error?: string;
  hasCode: boolean;
  credentialsSet: Record<string, boolean>;
}

export interface PluginList {
  plugins: PluginInfo[];
  failures: Array<{ dir: string; error: string }>;
  folder: string;
}

export interface PluginTool {
  name: string;
  description: string;
  plugin: string;
  pluginName: string;
  icon?: string;
}

export interface SourcePreview {
  ok: boolean;
  count?: number;
  items?: Item[];
  points?: number;
  note?: string;
  error?: string;
  log: string[];
  ms: number;
}

export interface DatasetInfo {
  id: string;
  name: string;
  createdAt: number;
  items: number;
  lastItemAt?: number;
  series: number;
  sources: string[];
}

export interface DatasetInsights {
  kpis: { items: number; newToday: number; avgSentiment: number | null; negative: number; labelled: number; engagement: number; previous?: number };
  bySource: Array<{ source: string; n: number }>;
  volume: Array<{ day: string; source: string; n: number }>;
  sentiment: Array<{ day: string; pos: number; neg: number; neutral: number; avg: number }>;
  topics: Array<{ topic: string; n: number; avg: number | null }>;
  authors: Array<{ author: string; n: number; engagement: number }>;
  top: Array<DatasetItem & { engagement: number }>;
  feeds: Array<{ source: string; feed: string; label?: string; n: number }>;
  series: Array<{ source: string; series: string; points: Array<{ t: number; value: number }> }>;
  panels: Array<{ title: string; panel: 'top' | 'timeseries'; by?: string; series?: string; plugin: string; pluginName: string; icon?: string; rows?: Array<{ name: string; n: number }> }>;
}

export interface ItemQuery {
  q?: string;
  range?: string;
  source?: string;
  feed?: string;
  sentiment?: 'neg' | 'pos' | 'neutral';
  sort?: 'recent' | 'engagement';
  limit?: number;
  offset?: number;
}

export interface ClaudeStatus {
  installed: boolean;
  version?: string;
  loggedIn?: boolean;
  authMethod?: string;
  subscriptionType?: string;
  error?: string;
}

export interface Settings {
  concurrency: number;
  claudeBin: string;
  rateLimitRetryMs: number;
  desktopNotifications: boolean;
  outputsDir: string;
  chromePath: string;
  publicUrl: string;
  smtp: { host: string; port: number; secure: boolean; user: string; from: string };
  hasSmtpPassword?: boolean;
  detectedChrome?: string | null;
  uiMode: 'simple' | 'advanced';
  setupDone: boolean;
  userEmail: string;
  /** Private folder new AI steps use by default. */
  workspaceDir?: string;
}

export interface SetupJob {
  kind: 'install' | 'login' | null;
  log?: string[];
  running?: boolean;
  exitCode?: number | null;
}

// ---- dashboard ----
export interface DashKpis {
  running: number;
  waiting: number;
  runsToday: number;
  runsTrend: number[];
  successRate7d: number | null;
  successRatePrev7d: number | null;
  failed24h: number;
  next: { at: number; workflowId: string; workflowName: string } | null;
  usage: UsageInfo | null;
  cost7d: number;
  queue: { active: number; waiting: number; limit: number };
  enabledWorkflows: number;
  workflows: number;
}
export interface AttentionItem {
  level: 'warning' | 'critical';
  kind: string;
  text: string;
  workflowId?: string;
  runId?: string;
  nodeId?: string;
}
export interface HealthRow {
  id: string;
  name: string;
  enabled: boolean;
  issues: number;
  runs: number;
  success: number;
  failed: number;
  cost: number;
  avgMs: number | null;
  lastAt: number | null;
  recent: Array<{ id: string; status: string; at: number }>;
  nextRun: number | null;
  trigger: 'schedule' | 'listening' | 'manual';
}
export interface DashSummary {
  kpis: DashKpis;
  attention: AttentionItem[];
  health: HealthRow[];
  series: Array<{ day: string; success: number; failed: number; cancelled: number; running: number; cost: number }>;
  topErrors: Array<{ message: string; count: number; lastAt: number; workflowId: string; workflowName: string; runId: string; nodeId: string }>;
  range: string;
}
export interface LiveRun {
  run: Run;
  steps: Array<{ id: string; kind: string; name: string; status: string; startedAt?: number; finishedAt?: number }>;
  workers: Array<{ id: string; lead: string; name: string; status: string; startedAt?: number; finishedAt?: number }>;
}
export interface UpcomingItem {
  workflowId: string;
  workflowName: string;
  nodeId: string;
  kind: string;
  detail: string;
  enabled: boolean;
  times: number[];
  next?: number;
  lastFiredAt?: number;
  lastSkippedAt?: number;
  error?: string;
}
export interface FileRow {
  id: string;
  path: string;
  name: string;
  format: string;
  bytes: number;
  createdAt: number;
  runId: string;
  nodeId: string;
  workflowId: string;
  workflowName: string;
}
export type RunRow = Run & { fileCount: number; waiting: boolean };
export interface RunFilters {
  range?: string;
  status?: string;
  trigger?: string;
  workflowId?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public issues: ValidationIssue[] = [],
  ) {
    super(message);
  }
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = data?.message;
    if (msg && typeof msg === 'object') throw new ApiError(msg.message ?? 'Request failed', msg.issues ?? []);
    throw new ApiError(Array.isArray(msg) ? msg.join(', ') : msg || res.statusText, data?.issues ?? []);
  }
  return data as T;
}

export const api = {
  listWorkflows: () => req<WorkflowView[]>('GET', '/api/workflows'),
  getWorkflow: (id: string) => req<WorkflowView>('GET', `/api/workflows/${id}`),
  createWorkflow: (body: Partial<Workflow>) => req<WorkflowView>('POST', '/api/workflows', body),
  saveWorkflow: (id: string, body: { name?: string; description?: string; nodes?: WfNode[]; edges?: WfEdge[]; enabled?: boolean }) =>
    req<WorkflowView>('PUT', `/api/workflows/${id}`, body),
  deleteWorkflow: (id: string) => req<{ deleted: boolean }>('DELETE', `/api/workflows/${id}`),
  runWorkflow: (id: string, triggerNodeId?: string, payload?: unknown) => req<Run>('POST', `/api/workflows/${id}/run`, { triggerNodeId, payload }),
  exportAgents: (id: string, dir: string) => req<{ directory: string; files: string[] }>('POST', `/api/workflows/${id}/export`, { dir }),
  templates: () => req<TemplateInfo[]>('GET', '/api/templates'),
  fromTemplate: (key: string, answers?: Record<string, string>) => req<WorkflowView>('POST', `/api/templates/${encodeURIComponent(key)}`, { answers }),
  draftWorkflow: (description: string, previous?: Draft, change?: string) => req<Draft>('POST', '/api/assistant/draft', { description, previous, change }),
  createFromDraft: (draft: Draft, answers: Record<string, string>) => req<WorkflowView>('POST', '/api/assistant/create', { draft, answers }),
  runs: (workflowId: string) => req<Run[]>('GET', `/api/runs?workflowId=${workflowId}`),
  run: (id: string) => req<{ run: Run; nodes: NodeRun[]; requests: HumanRequest[] }>('GET', `/api/runs/${id}`),
  inbox: () => req<HumanRequest[]>('GET', '/api/inbox'),
  respond: (id: string, r: HumanResponse) => req<HumanRequest>('POST', `/api/inbox/${id}/respond`, r),
  memory: (wf: string, node: string, q?: string) =>
    req<{ stats: MemoryStats; items: MemoryItem[] }>('GET', `/api/workflows/${wf}/memory/${node}${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  addNote: (wf: string, node: string, key: string, content: string) => req<MemoryItem>('POST', `/api/workflows/${wf}/memory/${node}/notes`, { key, content }),
  deleteMemoryItem: (wf: string, node: string, id: number) => req<{ deleted: boolean }>('DELETE', `/api/workflows/${wf}/memory/${node}/items/${id}`),
  clearMemory: (wf: string, node: string, kind?: 'note' | 'chunk') => req<{ cleared: boolean }>('POST', `/api/workflows/${wf}/memory/${node}/clear`, { kind }),
  indexMemory: (wf: string, node: string) =>
    req<{ files: number; added: number; updated: number; removed: number; skipped: number; stats: MemoryStats }>('POST', `/api/workflows/${wf}/memory/${node}/index`),
  openFile: (id: string, how: 'open' | 'reveal') => req<{ ok: boolean }>('POST', `/api/files/${id}/${how}`),
  saveSmtpPassword: (password: string) => req<{ saved: boolean }>('PUT', '/api/system/smtp-password', { password }),
  testEmail: (to: string, via: 'mail' | 'smtp') => req<{ ok: boolean; summary: string }>('POST', '/api/system/test-email', { to, via }),
  dashboard: (range: string, workflowId?: string) => req<DashSummary>('GET', `/api/dashboard/summary?range=${range}${workflowId ? `&workflowId=${workflowId}` : ''}`),
  live: () => req<LiveRun[]>('GET', '/api/dashboard/live'),
  upcoming: (hours = 24) => req<UpcomingItem[]>('GET', `/api/dashboard/upcoming?hours=${hours}`),
  latestFiles: (limit = 8) => req<FileRow[]>('GET', `/api/dashboard/files?limit=${limit}`),
  runHistory: (f: RunFilters) =>
    req<{ total: number; runs: RunRow[] }>(
      'GET',
      `/api/dashboard/runs?${new URLSearchParams(Object.entries(f).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)])).toString()}`,
    ),
  pauseAll: () => req<{ paused: number; cancelled: number }>('POST', '/api/dashboard/pause-all'),
  resumeAll: () => req<{ resumed: number }>('POST', '/api/dashboard/resume-all'),
  pausedIds: () => req<{ ids: string[] }>('GET', '/api/dashboard/paused'),
  testNotify: (notify: NotifyConfig, kind: 'review' | 'question') => req<{ results: Array<{ text: string; ok: boolean }> }>('POST', '/api/inbox/test-notify', { notify, kind }),
  cancelRun: (id: string) => req<{ cancelled: boolean }>('POST', `/api/runs/${id}/cancel`),
  claude: (refresh = false) => req<ClaudeStatus>('GET', `/api/system/claude${refresh ? '?refresh=1' : ''}`),
  usage: () => req<{ usage: UsageInfo | null; queue: { active: number; waiting: number; limit: number } }>('GET', '/api/system/usage'),
  settings: () => req<Settings>('GET', '/api/system/settings'),
  installClaude: () => req<{ started: boolean }>('POST', '/api/system/claude/install'),
  loginClaude: (email?: string) => req<{ started: boolean }>('POST', '/api/system/claude/login', { email }),
  setupJob: () => req<SetupJob>('GET', '/api/system/claude/job'),
  cancelSetupJob: () => req<{ cancelled: boolean }>('POST', '/api/system/claude/job/cancel'),
  chooseFolder: (prompt?: string) => req<{ path: string | null }>('POST', '/api/system/choose-folder', { prompt }),
  quit: () => req<{ quitting: boolean }>('POST', '/api/system/quit'),
  appInfo: () => req<{ bundled: boolean; loginItem: boolean }>('GET', '/api/system/app'),
  setLoginItem: (enabled: boolean) => req<{ loginItem: boolean }>('PUT', '/api/system/login-item', { enabled }),
  plugins: () => req<PluginList>('GET', '/api/plugins'),
  setPluginEnabled: (id: string, enabled: boolean) => req<{ enabled: boolean }>('PUT', `/api/plugins/${id}`, { enabled }),
  savePluginCredentials: (id: string, values: Record<string, string>) => req<{ credentialsSet: Record<string, boolean> }>('PUT', `/api/plugins/${id}/credentials`, { values }),
  testPlugin: (id: string) => req<{ ok: boolean; text: string }>('POST', `/api/plugins/${id}/test`),
  reloadPlugins: () => req<PluginList>('POST', '/api/plugins/reload'),
  openPluginsFolder: () => req<{ opened: string }>('POST', '/api/plugins/open-folder'),
  previewSource: (body: { plugin: string; source: string; config: Record<string, unknown>; workflowId?: string; nodeId?: string }) => req<SourcePreview>('POST', '/api/plugins/preview', body),
  pluginTools: () => req<PluginTool[]>('GET', '/api/plugins/tools'),
  datasets: () => req<DatasetInfo[]>('GET', '/api/datasets'),
  datasetInsights: (id: string, range: string, source?: string) =>
    req<DatasetInsights>('GET', `/api/datasets/${encodeURIComponent(id)}/insights?range=${range}${source ? `&source=${encodeURIComponent(source)}` : ''}`),
  datasetItems: (id: string, q: ItemQuery) =>
    req<{ total: number; items: DatasetItem[] }>(
      'GET',
      `/api/datasets/${encodeURIComponent(id)}/items?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)])).toString()}`,
    ),
  deleteDataset: (id: string) => req<{ deleted: boolean }>('DELETE', `/api/datasets/${encodeURIComponent(id)}`),
  saveSettings: (s: Partial<Settings>) => req<Settings>('PUT', '/api/system/settings', s),
};
