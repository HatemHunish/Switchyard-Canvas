import { ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type ClaudeStatus, type Settings, type TemplateInfo, type WorkflowView } from './api';
import { Dashboard } from './components/dashboard/Dashboard';
import { Editor } from './components/Editor';
import { RespondCard } from './components/RespondCard';
import { subscribe } from './lib/live';
import type { HumanRequest, UsageInfo } from './types';

const PATTERN_LABEL = { monitor: 'Monitor', triggered: 'Triggered', pipeline: 'Pipeline', human: 'With approval', memory: 'Memory / RAG', orchestrator: 'Orchestrator', output: 'Files & actions' } as const;

function ClaudeBadge({ status, onRefresh }: { status: ClaudeStatus | null; onRefresh: () => void }) {
  if (!status) return <span className="badge">Checking Claude Code…</span>;
  if (!status.installed)
    return (
      <span className="badge bad" title={status.error}>
        Claude Code CLI not found
      </span>
    );
  if (!status.loggedIn)
    return (
      <button className="badge bad" onClick={onRefresh} title="Run `claude` in a terminal and use /login, then click to re-check">
        Not logged in · run <code>claude</code> → /login
      </button>
    );
  const sub = status.authMethod === 'claude.ai' ? `${status.subscriptionType ?? 'subscription'} plan` : (status.authMethod ?? 'logged in');
  return (
    <button className="badge ok" onClick={onRefresh} title={`${status.version} · click to re-check`}>
      ● Claude Code · {sub}
    </button>
  );
}

function UsageMeter({ usage, queue }: { usage: UsageInfo | null; queue?: { active: number; waiting: number; limit: number } }) {
  const five = usage?.fiveHour;
  const pct = five ? Math.round(five.utilization * 100) : null;
  return (
    <div className="usage" title={five ? `5-hour window ${pct}% used · resets ${new Date(five.resetsAt * 1000).toLocaleTimeString()}` : 'Usage appears after the first run'}>
      {pct !== null && (
        <>
          <span className="muted small">5h usage</span>
          <span className="meter">
            <span style={{ width: `${Math.min(100, pct)}%` }} className={pct > 80 ? 'hot' : ''} />
          </span>
          <span className="small">{pct}%</span>
        </>
      )}
      {queue && (queue.active > 0 || queue.waiting > 0) && (
        <span className="small muted">
          · {queue.active}/{queue.limit} agents running{queue.waiting ? `, ${queue.waiting} queued` : ''}
        </span>
      )}
    </div>
  );
}

function SettingsDialog({ onClose, notify }: { onClose: () => void; notify: (m: string, k?: 'ok' | 'err') => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [password, setPassword] = useState('');
  const [testTo, setTestTo] = useState('');
  useEffect(() => {
    api.settings().then(setS);
  }, []);
  if (!s) return null;
  const smtp = (patch: Partial<Settings['smtp']>) => setS({ ...s, smtp: { ...s.smtp, ...patch } });
  const test = async (via: 'mail' | 'smtp') => {
    try {
      await api.saveSettings(s);
      if (password) await api.saveSmtpPassword(password);
      notify((await api.testEmail(testTo, via)).summary, 'ok');
    } catch (e) {
      notify((e as ApiError).message, 'err');
    }
  };
  const save = async () => {
    try {
      if (password) await api.saveSmtpPassword(password);
      await api.saveSettings(s);
      notify('Settings saved', 'ok');
      onClose();
    } catch (e) {
      notify((e as ApiError).message, 'err');
    }
  };
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Settings">
        <h3>Settings</h3>
        <label className="field">
          <span className="field-label">Max agents running at once</span>
          <input type="number" min={1} max={10} value={s.concurrency} onChange={(e) => setS({ ...s, concurrency: Number(e.target.value) })} />
          <span className="field-hint">All runs share your Claude subscription’s usage limits. Extra runs wait in a queue.</span>
        </label>
        <label className="field">
          <span className="field-label">Claude Code CLI command</span>
          <input value={s.claudeBin} onChange={(e) => setS({ ...s, claudeBin: e.target.value })} />
          <span className="field-hint">Usually just <code>claude</code>. Use a full path if it isn’t on the server’s PATH.</span>
        </label>
        <label className="toggle-row">
          <input type="checkbox" checked={s.desktopNotifications} onChange={(e) => setS({ ...s, desktopNotifications: e.target.checked })} />
          <span>
            <b>macOS notifications</b>
            <span className="field-hint">Pop up a notification when a run needs your review or answer.</span>
          </span>
        </label>
        {'Notification' in window && Notification.permission !== 'granted' && (
          <button className="btn sm" onClick={() => Notification.requestPermission()}>
            Also allow browser notifications
          </button>
        )}
        <div className="settings-section">
          <h4>Links in notifications</h4>
          <label className="field">
            <span className="field-label">Public URL (optional)</span>
            <input value={s.publicUrl} placeholder="http://127.0.0.1:3002 (this Mac only)" onChange={(e) => setS({ ...s, publicUrl: e.target.value })} />
            <span className="field-hint">
              Review links in emails and Slack open this address. Leave empty to use this Mac. To answer from your phone, run the app with HOST=0.0.0.0 and put your Mac’s address here, or use a private tunnel. Anyone who can reach it and has a link can answer that one request.
            </span>
          </label>
        </div>
        <div className="settings-section">
          <h4>Output files</h4>
          <label className="field">
            <span className="field-label">Default output folder</span>
            <input value={s.outputsDir} onChange={(e) => setS({ ...s, outputsDir: e.target.value })} />
          </label>
          <label className="field">
            <span className="field-label">Browser for PDF</span>
            <input value={s.chromePath} placeholder={s.detectedChrome ?? 'No Chrome/Edge/Brave found'} onChange={(e) => setS({ ...s, chromePath: e.target.value })} />
            <span className="field-hint">{s.detectedChrome ? `Using ${s.detectedChrome}` : 'PDF output needs Chrome, Chromium, Edge or Brave.'} Leave empty to auto-detect.</span>
          </label>
        </div>
        <div className="settings-section">
          <h4>Email via SMTP (optional)</h4>
          <p className="muted small" style={{ margin: 0 }}>
            Only needed for Email actions set to SMTP. The Mail app option uses your existing Mail accounts instead. For Gmail use smtp.gmail.com, port 465, secure, and an app password.
          </p>
          <div className="row2">
            <label className="field">
              <span className="field-label">Server</span>
              <input value={s.smtp.host} placeholder="smtp.gmail.com" onChange={(e) => smtp({ host: e.target.value })} />
            </label>
            <label className="field">
              <span className="field-label">Port</span>
              <input type="number" value={s.smtp.port} onChange={(e) => smtp({ port: Number(e.target.value) })} />
            </label>
          </div>
          <label className="toggle-row">
            <input type="checkbox" checked={s.smtp.secure} onChange={(e) => smtp({ secure: e.target.checked })} />
            <span>
              <b>Secure connection (TLS)</b>
              <span className="field-hint">On for port 465; off for 587 (upgrades with STARTTLS).</span>
            </span>
          </label>
          <div className="row2">
            <label className="field">
              <span className="field-label">Username</span>
              <input value={s.smtp.user} onChange={(e) => smtp({ user: e.target.value })} />
            </label>
            <label className="field">
              <span className="field-label">Password</span>
              <input type="password" value={password} placeholder={s.hasSmtpPassword ? '•••••• (saved in Keychain)' : ''} onChange={(e) => setPassword(e.target.value)} />
            </label>
          </div>
          <label className="field">
            <span className="field-label">From address</span>
            <input value={s.smtp.from} placeholder="Agent Canvas <me@example.com>" onChange={(e) => smtp({ from: e.target.value })} />
          </label>
          <div className="copyrow">
            <input value={testTo} placeholder="Send a test email to…" onChange={(e) => setTestTo(e.target.value)} />
            <button className="btn sm" disabled={!testTo.includes('@')} onClick={() => test('smtp')}>
              Test SMTP
            </button>
            <button className="btn sm" disabled={!testTo.includes('@')} onClick={() => test('mail')} title="Sends via the Mail app">
              Test Mail app
            </button>
          </div>
        </div>
        <label className="field">
          <span className="field-label">Retry after rate limit (seconds)</span>
          <input type="number" min={0} value={Math.round(s.rateLimitRetryMs / 1000)} onChange={(e) => setS({ ...s, rateLimitRetryMs: Number(e.target.value) * 1000 })} />
        </label>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [workflows, setWorkflows] = useState<WorkflowView[]>([]);
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(() => {
    try {
      return localStorage.getItem('ac.current');
    } catch {
      return null;
    }
  });
  const [current, setCurrent] = useState<WorkflowView | null>(null);
  const [claude, setClaude] = useState<ClaudeStatus | null>(null);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [queue, setQueue] = useState<{ active: number; waiting: number; limit: number }>();
  const [liveRuns, setLiveRuns] = useState<Record<string, string[]>>({});
  const [toast, setToast] = useState<{ msg: string; kind: 'ok' | 'err' } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [inbox, setInbox] = useState<HumanRequest[]>([]);
  const [showInbox, setShowInbox] = useState(false);
  const [focus, setFocus] = useState<{ runId: string; nodeId?: string; nonce: number }>();
  const [view, setView] = useState<'dashboard' | 'workflows'>(() => {
    try {
      return (localStorage.getItem('ac.view') as 'dashboard' | 'workflows') || 'dashboard';
    } catch {
      return 'dashboard';
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('ac.view', view);
    } catch {
      /* storage unavailable */
    }
  }, [view]);
  const dirtyRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const notify = useCallback((msg: string, kind: 'ok' | 'err' = 'ok') => {
    setToast({ msg, kind });
    setTimeout(() => setToast((t) => (t?.msg === msg ? null : t)), kind === 'err' ? 7000 : 3000);
  }, []);
  const onDirty = useCallback((d: boolean) => {
    dirtyRef.current = d;
  }, []);

  const refreshList = () => api.listWorkflows().then(setWorkflows);

  useEffect(() => {
    void refreshList();
    api.templates().then(setTemplates);
    api.claude().then(setClaude);
    api.inbox().then(setInbox);
    api.usage().then((u) => {
      setUsage(u.usage);
      setQueue(u.queue);
    });
    const onUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);

  useEffect(
    () =>
      subscribe((e) => {
        if (e.type === 'usage') setUsage(e.usage);
        if (e.type === 'inbox') {
          const r = e.request;
          setInbox((list) => (r.status === 'pending' ? [...list.filter((x) => x.id !== r.id), r] : list.filter((x) => x.id !== r.id)));
          if (r.status === 'pending' && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
            new Notification(r.kind === 'review' ? `Review needed: ${r.title}` : `${r.nodeName} has a question`, { body: r.kind === 'review' ? r.workflowName : r.body.slice(0, 160) });
          }
        }
        if (e.type === 'run') {
          // Track live run ids per workflow for the sidebar spinner.
          setLiveRuns((m) => {
            const ids = (m[e.run.workflowId] ?? []).filter((id) => id !== e.run.id);
            if (e.run.status === 'running') ids.push(e.run.id);
            return { ...m, [e.run.workflowId]: ids };
          });
          api.usage().then((u) => setQueue(u.queue));
        }
        if (e.type === 'node') api.usage().then((u) => setQueue(u.queue));
      }),
    [],
  );

  useEffect(() => {
    try {
      if (currentId) localStorage.setItem('ac.current', currentId);
      else localStorage.removeItem('ac.current');
    } catch {
      /* storage unavailable */
    }
    if (!currentId) {
      setCurrent(null);
      return;
    }
    api
      .getWorkflow(currentId)
      .then(setCurrent)
      .catch(() => setCurrentId(null));
  }, [currentId]);

  // Links in notifications open the app at /?review=<id>.
  const deepLinked = useRef(false);
  useEffect(() => {
    if (deepLinked.current) return;
    const id = new URLSearchParams(location.search).get('review');
    if (!id) return;
    const r = inbox.find((x) => x.id === id);
    if (!r && !inbox.length) return; // inbox not loaded yet
    deepLinked.current = true;
    history.replaceState(null, '', location.pathname);
    if (r) nav.openRun(r.workflowId, r.runId, r.nodeId);
    else notify('That request was already answered or has expired.', 'ok');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inbox]);

  useEffect(() => {
    document.title = inbox.length ? `(${inbox.length}) Agent Canvas` : 'Agent Canvas';
  }, [inbox.length]);

  const open = (id: string) => {
    if (id === currentId) return;
    if (dirtyRef.current && !confirm('Discard unsaved changes?')) return;
    dirtyRef.current = false;
    setCurrentId(id);
  };

  const nav = {
    openWorkflow: (id: string) => {
      setView('workflows');
      open(id);
    },
    openRun: (workflowId: string, runId: string, nodeId?: string) => {
      setView('workflows');
      open(workflowId);
      setFocus({ runId, nodeId, nonce: Date.now() });
    },
  };

  const createBlank = async () => {
    const wf = await api.createWorkflow({ name: 'Untitled workflow' });
    await refreshList();
    open(wf.id);
  };

  const createFromTemplate = async (key: string) => {
    const wf = await api.fromTemplate(key);
    await refreshList();
    open(wf.id);
    notify('Template added. Check each agent’s working directory before running.', 'ok');
  };

  const importFile = async (file: File) => {
    try {
      const json = JSON.parse(await file.text());
      const wf = await api.createWorkflow(json);
      await refreshList();
      open(wf.id);
      notify(`Imported "${wf.name}"`, 'ok');
    } catch (e) {
      notify(`Import failed: ${(e as Error).message}`, 'err');
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">✦</span> Agent Canvas
        </div>
        <nav className="tabs-main" aria-label="Main">
          <button className={view === 'dashboard' ? 'on' : ''} aria-current={view === 'dashboard' ? 'page' : undefined} onClick={() => setView('dashboard')}>
            Dashboard
          </button>
          <button className={view === 'workflows' ? 'on' : ''} aria-current={view === 'workflows' ? 'page' : undefined} onClick={() => setView('workflows')}>
            Workflows
          </button>
        </nav>
        <span className="spacer" />
        <UsageMeter usage={usage} queue={queue} />
        <button className={`btn sm inbox-btn ${inbox.length ? 'has' : ''}`} onClick={() => setShowInbox(!showInbox)} title="Reviews and questions waiting for you">
          Inbox{inbox.length ? <span className="count">{inbox.length}</span> : null}
        </button>
        <ClaudeBadge status={claude} onRefresh={() => api.claude(true).then(setClaude)} />
        <button className="btn ghost sm" onClick={() => setShowSettings(true)}>
          Settings
        </button>
      </header>

      {view === 'dashboard' ? (
        <div className="main dash-main">
          <Dashboard
            inbox={inbox}
            claude={claude}
            workflows={workflows.map((w) => ({ id: w.id, name: w.name }))}
            nav={nav}
            notify={notify}
            onOpenInbox={() => setShowInbox(true)}
            onWorkflowsChanged={() => void refreshList()}
          />
        </div>
      ) : (
      <div className="main">
        <nav className="sidebar">
          <div className="side-actions">
            <button className="btn primary block" onClick={createBlank}>
              + New workflow
            </button>
            <button className="btn ghost block" onClick={() => fileRef.current?.click()}>
              Import JSON
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importFile(f);
                e.target.value = '';
              }}
            />
          </div>

          <div className="side-title">Your workflows</div>
          <ul className="wf-list">
            {workflows.length === 0 && <li className="muted small pad">None yet. Start blank or from a template.</li>}
            {workflows.map((w) => (
              <li key={w.id} className={w.id === currentId ? 'on' : ''} onClick={() => open(w.id)}>
                <span className={`dot ${w.enabled ? 'on' : ''}`} title={w.enabled ? 'Enabled' : 'Disabled'} />
                <span className="wf-li-name">{w.name}</span>
                {inbox.some((r) => r.workflowId === w.id) ? (
                  <span className="wait-dot" title="Waiting for you">
                    ●
                  </span>
                ) : liveRuns[w.id]?.length ? <span className="spinner" title="Running" /> : w.issues.length ? <span className="fnode-issue" title="Has issues">!</span> : null}
              </li>
            ))}
          </ul>

          <div className="side-title">Templates</div>
          <ul className="tpl-list">
            {templates.map((t) => (
              <li key={t.key} onClick={() => createFromTemplate(t.key)} title={t.description}>
                <span className={`tag tag-${t.pattern}`}>{PATTERN_LABEL[t.pattern]}</span>
                <span className="tpl-name">{t.name}</span>
                <span className="tpl-desc">{t.description}</span>
              </li>
            ))}
          </ul>
        </nav>

        <main className="content">
          {current ? (
            <ReactFlowProvider key={current.id}>
              <Editor
                workflow={current}
                notify={notify}
                onDirty={onDirty}
                inbox={inbox}
                focus={focus}
                onSaved={(wf) => setWorkflows((ws) => ws.map((w) => (w.id === wf.id ? wf : w)))}
                onDelete={async () => {
                  await api.deleteWorkflow(current.id);
                  dirtyRef.current = false;
                  setCurrentId(null);
                  await refreshList();
                  notify('Workflow deleted', 'ok');
                }}
              />
            </ReactFlowProvider>
          ) : (
            <div className="welcome">
              <h1>Build agents visually, run them on your Claude subscription</h1>
              <p className="muted">
                Every agent runs through the Claude Code CLI installed on this machine, using the account you logged into with <code>claude</code>. No API key needed. Your
                credentials never pass through this app.
              </p>
              <div className="patterns">
                <div>
                  <span className="tag tag-monitor">Monitor</span>
                  <p>
                    <b>Schedule</b> → Agent → Condition. Watch logs, dashboards or repos on a timer and act only when something is wrong.
                  </p>
                </div>
                <div>
                  <span className="tag tag-triggered">Triggered</span>
                  <p>
                    <b>File watch</b> or <b>Webhook</b> → Agent. React when a file lands or another system calls you.
                  </p>
                </div>
                <div>
                  <span className="tag tag-pipeline">Pipeline</span>
                  <p>
                    Agent → Agent → Agent, with parallel branches and <b>Merge</b>. Each step gets the previous step’s output.
                  </p>
                </div>
              </div>
              <div className="welcome-actions">
                <button className="btn primary" onClick={createBlank}>
                  + New workflow
                </button>
                {templates[0] && (
                  <button className="btn" onClick={() => createFromTemplate(templates[0].key)}>
                    Try the “{templates[0].name}” template
                  </button>
                )}
              </div>
            </div>
          )}
        </main>
      </div>
      )}

      {showInbox && (
        <aside className="inbox" aria-label="Inbox">
          <div className="inbox-head">
            <strong>Waiting for you</strong>
            <span className="spacer" />
            <button className="btn ghost sm" onClick={() => setShowInbox(false)} aria-label="Close inbox">
              ✕
            </button>
          </div>
          <div className="inbox-list">
            {inbox.length === 0 && <p className="muted small pad">Nothing waiting. Reviews and agent questions show up here.</p>}
            {inbox.map((r) => (
              <RespondCard
                key={r.id}
                request={r}
                showSource
                notify={notify}
                onOpen={() => {
                  nav.openRun(r.workflowId, r.runId, r.nodeId);
                  setShowInbox(false);
                }}
              />
            ))}
          </div>
        </aside>
      )}
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} notify={notify} />}
      {toast && (
        <div className={`toast ${toast.kind}`} role="status">
          {toast.msg}
        </div>
      )}
    </div>
  );
}
