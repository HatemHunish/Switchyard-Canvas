import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, type Draft, type TemplateInfo, type WorkflowView } from '../api';
import { applyAnswers } from '../lib/answers';
import { outline, type OutlineStep } from '../lib/describe';
import { tildify, useSettingsState } from '../lib/mode';
import { usePlugins } from '../lib/plugins';
import type { SetupQuestion } from '../types';

// "Describe it" builder, template wizards, and the plain step list they share.

const branchLabel = (b: NonNullable<OutlineStep['branch']>) => (b.of === 'approved' ? (b.label === 'yes' ? 'If you approve' : 'If you reject') : b.label === 'yes' ? 'If yes' : 'Otherwise');

/** Read-only list of what a workflow does, in plain words. */
export function StepPreview({ nodes, edges }: { nodes: Draft['nodes']; edges: Draft['edges'] }) {
  const catalog = usePlugins(); // source names come from the plugin list
  const steps = useMemo(() => outline(nodes, edges), [nodes, edges, catalog]);
  return (
    <ol className="steps-preview">
      {steps.map((s, i) => (
        <li key={s.node.id} style={{ marginInlineStart: s.depth * 22 }}>
          {s.branch && <div className="step-branch">{branchLabel(s.branch)}</div>}
          <div className="step-row">
            <span className="step-num">{i + 1}</span>
            <span className="step-icon" aria-hidden>
              {s.icon}
            </span>
            <span className="step-text">
              {s.text}
              {s.parallel && <span className="step-tag">at the same time</span>}
              {s.uses.length > 0 && <span className="step-uses">uses {s.uses.map((u) => u.data.name).join(', ')}</span>}
              {s.team.length > 0 && <span className="step-uses">team: {s.team.map((t) => t.data.name).join(', ')}</span>}
              {s.loopTo && <span className="step-uses">if you send it back: {s.loopTo.data.name} revises it</span>}
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** The short form of things only the user knows (emails, names, folders…). */
export function QuestionsForm({ questions, answers, onChange }: { questions: SetupQuestion[]; answers: Record<string, string>; onChange: (a: Record<string, string>) => void }) {
  const set = (id: string, v: string) => onChange({ ...answers, [id]: v });
  if (!questions.length) return null;
  return (
    <div className="q-form">
      {questions.map((q) => (
        <label key={q.id} className="field">
          <span className="field-label">
            {q.label}
            {!q.required && q.type !== 'email' && <span className="muted"> (optional)</span>}
          </span>
          {q.type === 'list' ? (
            <textarea rows={3} value={answers[q.id] ?? ''} placeholder={q.placeholder} onChange={(e) => set(q.id, e.target.value)} />
          ) : q.type === 'folder' ? (
            <span className="plug-cred-row">
              <input value={answers[q.id] ?? ''} placeholder={q.placeholder ?? '~/Documents/…'} onChange={(e) => set(q.id, e.target.value)} />
              <button
                type="button"
                className="btn sm"
                onClick={async () => {
                  try {
                    const r = await api.chooseFolder(q.label);
                    if (r.path) set(q.id, tildify(r.path));
                  } catch {
                    /* type it instead */
                  }
                }}
              >
                Choose…
              </button>
            </span>
          ) : (
            <input
              type={q.type === 'email' ? 'email' : q.type === 'time' ? 'time' : q.type === 'number' ? 'number' : q.type === 'url' ? 'url' : 'text'}
              value={answers[q.id] ?? ''}
              placeholder={q.placeholder}
              onChange={(e) => set(q.id, e.target.value)}
            />
          )}
          {q.help && <span className="field-hint">{q.help}</span>}
        </label>
      ))}
    </div>
  );
}

function initialAnswers(questions: SetupQuestion[], userEmail: string) {
  const a: Record<string, string> = {};
  for (const q of questions) a[q.id] = q.default ?? (q.type === 'email' ? userEmail : '');
  return a;
}

const missing = (questions: SetupQuestion[], answers: Record<string, string>) => questions.filter((q) => (q.required || q.type === 'email') && !answers[q.id]?.trim());

const EXAMPLES = [
  'Every morning, check the news and Reddit for my brand and email me a summary, highlighting anything negative.',
  'Every Monday at 9, write a short report from the files in my Reports folder, let me approve it, then save it as a PDF.',
  'When I drop a PDF in my Desktop/Inbox folder, summarise it in 5 bullet points and show me a notification.',
  'Watch my competitor’s pricing page and email me when something changes.',
];

/** Big "What should it do?" box: Claude drafts a workflow, you check it in plain words, answer a few questions, create. */
export function Describe({ focusNonce, onCreated, notify, compact }: { focusNonce?: number; onCreated: (wf: WorkflowView) => void; notify: (m: string, k?: 'ok' | 'err') => void; compact?: boolean }) {
  const { userEmail } = useSettingsState();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<'' | 'draft' | 'change' | 'create'>('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [change, setChange] = useState('');
  const [name, setName] = useState('');
  const [open, setOpen] = useState(!compact);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!focusNonce) return;
    setOpen(true);
    setTimeout(() => (ref.current?.focus(), ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })), 50);
  }, [focusNonce]);

  const run = async (kind: 'draft' | 'change') => {
    setBusy(kind);
    try {
      const d = kind === 'change' && draft ? await api.draftWorkflow(text, draft, change) : await api.draftWorkflow(text);
      setDraft(d);
      setName(d.name);
      setAnswers((a) => ({ ...initialAnswers(d.questions, userEmail), ...Object.fromEntries(Object.entries(a).filter(([k, v]) => v && d.questions.some((q) => q.id === k))) }));
      setChange('');
    } catch (err) {
      notify((err as ApiError).message, 'err');
    } finally {
      setBusy('');
    }
  };

  const create = async () => {
    if (!draft) return;
    const left = missing(draft.questions, answers);
    if (left.length) return notify(`Please answer: ${left.map((q) => q.label).join(' · ')}`, 'err');
    setBusy('create');
    try {
      const wf = await api.createFromDraft({ ...draft, name: name.trim() || draft.name }, answers);
      notify(`Created “${wf.name}”. Press Run to try it; turn it on to let it run by itself.`, 'ok');
      setDraft(null);
      setText('');
      onCreated(wf);
    } catch (err) {
      notify((err as ApiError).message, 'err');
    } finally {
      setBusy('');
    }
  };

  if (!open)
    return (
      <button className="describe-closed" onClick={() => (setOpen(true), setTimeout(() => ref.current?.focus(), 30))}>
        <span>✨</span> Describe a new automation in your own words…
      </button>
    );

  return (
    <section className="card describe" aria-label="Describe an automation">
      {!draft ? (
        <>
          <header className="card-head">
            <h2>✨ What should it do?</h2>
            <span className="muted small">Describe it in your own words. Claude designs it; you check it before anything runs.</span>
            {compact && (
              <button className="btn ghost sm" onClick={() => setOpen(false)} aria-label="Close">
                ✕
              </button>
            )}
          </header>
          <textarea
            ref={ref}
            className="describe-input"
            rows={3}
            value={text}
            placeholder="e.g. Every Friday afternoon, collect what people said about us on Reddit and in the news this week, and email me the highlights."
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) void run('draft');
            }}
            disabled={!!busy}
          />
          <div className="describe-foot">
            <div className="describe-examples">
              {EXAMPLES.map((x) => (
                <button key={x} className="chip-sm" onClick={() => setText(x)} disabled={!!busy} title={x}>
                  {x.length > 58 ? `${x.slice(0, 56)}…` : x}
                </button>
              ))}
            </div>
            <button className="btn primary" onClick={() => void run('draft')} disabled={!text.trim() || !!busy}>
              {busy === 'draft' ? 'Designing… (about 20 s)' : 'Design it'}
            </button>
          </div>
        </>
      ) : (
        <>
          <header className="card-head">
            <input className="draft-name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
            <span className="spacer" />
            <button className="btn ghost sm" onClick={() => setDraft(null)}>
              Start over
            </button>
          </header>
          <p className="muted draft-desc">{draft.description}</p>
          <div className="draft-grid">
            <div>
              <div className="field-label">What it will do</div>
              <StepPreview nodes={applyAnswers(draft.nodes, draft.questions, answers)} edges={draft.edges} />
              {draft.notes?.trim() && <p className="draft-notes">ℹ️ {draft.notes}</p>}
              {draft.issues.length > 0 && (
                <div className="warn">
                  A few things need a look after it’s created: {draft.issues.join(' · ')}
                </div>
              )}
            </div>
            <div>
              {draft.questions.length > 0 ? (
                <>
                  <div className="field-label">A few details</div>
                  <QuestionsForm questions={draft.questions} answers={answers} onChange={setAnswers} />
                </>
              ) : (
                <p className="muted small">No details needed.</p>
              )}
              <label className="field">
                <span className="field-label">Want it different?</span>
                <span className="plug-cred-row">
                  <input value={change} placeholder="e.g. also check Hacker News, and send it at 7:30 instead" onChange={(e) => setChange(e.target.value)} disabled={!!busy} onKeyDown={(e) => e.key === 'Enter' && change.trim() && void run('change')} />
                  <button className="btn sm" onClick={() => void run('change')} disabled={!change.trim() || !!busy}>
                    {busy === 'change' ? 'Changing…' : 'Change'}
                  </button>
                </span>
              </label>
              <div className="draft-actions">
                <button className="btn primary" onClick={() => void create()} disabled={!!busy}>
                  {busy === 'create' ? 'Creating…' : 'Create automation'}
                </button>
                <span className="field-hint">It starts turned off. You can try it with Run first.</span>
              </div>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

/** A template's few questions, then create it filled in. */
export function TemplateWizard({ template, onClose, onCreated, notify }: { template: TemplateInfo; onClose: () => void; onCreated: (wf: WorkflowView) => void; notify: (m: string, k?: 'ok' | 'err') => void }) {
  const { userEmail } = useSettingsState();
  const questions = template.setup ?? [];
  const [answers, setAnswers] = useState(() => initialAnswers(questions, userEmail));
  const [busy, setBusy] = useState(false);
  const create = async () => {
    const left = missing(questions, answers);
    if (left.length) return notify(`Please answer: ${left.map((q) => q.label).join(' · ')}`, 'err');
    setBusy(true);
    try {
      const wf = await api.fromTemplate(template.key, answers);
      notify(`Created “${wf.name}”. Press Run to try it.`, 'ok');
      onCreated(wf);
    } catch (err) {
      notify((err as ApiError).message, 'err');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal wizard" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={template.name}>
        <h3>{template.name}</h3>
        <p className="muted">{template.description}</p>
        <div className="draft-grid">
          <div>
            <div className="field-label">What it will do</div>
            <StepPreview nodes={applyAnswers(template.nodes, questions, answers)} edges={template.edges} />
          </div>
          <div>
            {questions.length ? <QuestionsForm questions={questions} answers={answers} onChange={setAnswers} /> : <p className="muted small">No details needed; you can adjust everything after creating it.</p>}
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void create()} disabled={busy}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
