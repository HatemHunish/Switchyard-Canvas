// Mirror of src/common/types.ts on the server — keep them in sync.

export type TriggerKind =
  | 'trigger.manual'
  | 'trigger.schedule'
  | 'trigger.file'
  | 'trigger.webhook';

export type NodeKind = TriggerKind | 'agent' | 'orchestrator' | 'condition' | 'merge' | 'human' | 'memory' | 'output' | 'action' | 'source' | 'dataset' | 'insight';

export type PermissionMode =
  | 'dontAsk'
  | 'acceptEdits'
  | 'auto'
  | 'plan'
  | 'bypassPermissions';

export type AgentProvider = 'claude' | 'codex';

export interface AgentData {
  name: string;
  /** Agent runtime: Claude (Agent SDK) or OpenAI Codex. Default 'claude'. */
  provider?: AgentProvider;
  description?: string;
  /** Task prompt; supports {{input}}, {{trigger.payload}}, {{nodes.<id>.output}}, {{date}}. */
  prompt: string;
  /** Appended to Claude Code's default system prompt (the agent's "persona"). */
  systemPrompt?: string;
  model: string;
  effort?: '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  allowedTools: string[];
  disallowedTools: string[];
  permissionMode: PermissionMode;
  /** Working directory the CLI runs in. Required. */
  cwd: string;
  /** Optional JSON Schema (as text) forcing structured output. */
  outputSchema?: string;
  /** Only used when exporting to .claude/agents/*.md. */
  maxTurns?: number;
  /** Let the agent pause and ask the user a question (answered in the app, then the session resumes). */
  canAsk?: boolean;
  maxQuestions?: number;
  /** Tell someone when this agent asks a question. */
  askNotify?: NotifyConfig;
  /** Plugin tools this agent may call (names from the plugins' manifests). */
  pluginTools?: string[];
}

/**
 * An agent that coordinates a team: agents connected from its "team" handle
 * become Claude Code subagents it can delegate to, as the task requires.
 * It shares the agent fields (prompt, model, tools, cwd, canAsk…).
 */
export interface OrchestratorData extends AgentData {
  /** Encourage delegating independent sub-tasks at the same time. */
  parallel: boolean;
}

export type OutputFormat = 'pdf' | 'pptx' | 'docx' | 'xlsx' | 'html' | 'md' | 'csv' | 'json' | 'txt';

/** Turns the incoming result into a file. */
export interface OutputData {
  format: OutputFormat;
  /** File name without extension; supports {{workflow.name}}, {{today}}, {{time}}, {{trigger.payload.*}}. */
  fileName: string;
  /** Folder to write to; default ~/.agent-canvas/outputs/<workflow>. */
  folder?: string;
  /** Document/deck title; defaults to the first heading. */
  title?: string;
  /** 'quick' = built-in converter (instant, no usage); 'claude' = an agent designs the file with its own tools/skills. */
  mode: 'quick' | 'claude';
  /** Claude mode: design notes, e.g. "corporate blue theme, one idea per slide". */
  instructions?: string;
  model?: string;
}

export type ActionType = 'save' | 'email' | 'http' | 'notify' | 'open';

/** Does something with the result: save, email, post, notify, open. Fields are used by the selected action. */
export interface ActionData {
  action: ActionType;
  // save
  folder?: string;
  fileName?: string;
  what?: 'files' | 'text' | 'both';
  overwrite?: boolean;
  // email
  via?: 'mail' | 'smtp';
  to?: string;
  cc?: string;
  subject?: string;
  body?: string;
  attach?: boolean;
  /** Mail.app: false = leave an open draft for you to send; SMTP always sends. */
  sendNow?: boolean;
  // http
  preset?: 'slack' | 'teams' | 'json' | 'custom';
  url?: string;
  headers?: string;
  bodyTemplate?: string;
  // notify
  title?: string;
  message?: string;
}

export interface OutputFile {
  id: string;
  path: string;
  name: string;
  format: string;
  bytes: number;
}

/** Where to tell someone that a review or question is waiting. */
export interface NotifyChannel {
  type: 'desktop' | 'email' | 'slack' | 'teams' | 'webhook';
  /** email: recipients */
  to?: string;
  /** email: 'mail' (Mail app, sends immediately) or 'smtp' */
  via?: 'mail' | 'smtp';
  /** slack/teams/webhook */
  url?: string;
}

export interface NotifyConfig {
  channels: NotifyChannel[];
  /** Re-notify while still waiting, every N minutes (0/empty = no reminders). */
  remindEveryMinutes?: number;
  remindTimes?: number;
}

export interface HumanData {
  title?: string;
  /** Shown to the reviewer above the content. */
  instructions?: string;
  /** 'branch' = reject goes to the "no" output; 'revise' = send feedback back to the previous agent. */
  onReject: 'branch' | 'revise';
  maxRounds?: number;
  /** Optional; when it elapses the request counts as rejected. */
  timeoutMinutes?: number;
  /** Tell the reviewer when this review is waiting. */
  notify?: NotifyConfig;
}

/** A context store that agents connect to. It is not a step in the flow. */
export interface MemoryData {
  name: string;
  /** 'workflow' = private to this workflow; 'shared' = any workflow using the same name. */
  scope: 'workflow' | 'shared';
  /** Files, folders or globs indexed for retrieval (RAG). */
  sources: string[];
  /** Agents may save notes (memory_save). */
  allowWrite: boolean;
  /** Save every answer you give an agent as a note, so it isn't asked again. */
  rememberAnswers: boolean;
  /** Put all notes into connected agents' context up front. */
  injectNotes: boolean;
  /** Also put the top N matching document chunks into context (0 = only via search tool). */
  autoRetrieve: number;
  /** Refresh changed files in the index at the start of each run. */
  reindexBeforeRun: boolean;
}

export interface MemoryItem {
  id: number;
  kind: 'note' | 'chunk';
  key: string;
  content: string;
  /** File path for chunks; 'agent' / 'answer' / 'manual' for notes. */
  source: string;
  updatedAt: number;
  runId?: string;
}

export interface MemoryStats {
  storeId: string;
  notes: number;
  chunks: number;
  files: number;
  lastIndexedAt?: number;
}

/** Collects items from a plugin source (Reddit, RSS, Google Trends…) into a dataset. */
export interface SourceData {
  plugin: string;
  source: string;
  /** Values for the source's fields; strings support {{templates}}. */
  config: Record<string, unknown>;
  /** Dataset name; empty = the workflow's name. */
  dataset?: string;
  /** Pass only items not seen before (default) instead of everything fetched. */
  onlyNew: boolean;
  /** Skip the following steps when nothing new came in. */
  stopIfEmpty: boolean;
  /** Max items kept per run. */
  limit?: number;
  /** If fetching fails, mark this step failed but let the rest of the workflow continue without it. */
  continueOnError?: boolean;
}

/** A dataset agents can query (connects to an agent's memory socket, like Memory). */
export interface DatasetData {
  name: string;
}

export type InsightField = 'sentiment' | 'topics' | 'language' | 'relevance' | 'entities' | 'summary';

/** Labels new dataset items with an LLM: sentiment, topics, relevance… */
export interface InsightData {
  /** Dataset name; empty = the dataset of the source(s) before it, else the workflow's name. */
  dataset?: string;
  fields: InsightField[];
  /** What you care about; used for relevance and topics. */
  brief?: string;
  /** Extra fields, one per line: "key: what to extract". */
  custom?: string;
  model?: string;
  /** Max items labelled per run. */
  maxItems?: number;
  stopIfEmpty: boolean;
}

export type ItemKind = 'post' | 'comment' | 'video' | 'article' | 'trend' | 'review' | 'page' | 'other';

/** One normalized media record, whatever the platform. */
export interface Item {
  /** Stable id within the plugin (post id, URL…); used to de-duplicate. */
  id: string;
  kind: ItemKind;
  title?: string;
  text?: string;
  url?: string;
  author?: string;
  /** Epoch ms. */
  publishedAt?: number;
  metrics?: { likes?: number; comments?: number; shares?: number; views?: number; score?: number; [k: string]: number | undefined };
  tags?: string[];
  media?: Array<{ type: 'image' | 'video'; url: string }>;
  extra?: Record<string, unknown>;
}

/** A time-series value (search interest, followers, subscribers…). */
export interface Point {
  series: string;
  /** Epoch ms. */
  t: number;
  value: number;
}

/** A stored item as the Insights tab sees it. */
export interface DatasetItem extends Item {
  source: string;
  feed: string;
  label?: string;
  firstSeen: number;
  lastSeen: number;
  sentiment?: number;
  topics?: string[];
  enrich?: Record<string, unknown>;
}

export interface ConditionData {
  mode: 'expression' | 'llm';
  /** JS expression evaluated against `output`, `input`, `trigger`. */
  expression?: string;
  /** Yes/no question the LLM judge answers about the input. */
  question?: string;
  model?: string;
  cwd?: string;
  /** Simple mode's rule builder state; `expression` is generated from it. */
  rule?: { field: string; op: string; value: string };
}

export interface MergeData {
  mode: 'all' | 'any';
}

export interface ScheduleData {
  mode: 'interval' | 'cron';
  everyMinutes?: number;
  cron?: string;
}

export interface FileWatchData {
  /** File, directory or glob to watch. */
  path: string;
  events: Array<'add' | 'change' | 'unlink'>;
  debounceMs?: number;
}

export interface WfNode {
  id: string;
  kind: NodeKind;
  position: { x: number; y: number };
  label?: string;
  data: Record<string, any>;
}

export interface WfEdge {
  id: string;
  source: string;
  target: string;
  /** For condition nodes: 'true' | 'false'. */
  sourceHandle?: string | null;
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  webhookToken: string;
  nodes: WfNode[];
  edges: WfEdge[];
  createdAt: string;
  updatedAt: string;
}

export type RunStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled';
export type NodeStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'success'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  | 'waiting';

/** A compact, UI-friendly slice of the CLI's stream-json output. */
export interface NodeEvent {
  t: 'text' | 'tool' | 'tool_result' | 'info' | 'error';
  text?: string;
  name?: string;
  input?: unknown;
  at: number;
}

export interface NodeOutput {
  text: string;
  /** Files produced by output nodes (and passed along by actions). */
  files?: OutputFile[];
  structured?: unknown;
  /** Condition nodes only. */
  pass?: boolean;
  reason?: string;
}

export interface NodeRun {
  runId: string;
  nodeId: string;
  status: NodeStatus;
  startedAt?: number;
  finishedAt?: number;
  prompt?: string;
  output?: NodeOutput;
  error?: string;
  sessionId?: string;
  costUsd?: number;
  events: NodeEvent[];
}

export interface Run {
  id: string;
  workflowId: string;
  workflowName: string;
  triggerNodeId: string;
  triggerKind: string;
  triggerPayload: unknown;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  costUsd: number;
}

export type BusEvent =
  | { type: 'run'; run: Run }
  | { type: 'node'; workflowId: string; node: Omit<NodeRun, 'events'> }
  | { type: 'node.event'; workflowId: string; runId: string; nodeId: string; event: NodeEvent }
  | { type: 'usage'; usage: UsageInfo }
  | { type: 'inbox'; request: HumanRequest }
  | { type: 'dataset'; dataset: string; added: number };

export interface HumanResponse {
  decision?: 'approve' | 'reject';
  text?: string;
  /** Set when the request expired instead of being answered. */
  timedOut?: boolean;
}

export interface HumanRequest {
  id: string;
  runId: string;
  workflowId: string;
  workflowName: string;
  nodeId: string;
  nodeName: string;
  kind: 'review' | 'question';
  title: string;
  instructions?: string;
  /** Content to review, or the agent's question. */
  body: string;
  round: number;
  /** Reviews only: the agent a rejection is sent back to (absent when reject takes the "no" path). */
  reviseTo?: string;
  maxRounds?: number;
  /** Files made before this review (e.g. the PDF about to be emailed), to open while reviewing. */
  files?: OutputFile[];
  status: 'pending' | 'answered' | 'cancelled' | 'expired';
  createdAt: number;
  expiresAt?: number;
  answeredAt?: number;
  response?: HumanResponse;
}

export interface UsageInfo {
  status?: string;
  fiveHour?: { utilization: number; resetsAt: number };
  sevenDay?: { utilization: number; resetsAt: number };
  updatedAt: number;
}

/** A question asked before creating a workflow (template wizards, the "describe it" builder). */
export interface SetupQuestion {
  id: string;
  label: string;
  help?: string;
  placeholder?: string;
  type: 'text' | 'email' | 'folder' | 'list' | 'time' | 'number' | 'url';
  default?: string;
  required?: boolean;
  /** Where the answer goes: a dot path inside a node's data ("config.query", "to", "cwd"; "@time" = a schedule's time of day). */
  targets: Array<{ node: string; path: string; /** replace this text in the current value */ replace?: string; /** e.g. "\"{{value}}\" OR {{value}}.com" */ format?: string }>;
}
