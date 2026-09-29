import { useEffect, useState } from 'react';
import type { TriggerStatus } from '../api';
import { COMMON_TOOLS, FORMATS, isAgentLike, metaOf, MODELS } from '../lib/nodeMeta';
import type { HumanRequest, NodeRun } from '../types';
import type { FlowNodeType } from './nodes/FlowNode';
import { MemoryPanel } from './MemoryPanel';
import { NotifyEditor } from './NotifyEditor';
import { RespondCard } from './RespondCard';
import { RunOutput } from './RunOutput';
import { DatasetFields, InsightFields, PluginToolsPicker, SourceFields } from './SourceInspector';

interface Props {
  node: FlowNodeType;
  workflowId: string;
  workflowName: string;
  webhookToken: string;
  saved: boolean;
  nodeRun?: NodeRun;
  trigger?: TriggerStatus;
  issues: string[];
  /** A review/question from this step that is waiting for the user. */
  pending?: HumanRequest;
  /** Human review only: the agent its ↩ revise loop points to. */
  loopTarget?: string;
  /** Orchestrator only: its connected team members. */
  team?: Array<{ id: string; name: string; description: string }>;
  /** Agent only: the orchestrator it works for. */
  workerOf?: string;
  onSelectNode?: (id: string) => void;
  notify: (msg: string, kind?: 'ok' | 'err') => void;
  onChange: (patch: Record<string, any>) => void;
  onLabel: (label: string) => void;
  onDelete: () => void;
  onRun: () => void;
  onOpenPlugins: () => void;
  onOpenInsights: (dataset: string) => void;
}

function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

function ToolsInput({ value, onChange, suggestions }: { value: string[]; onChange: (v: string[]) => void; suggestions?: string[] }) {
  const [draft, setDraft] = useState('');
  const add = (t: string) => {
    const tool = t.trim();
    if (tool && !value.includes(tool)) onChange([...value, tool]);
    setDraft('');
  };
  return (
    <div className="tools">
      <div className="chips">
        {value.map((t) => (
          <span key={t} className="chip">
            {t}
            <button type="button" aria-label={`Remove ${t}`} onClick={() => onChange(value.filter((x) => x !== t))}>
              ×
            </button>
          </span>
        ))}
        <input
          value={draft}
          placeholder={value.length ? '' : 'e.g. Read, Bash(git *)'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              add(draft);
            } else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
          }}
          onBlur={() => draft && add(draft)}
        />
      </div>
      {suggestions && (
        <div className="suggest">
          {suggestions
            .filter((s) => !value.includes(s))
            .map((s) => (
              <button type="button" key={s} onClick={() => add(s)}>
                + {s}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

const SCHEMA_EXAMPLE = JSON.stringify(
  { type: 'object', properties: { severity: { type: 'string', enum: ['none', 'low', 'high'] }, summary: { type: 'string' } }, required: ['severity', 'summary'] },
  null,
  2,
);

function copy(text: string) {
  void navigator.clipboard?.writeText(text);
}

export function Inspector({ node, workflowId, workflowName, webhookToken, saved, nodeRun, trigger, issues, pending, loopTarget, team, workerOf, onSelectNode, notify, onChange, onLabel, onDelete, onRun, onOpenPlugins, onOpenInsights }: Props) {
  const d = node.data.config;
  const kind = node.data.kind;
  const meta = metaOf(kind, d);
  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => onChange({ [key]: e.target.value });

  const hookUrl = `${location.origin}/api/hooks/${workflowId}/${node.id}`;
  const hasRun = !!nodeRun && nodeRun.status !== 'pending';
  const [tab, setTab] = useState<'config' | 'run'>(hasRun ? 'run' : 'config');
  // Jump to the output as soon as this step starts in a live run.
  const status = nodeRun?.status;
  useEffect(() => {
    if (status === 'running' || status === 'queued') setTab('run');
  }, [status]);

  return (
    <aside className="inspector">
      <header className="insp-head">
        <span className="insp-icon" style={{ color: meta.color }}>
          {meta.icon}
        </span>
        <div>
          <div className="insp-kind">{meta.title}</div>
          <div className="insp-hint">{meta.hint}</div>
        </div>
        <button className="btn ghost danger sm" onClick={onDelete} title="Delete step (Del)">
          Delete
        </button>
      </header>

      {pending && (
        <div className="insp-pending">
          <RespondCard key={pending.id} request={pending} notify={notify} />
        </div>
      )}

      {kind !== 'memory' && kind !== 'dataset' && (
        <div className="insp-tabs">
          <button className={tab === 'config' ? 'on' : ''} onClick={() => setTab('config')}>
            Settings
          </button>
          <button className={tab === 'run' ? 'on' : ''} onClick={() => setTab('run')} disabled={!hasRun}>
            Last run{status && status !== 'pending' ? <span className={`dotst st-${status}`}> ●</span> : ''}
          </button>
        </div>
      )}

      {tab === 'run' && hasRun && <RunOutput nodeRun={nodeRun!} preferText={kind === 'source' || kind === 'insight'} />}

      {tab === 'config' && issues.length > 0 && (
        <ul className="insp-issues">
          {issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}

      {tab === 'config' && (
        <div className="insp-body">
          {!isAgentLike(kind) && !['human', 'memory', 'output', 'action', 'dataset'].includes(kind) && (
            <Field label="Label">
              <input value={node.data.label ?? ''} placeholder={meta.title} onChange={(e) => onLabel(e.target.value)} />
            </Field>
          )}

          {isAgentLike(kind) && (
            <>
              {kind === 'orchestrator' && (
                <div className="team-box">
                  <div className="field-label">Team</div>
                  {team?.length ? (
                    <ul>
                      {team.map((m) => (
                        <li key={m.id} onClick={() => onSelectNode?.(m.id)}>
                          <b>{m.name}</b>
                          <span className={m.description ? '' : 'warnish'}>{m.description || 'No description: add one so the orchestrator knows when to use it'}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted small">No members yet.</p>
                  )}
                  <p className="field-hint">
                    Drag from the teal <b>team</b> handle under this node to agents. The orchestrator reads the task, picks members by their <b>descriptions</b>, briefs them, and combines
                    their results.
                  </p>
                </div>
              )}
              {workerOf && (
                <div className="team-box">
                  <p className="field-hint">
                    Team member of <b>{workerOf}</b>: it runs when the orchestrator delegates to it, with the orchestrator’s brief as its task. Its prompt below becomes standing
                    instructions, and its <b>description</b> tells the orchestrator when to use it. It shares the orchestrator’s working directory and can’t ask you questions (the
                    orchestrator can).
                  </p>
                </div>
              )}
              <Field label="Name" hint={kind === 'agent' ? 'Also the file name when exported to .claude/agents/' : undefined}>
                <input value={d.name} onChange={set('name')} />
              </Field>
              <Field label="Description" hint={workerOf ? 'Important: the orchestrator uses this to decide when to call this member.' : undefined}>
                <input value={d.description ?? ''} placeholder={kind === 'orchestrator' ? 'What this orchestrator coordinates' : 'What this agent is for'} onChange={set('description')} />
              </Field>
              {kind === 'orchestrator' && (
                <label className="toggle-row">
                  <input type="checkbox" checked={!!d.parallel} onChange={(e) => onChange({ parallel: e.target.checked })} />
                  <span>
                    <b>Run independent sub-tasks in parallel</b>
                    <span className="field-hint">Several members work at the same time (in one Claude Code session, one queue slot).</span>
                  </span>
                </label>
              )}
              <Field
                label={workerOf ? 'Standing instructions' : 'Task prompt'}
                hint={
                  <>
                    Variables: <code>{'{{input}}'}</code> previous step, <code>{'{{trigger.payload}}'}</code>, <code>{'{{nodes.<name>.output}}'}</code>, <code>{'{{date}}'}</code>. Input is appended
                    automatically if you don’t place it.
                  </>
                }
              >
                <textarea rows={6} value={d.prompt} onChange={set('prompt')} placeholder="What should this agent do?" />
              </Field>
              <Field label="Persona / system prompt" hint="Appended to Claude Code’s default system prompt.">
                <textarea rows={3} value={d.systemPrompt ?? ''} onChange={set('systemPrompt')} placeholder="You are a meticulous SRE…" />
              </Field>
              <div className="row2">
                <Field label="Model">
                  <input list="models" value={d.model} onChange={set('model')} />
                  <datalist id="models">
                    {MODELS.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                </Field>
                <Field label="Effort">
                  <select value={d.effort ?? ''} onChange={set('effort')}>
                    <option value="">default</option>
                    {['low', 'medium', 'high', 'xhigh', 'max'].map((e) => (
                      <option key={e}>{e}</option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label="Working directory" hint="The agent reads files and runs commands here. Only point it at folders you trust.">
                <input value={d.cwd} onChange={set('cwd')} placeholder="~/projects/my-app" />
              </Field>
              <Field label="Allowed tools" hint="Anything not listed is denied (headless runs never prompt). Empty = no tools.">
                <ToolsInput value={d.allowedTools ?? []} onChange={(v) => onChange({ allowedTools: v })} suggestions={COMMON_TOOLS} />
              </Field>
              <PluginToolsPicker value={d.pluginTools ?? []} onChange={(v) => onChange({ pluginTools: v })} />
              <Field label="Blocked tools">
                <ToolsInput value={d.disallowedTools ?? []} onChange={(v) => onChange({ disallowedTools: v })} />
              </Field>
              <Field label="Permission mode">
                <select value={d.permissionMode} onChange={set('permissionMode')}>
                  <option value="dontAsk">dontAsk: only allowed tools (recommended)</option>
                  <option value="acceptEdits">acceptEdits: also auto-accept file edits</option>
                  <option value="auto">auto: classifier decides</option>
                  <option value="plan">plan: read-only planning</option>
                  <option value="bypassPermissions">bypassPermissions: everything, no checks</option>
                </select>
              </Field>
              {d.permissionMode === 'bypassPermissions' && (
                <div className="warn">This agent can run any command and edit any file with no checks. Use only in a sandbox or throwaway folder.</div>
              )}
              <Field
                label="Structured output (JSON Schema)"
                hint={
                  <>
                    Optional. Forces JSON output that conditions can test, e.g. <code>output.severity === 'high'</code>.{' '}
                    {!d.outputSchema && (
                      <button type="button" className="linkbtn" onClick={() => onChange({ outputSchema: SCHEMA_EXAMPLE })}>
                        Insert example
                      </button>
                    )}
                  </>
                }
              >
                <textarea rows={d.outputSchema ? 7 : 2} className="mono" value={d.outputSchema ?? ''} onChange={set('outputSchema')} placeholder='{"type":"object",…}' />
              </Field>
              <label className="toggle-row">
              <input type="checkbox" checked={!!d.canAsk} onChange={(e) => onChange({ canAsk: e.target.checked })} />
              <span>
                <b>Can ask me questions</b>
                <span className="field-hint">
                  The agent gets an <code>ask_user</code> tool. When it needs something only you know, the run pauses, you answer here or in the Inbox, and the same session continues.
                </span>
              </span>
            </label>
            {d.canAsk && (
              <>
                <Field label="Max questions per run">
                  <input type="number" min={1} max={10} value={d.maxQuestions ?? 3} onChange={(e) => onChange({ maxQuestions: Number(e.target.value) })} />
                </Field>
                <div className="field">
                  <span className="field-label">Notify when it asks</span>
                  <NotifyEditor value={d.askNotify} onChange={(askNotify) => onChange({ askNotify })} kind="question" notify={notify} />
                </div>
              </>
            )}
            <Field label="Max turns (export only)">
                <input type="number" min={1} value={d.maxTurns ?? ''} onChange={(e) => onChange({ maxTurns: e.target.value ? Number(e.target.value) : undefined })} />
              </Field>
            </>
          )}

          {kind === 'condition' && (
            <>
              <div className="seg">
                <button className={d.mode !== 'llm' ? 'on' : ''} onClick={() => onChange({ mode: 'expression' })}>
                  Rule
                </button>
                <button className={d.mode === 'llm' ? 'on' : ''} onClick={() => onChange({ mode: 'llm' })}>
                  Ask Claude
                </button>
              </div>
              {d.mode === 'llm' ? (
                <>
                  <Field label="Yes/no question" hint="A small no-tools Claude run answers this about the incoming output.">
                    <textarea rows={3} value={d.question ?? ''} onChange={set('question')} placeholder="Does this mention a production outage?" />
                  </Field>
                  <Field label="Model">
                    <input list="models" value={d.model ?? 'haiku'} onChange={set('model')} />
                  </Field>
                </>
              ) : (
                <Field
                  label="Expression"
                  hint={
                    <>
                      JavaScript. <code>output</code> = previous step’s output (parsed JSON when possible), <code>input</code> = its text, <code>trigger.payload</code>.
                    </>
                  }
                >
                  <input className="mono" value={d.expression ?? ''} onChange={set('expression')} />
                </Field>
              )}
              <p className="muted small">Connect the green “yes” handle and the red “no” handle to different steps.</p>
            </>
          )}

          {kind === 'human' && (
            <>
              <Field label="Title" hint="Shown in the Inbox and the notification.">
                <input value={d.title ?? ''} onChange={set('title')} placeholder="Approve customer reply" />
              </Field>
              <Field label="Instructions for the reviewer">
                <textarea rows={2} value={d.instructions ?? ''} onChange={set('instructions')} placeholder="Check tone and facts before this goes out." />
              </Field>
              <Field
                label="When rejected"
                hint={
                  loopTarget ? (
                    <>
                      Loops back to <b>{loopTarget}</b>: it gets your feedback in its own session (and can ask you questions), the steps after it run again, and you review the new result.
                    </>
                  ) : (
                    <>
                      To loop back, drag from the orange <b>↩ revise</b> handle under this node to any earlier agent. Without a loop, “revise” sends feedback to the agent right before this review.
                    </>
                  )
                }
              >
                {loopTarget ? (
                  <input readOnly value={`↩ revise with ${loopTarget}, then review again`} />
                ) : (
                  <select value={d.onReject ?? 'branch'} onChange={set('onReject')}>
                    <option value="branch">take the red “no” path</option>
                    <option value="revise">send my feedback back to the previous agent to revise</option>
                  </select>
                )}
              </Field>
              {(loopTarget || d.onReject === 'revise') && (
                <Field label="Max review rounds" hint="After this many rejections the red “no” path is taken.">
                  <input type="number" min={1} max={10} value={d.maxRounds ?? 3} onChange={(e) => onChange({ maxRounds: Number(e.target.value) })} />
                </Field>
              )}
              <div className="field">
                <span className="field-label">Notify the reviewer</span>
                <NotifyEditor value={d.notify} onChange={(notify) => onChange({ notify })} kind="review" notify={notify} />
              </div>
              <Field label="Time limit (minutes)" hint="Optional. With no response in time, the request counts as rejected.">
                <input
                  type="number"
                  min={1}
                  value={d.timeoutMinutes ?? ''}
                  placeholder="no limit"
                  onChange={(e) => onChange({ timeoutMinutes: e.target.value ? Number(e.target.value) : undefined })}
                />
              </Field>
              <p className="muted small">
                The run pauses here without using any usage or agent slots. Approve → green “yes” output, carrying the content (plus your note). Reject → red “no” output with your feedback.
                Waiting runs are cancelled if the app restarts.
              </p>
            </>
          )}

          {kind === 'output' && (
            <>
              <Field label="Format">
                <select value={d.format} onChange={set('format')}>
                  {FORMATS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="seg">
                <button className={d.mode !== 'claude' ? 'on' : ''} onClick={() => onChange({ mode: 'quick' })}>
                  Quick convert
                </button>
                <button className={d.mode === 'claude' ? 'on' : ''} onClick={() => onChange({ mode: 'claude' })}>
                  Designed by Claude
                </button>
              </div>
              <p className="muted small">
                {d.mode === 'claude'
                  ? 'An agent builds the file with its own tools and skills: richer layouts and charts, but slower and it uses your Claude usage.'
                  : 'Built-in converter from the previous step’s Markdown (headings, lists, tables, code). Instant, free, and handles Arabic/RTL. Excel and CSV use tables or JSON data.'}
              </p>
              {d.mode === 'claude' && (
                <>
                  <Field label="Design notes">
                    <textarea rows={3} value={d.instructions ?? ''} onChange={set('instructions')} placeholder="e.g. corporate blue theme, one idea per slide, add a chart for the scores" />
                  </Field>
                  <Field label="Model">
                    <input list="models" value={d.model ?? 'sonnet'} onChange={set('model')} />
                  </Field>
                </>
              )}
              <Field label="Title" hint="Optional. Defaults to the first heading.">
                <input value={d.title ?? ''} onChange={set('title')} />
              </Field>
              <Field label="File name" hint={<>Without extension. Variables: <code>{'{{workflow.name}}'}</code>, <code>{'{{today}}'}</code>, <code>{'{{time}}'}</code>, <code>{'{{trigger.payload.*}}'}</code>.</>}>
                <input value={d.fileName ?? ''} onChange={set('fileName')} />
              </Field>
              <Field label="Folder" hint="Optional. Default: ~/.agent-canvas/outputs/<workflow>. Add a Save action to also copy it somewhere else.">
                <input value={d.folder ?? ''} onChange={set('folder')} placeholder="~/.agent-canvas/outputs/…" />
              </Field>
            </>
          )}

          {kind === 'action' && d.action === 'save' && (
            <>
              <Field label="Folder">
                <input value={d.folder ?? ''} onChange={set('folder')} placeholder="~/Documents/Reports" />
              </Field>
              <Field label="Save">
                <select value={d.what ?? 'files'} onChange={set('what')}>
                  <option value="files">the files from Output nodes</option>
                  <option value="text">the text result (as .md)</option>
                  <option value="both">both</option>
                </select>
              </Field>
              <Field label="Rename to" hint="Optional, without extension. Variables work here too.">
                <input value={d.fileName ?? ''} onChange={set('fileName')} placeholder="keep original name" />
              </Field>
              <label className="toggle-row">
                <input type="checkbox" checked={!!d.overwrite} onChange={(e) => onChange({ overwrite: e.target.checked })} />
                <span>
                  <b>Overwrite existing files</b>
                  <span className="field-hint">Otherwise a number is added (report-2.pdf).</span>
                </span>
              </label>
            </>
          )}

          {kind === 'action' && d.action === 'email' && (
            <>
              <div className="seg">
                <button className={d.via !== 'smtp' ? 'on' : ''} onClick={() => onChange({ via: 'mail' })}>
                  Mail app
                </button>
                <button className={d.via === 'smtp' ? 'on' : ''} onClick={() => onChange({ via: 'smtp' })}>
                  SMTP
                </button>
              </div>
              <p className="muted small">
                {d.via === 'smtp'
                  ? 'Sends through the SMTP server in Settings (e.g. Gmail with an app password). Always sends immediately.'
                  : 'Uses the macOS Mail app and the accounts already set up in it. No passwords here. macOS asks once to allow controlling Mail.'}
              </p>
              <Field label="To" hint="Comma-separated. Variables allowed, e.g. {{trigger.payload.email}}.">
                <input value={d.to ?? ''} onChange={set('to')} placeholder="team@example.com" />
              </Field>
              <Field label="Cc">
                <input value={d.cc ?? ''} onChange={set('cc')} />
              </Field>
              <Field label="Subject">
                <input value={d.subject ?? ''} onChange={set('subject')} />
              </Field>
              <Field label="Body" hint={<><code>{'{{input}}'}</code> is the previous step’s text; <code>{'{{files}}'}</code> lists attachments.</>}>
                <textarea rows={4} value={d.body ?? ''} onChange={set('body')} />
              </Field>
              <label className="toggle-row">
                <input type="checkbox" checked={d.attach !== false} onChange={(e) => onChange({ attach: e.target.checked })} />
                <span>
                  <b>Attach files</b>
                  <span className="field-hint">Everything produced by Output nodes before this step.</span>
                </span>
              </label>
              {d.via !== 'smtp' && (
                <label className="toggle-row">
                  <input type="checkbox" checked={!!d.sendNow} onChange={(e) => onChange({ sendNow: e.target.checked })} />
                  <span>
                    <b>Send immediately</b>
                    <span className="field-hint">Off: opens a ready draft in Mail for you to check and send. On: sends without asking.</span>
                  </span>
                </label>
              )}
              {(d.via === 'smtp' || d.sendNow) && <div className="warn">This step sends email on its own when the workflow runs. Put a Human review before it if you want to check first.</div>}
            </>
          )}

          {kind === 'action' && d.action === 'http' && (
            <>
              <Field label="Type">
                <select value={d.preset ?? 'slack'} onChange={set('preset')}>
                  <option value="slack">Slack incoming webhook</option>
                  <option value="teams">Microsoft Teams webhook</option>
                  <option value="json">Generic JSON (text, files, run info)</option>
                  <option value="custom">Custom body</option>
                </select>
              </Field>
              <Field label="URL">
                <input className="mono" value={d.url ?? ''} onChange={set('url')} placeholder={d.preset === 'teams' ? 'https://…webhook.office.com/…' : 'https://hooks.slack.com/services/…'} />
              </Field>
              {(d.preset === 'slack' || d.preset === 'teams' || !d.preset) && (
                <Field label="Message" hint="Optional. Defaults to the previous step’s text; file names are appended.">
                  <textarea rows={3} value={d.message ?? ''} onChange={set('message')} placeholder="{{workflow.name}} finished: {{input}}" />
                </Field>
              )}
              {d.preset === 'custom' && (
                <Field label="Body template">
                  <textarea rows={5} className="mono" value={d.bodyTemplate ?? ''} onChange={set('bodyTemplate')} placeholder='{"summary": "{{input}}"}' />
                </Field>
              )}
              <Field label="Headers (JSON)" hint="Optional, e.g. an Authorization header.">
                <input className="mono" value={d.headers ?? ''} onChange={set('headers')} placeholder='{"Authorization": "Bearer …"}' />
              </Field>
              <p className="muted small">Files are referenced by name and path (they stay on this Mac). Use Email to send the files themselves.</p>
            </>
          )}

          {kind === 'action' && d.action === 'notify' && (
            <>
              <Field label="Title">
                <input value={d.title ?? ''} onChange={set('title')} />
              </Field>
              <Field label="Message" hint="Optional. Defaults to the start of the previous step’s text.">
                <input value={d.message ?? ''} onChange={set('message')} />
              </Field>
            </>
          )}

          {kind === 'action' && d.action === 'open' && <p className="muted small">Opens each file produced before this step in its default app (Preview, Keynote/PowerPoint, Word, Excel…).</p>}

          {kind === 'memory' && (
            <>
              <p className="muted small">
                Connect this to agents: drag from its bottom handle to an agent’s <b>top</b> handle. Connected agents get <code>memory_search</code>
                {d.allowWrite ? (
                  <>
                    {' '}
                    and <code>memory_save</code>
                  </>
                ) : null}{' '}
                tools. Several agents can share one memory.
              </p>
              <Field label="Name">
                <input value={d.name ?? ''} onChange={set('name')} />
              </Field>
              <Field label="Scope" hint={d.scope === 'shared' ? 'Any workflow with a shared memory of the same name reads and writes the same store.' : 'Only this workflow sees it. Deleted with the workflow.'}>
                <select value={d.scope ?? 'workflow'} onChange={set('scope')}>
                  <option value="workflow">This workflow only</option>
                  <option value="shared">Shared across workflows (by name)</option>
                </select>
              </Field>
              <Field label="Documents to index (RAG)" hint="One file, folder or glob per line. Text and code files up to 1 MB; node_modules, .git and build folders are skipped. Search is local full-text (BM25), no API key.">
                <textarea
                  rows={3}
                  className="mono"
                  value={(d.sources ?? []).join('\n')}
                  placeholder={'~/projects/my-app/docs\n~/notes/runbook.md'}
                  onChange={(e) => onChange({ sources: e.target.value.split('\n') })}
                  onBlur={(e) => onChange({ sources: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })}
                />
              </Field>
              <label className="toggle-row">
                <input type="checkbox" checked={!!d.reindexBeforeRun} onChange={(e) => onChange({ reindexBeforeRun: e.target.checked })} />
                <span>
                  <b>Refresh index at the start of each run</b>
                  <span className="field-hint">Only new or changed files are re-read.</span>
                </span>
              </label>
              <label className="toggle-row">
                <input type="checkbox" checked={!!d.allowWrite} onChange={(e) => onChange({ allowWrite: e.target.checked })} />
                <span>
                  <b>Agents can save notes</b>
                  <span className="field-hint">Facts, decisions and findings that later steps and future runs can use.</span>
                </span>
              </label>
              <label className="toggle-row">
                <input type="checkbox" checked={!!d.rememberAnswers} onChange={(e) => onChange({ rememberAnswers: e.target.checked })} />
                <span>
                  <b>Remember my answers</b>
                  <span className="field-hint">When a connected agent asks you something, your answer is saved here so it isn’t asked again.</span>
                </span>
              </label>
              <label className="toggle-row">
                <input type="checkbox" checked={!!d.injectNotes} onChange={(e) => onChange({ injectNotes: e.target.checked })} />
                <span>
                  <b>Give notes to agents up front</b>
                  <span className="field-hint">Adds all notes to the agent’s context (up to ~6k characters) instead of relying on search.</span>
                </span>
              </label>
              <Field label="Auto-retrieve document chunks" hint="Also add the top N chunks matching the task prompt. 0 = agents search on demand only.">
                <input type="number" min={0} max={10} value={d.autoRetrieve ?? 0} onChange={(e) => onChange({ autoRetrieve: Number(e.target.value) })} />
              </Field>
              <div className="field-label">Contents</div>
              <MemoryPanel workflowId={workflowId} nodeId={node.id} saved={saved} hasSources={!!d.sources?.length} notify={notify} />
            </>
          )}

          {kind === 'source' && <SourceFields config={d} workflowId={workflowId} workflowName={workflowName} nodeId={node.id} onChange={onChange} onOpenPlugins={onOpenPlugins} />}
          {kind === 'dataset' && <DatasetFields config={d} onChange={onChange} onOpenInsights={onOpenInsights} />}
          {kind === 'insight' && <InsightFields config={d} workflowName={workflowName} onChange={onChange} />}

          {kind === 'merge' && (
            <Field label="Continue when">
              <select value={d.mode} onChange={set('mode')}>
                <option value="all">all incoming branches finished</option>
                <option value="any">the first branch finishes</option>
              </select>
            </Field>
          )}

          {kind === 'trigger.schedule' && (
            <>
              <div className="seg">
                <button className={d.mode !== 'cron' ? 'on' : ''} onClick={() => onChange({ mode: 'interval' })}>
                  Every N minutes
                </button>
                <button className={d.mode === 'cron' ? 'on' : ''} onClick={() => onChange({ mode: 'cron' })}>
                  Cron
                </button>
              </div>
              {d.mode === 'cron' ? (
                <Field label="Cron expression" hint="minute hour day month weekday, e.g. 0 9 * * 1-5 = weekdays 09:00 (local time)">
                  <input className="mono" value={d.cron ?? ''} onChange={set('cron')} />
                </Field>
              ) : (
                <Field label="Minutes between runs">
                  <input type="number" min={1} value={d.everyMinutes ?? 15} onChange={(e) => onChange({ everyMinutes: Number(e.target.value) })} />
                </Field>
              )}
              <p className="muted small">Runs only while the workflow is enabled and this app is running. A tick is skipped if the previous run hasn’t finished.</p>
            </>
          )}

          {kind === 'trigger.file' && (
            <>
              <Field label="Path or glob" hint="e.g. ~/Desktop/inbox or ~/logs/**/*.log">
                <input value={d.path ?? ''} onChange={set('path')} />
              </Field>
              <Field label="Fire on">
                <div className="checks">
                  {(['add', 'change', 'unlink'] as const).map((ev) => (
                    <label key={ev}>
                      <input
                        type="checkbox"
                        checked={(d.events ?? []).includes(ev)}
                        onChange={(e) => onChange({ events: e.target.checked ? [...(d.events ?? []), ev] : (d.events ?? []).filter((x: string) => x !== ev) })}
                      />
                      {ev === 'add' ? 'new file' : ev === 'change' ? 'changed' : 'deleted'}
                    </label>
                  ))}
                </div>
              </Field>
              <Field label="Debounce (ms)" hint="Bursts of changes within this window start one run.">
                <input type="number" min={0} value={d.debounceMs ?? 1000} onChange={(e) => onChange({ debounceMs: Number(e.target.value) })} />
              </Field>
              <p className="muted small">
                Payload: <code>{'{{trigger.payload.path}}'}</code>, <code>{'{{trigger.payload.event}}'}</code>.
              </p>
            </>
          )}

          {kind === 'trigger.webhook' && (
            <>
              {!saved && <div className="warn">Save the workflow to activate this URL.</div>}
              <Field label="URL">
                <div className="copyrow">
                  <input readOnly className="mono" value={hookUrl} />
                  <button className="btn sm" onClick={() => copy(hookUrl)}>
                    Copy
                  </button>
                </div>
              </Field>
              <Field label="Token" hint="Send as ?token=… or the x-agent-canvas-token header.">
                <div className="copyrow">
                  <input readOnly className="mono" value={webhookToken} />
                  <button className="btn sm" onClick={() => copy(webhookToken)}>
                    Copy
                  </button>
                </div>
              </Field>
              <Field label="Try it">
                <pre className="code">{`curl -X POST '${hookUrl}' \\\n  -H 'x-agent-canvas-token: ${webhookToken}' \\\n  -H 'content-type: application/json' \\\n  -d '{"alert":"disk 91%"}'`}</pre>
              </Field>
              <p className="muted small">
                The JSON body is available as <code>{'{{trigger.payload}}'}</code>. Only accepted while the workflow is enabled. The server listens on localhost only.
              </p>
            </>
          )}

          {kind.startsWith('trigger.') && (
            <div className="trig-actions">
              <button className="btn primary" onClick={onRun}>
                ▶ Run from here
              </button>
              {trigger && (
                <span className="muted small">
                  {trigger.error
                    ? `Not armed: ${trigger.error}`
                    : trigger.nextRunAt
                      ? `Next run ${new Date(trigger.nextRunAt).toLocaleTimeString()}`
                      : trigger.armed
                        ? 'Armed'
                        : ''}
                  {trigger.lastSkippedAt ? ` · last tick skipped ${new Date(trigger.lastSkippedAt).toLocaleTimeString()}` : ''}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
