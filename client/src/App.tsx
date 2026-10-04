import { ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type ClaudeStatus, type Settings, type TemplateInfo, type WorkflowView } from './api';
import { Dashboard } from './components/dashboard/Dashboard';
import { Editor } from './components/Editor';
import { FileViewer } from './components/FileViewer';
import { datasetIdFor, Insights } from './components/insights/Insights';
import { PluginsPage } from './components/PluginsPage';
import { Setup } from './components/Setup';
import { Describe, TemplateWizard } from './components/Builder';
import { loadMode, saveProfile, setMode, useSettingsState } from './lib/mode';
import { friendly } from './lib/plain';
import { RespondCard } from './components/RespondCard';
import { subscribe } from './lib/live';
import type { HumanRequest, UsageInfo } from './types';

const PATTERN_LABEL = { monitor: 'Monitor', triggered: 'Triggered', pipeline: 'Pipeline', human: 'With approval', memory: 'Memory / RAG', orchestrator: 'Orchestrator', output: 'Files & actions', insights: 'Media & insights', plugin: 'Plugin' } as const;

type View = 'dashboard' | 'workflows' | 'insights' | 'plugins';
const VIEWS: Array<{ id: View; label: string }> = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'workflows', label: 'Workflows' },
  { id: 'insights', label: 'Insights' },
  { id: 'plugins', label: 'Plugins' },
];

function ClaudeBadge({ status, onRefresh, onSetup }: { status: ClaudeStatus | null; onRefresh: () => void; onSetup: () => void }) {
  if (!status) return <span className="badge">Checking Claude…</span>;
  if (!status.installed || !status.loggedIn)
    return (
      <button className="badge bad" onClick={onSetup} title={status.error}>
        {!status.installed ? 'Claude isn’t installed · Set up' : 'Claude isn’t connected · Connect'}
      </button>
    );
  const sub = status.authMethod === 'claude.ai' ? `${status.subscriptionType ?? 'subscription'} plan` : (status.authMethod ?? 'logged in');
  return (
    <button className="badge ok" onClick={onRefresh} title={`${status.version} · click to re-check`}>
      ● Claude · {sub}
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

/** Only in the packaged Mac app: start at login, and quit (the server keeps running when the browser tab closes). */
function AppControls({ notify }: { notify: (m: string, k?: 'ok' | 'err') => void }) {
  const [info, setInfo] = useState<{ bundled: boolean; loginItem: boolean } | null>(null);
  useEffect(() => {
    api.appInfo().then(setInfo).catch(() => setInfo(null));
  }, []);
  if (!info?.bundled) return null;
  return (
    <div className="settings-section">
      <label className="toggle-row">
        <input
          type="checkbox"
          checked={info.loginItem}
          onChange={async (e) => {
            try {
              setInfo({ ...info, ...(await api.setLoginItem(e.target.checked)) });
            } catch (err) {
              notify((err as ApiError).message, 'err');
            }
          }}
        />
        <span>
          <b>Start Agent Canvas when I log in</b>
          <span className="field-hint">So schedules keep running after a restart. It runs in the background; open the app to see it.</span>
        </span>
      </label>
      <button
        className="btn sm danger"
        onClick={async () => {
          if (!confirm('Quit Agent Canvas? Schedules and file watches stop until you open it again.')) return;
          await api.quit();
          document.body.innerHTML = '<p style="font:15px system-ui;color:#e6ebf2;background:#0b0f16;margin:0;padding:40px;height:100vh">Agent Canvas has quit. Open it again from Applications.</p>';
        }}
      >
        Quit Agent Canvas
      </button>
    </div>
  );
}

function SettingsDialog({ onClose, notify, onSetup }: { onClose: () => void; notify: (m: string, k?: 'ok' | 'err') => void; onSetup: () => void }) {
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
          <span className="field-label">Your email address</span>
          <input type="email" value={s.userEmail ?? ''} placeholder="you@example.com" onChange={(e) => setS({ ...s, userEmail: e.target.value })} />
          <span className="field-hint">Where “send it to me” emails go by default.</span>
        </label>
        <label className="toggle-row">
          <input type="checkbox" checked={s.uiMode === 'advanced'} onChange={(e) => setS({ ...s, uiMode: e.target.checked ? 'advanced' : 'simple' })} />
          <span>
            <b>Advanced mode</b>
            <span className="field-hint">Show every technical setting (tools, models, permissions, cron, JSON).</span>
          </span>
        </label>
        <button className="btn sm" onClick={onSetup}>
          Set up Claude again…
        </button>
        <AppControls notify={notify} />
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
        <div className="row2">
          <label className="field">
            <span className="field-label">Max turns per AI step</span>
            <input type="number" min={1} value={s.maxTurns} onChange={(e) => setS({ ...s, maxTurns: Number(e.target.value) })} />
          </label>
          <label className="field">
            <span className="field-label">Max spend per AI step ($, 0 = no limit)</span>
            <input type="number" min={0} step={0.5} value={s.maxBudgetUsd} onChange={(e) => setS({ ...s, maxBudgetUsd: Number(e.target.value) })} />
          </label>
        </div>
        <span className="field-hint">Defaults for steps that don't set their own. A step that reaches a limit stops and says which one. Spend is Claude Code's estimate.</span>
        <label className="field">
          <span className="field-label">Sites every agent's shell commands may reach</span>
          <input
            defaultValue={(s.sandboxDomains ?? []).join(', ')}
            placeholder="none, e.g. pypi.org, github.com"
            // Parsed when you leave the field, so typing commas and spaces isn't interrupted.
            onBlur={(e) => setS({ ...s, sandboxDomains: e.target.value.split(/[\s,]+/).filter(Boolean) })}
          />
          <span className="field-hint">Agents' shell commands run in a sandbox with no network; list sites here (or on a step) to allow them.</span>
        </label>
        <div className="row2">
          <label className="field">
            <span className="field-label">Retries after a usage limit</span>
            <input type="number" min={0} max={10} value={s.rateLimitRetries} onChange={(e) => setS({ ...s, rateLimitRetries: Number(e.target.value) })} />
          </label>
          <label className="field">
            <span className="field-label">First retry after (seconds)</span>
            <input type="number" min={0} value={Math.round(s.rateLimitRetryMs / 1000)} onChange={(e) => setS({ ...s, rateLimitRetryMs: Number(e.target.value) * 1000 })} />
          </label>
        </div>
        <label className="field">
          <span className="field-label">Wait for a usage-limit reset up to (minutes)</span>
          <input type="number" min={0} value={Math.round(s.rateLimitMaxWaitMs / 60000)} onChange={(e) => setS({ ...s, rateLimitMaxWaitMs: Number(e.target.value) * 60000 })} />
          <span className="field-hint">When Claude reports when the limit resets and that's sooner than this, the step waits and retries; otherwise it fails and tells you the reset time.</span>
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
  const [view, setView] = useState<View>(() => {
    try {
      const v = localStorage.getItem('ac.view') as View;
      return VIEWS.some((x) => x.id === v) ? v : 'dashboard';
    } catch {
      return 'dashboard';
    }
  });
  const [insightsFor, setInsightsFor] = useState<string>();
  const settingsState = useSettingsState();
  const simple = settingsState.mode === 'simple';
  const [showSetup, setShowSetup] = useState(false);
  /** Bumped to focus the "describe it" box on the dashboard. */
  const [describeNonce, setDescribeNonce] = useState(0);
  const [wizard, setWizard] = useState<TemplateInfo | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem('ac.view', view);
    } catch {
      /* storage unavailable */
    }
  }, [view]);
  const dirtyRef = useRef(false);

  // First run: show setup until it's done or skipped.
  useEffect(() => {
    if (settingsState.loaded && !settingsState.setupDone) setShowSetup(true);
  }, [settingsState.loaded, settingsState.setupDone]);

  // Components deep in the tree (e.g. an error's "Open Plugins" button) ask to navigate.
  useEffect(() => {
    const on = (e: Event) => {
      const to = (e as CustomEvent).detail;
      if (to === 'plugins') setView('plugins');
      else if (to === 'settings') setShowSettings(true);
      else if (to === 'setup') setShowSetup(true);
    };
    window.addEventListener('ac:navigate', on);
    return () => window.removeEventListener('ac:navigate', on);
  }, []);
  const fileRef = useRef<HTMLInputElement>(null);

  const notify = useCallback((raw: string, kind: 'ok' | 'err' = 'ok') => {
    const msg = kind === 'err' ? (friendly(raw)?.text ?? raw) : raw;
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

  const onCreated = async (wf: WorkflowView) => {
    setWizard(null);
    await refreshList();
    setView('workflows');
    dirtyRef.current = false;
    setCurrentId(wf.id);
  };

  const createFromTemplate = async (key: string) => {
    const t = templates.find((x) => x.key === key);
    // Simple mode: a few plain questions instead of a canvas full of placeholders.
    if (simple && t?.setup?.length) return setWizard(t);
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
          {VIEWS.map((v) => (
            <button key={v.id} className={view === v.id ? 'on' : ''} aria-current={view === v.id ? 'page' : undefined} onClick={() => setView(v.id)}>
              {v.label}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <div className="seg mode-switch" role="radiogroup" aria-label="Interface">
          <button role="radio" aria-checked={simple} className={simple ? 'on' : ''} onClick={() => void setMode('simple')} title="Plain language, only the settings most people need">
            Simple
          </button>
          <button role="radio" aria-checked={!simple} className={!simple ? 'on' : ''} onClick={() => void setMode('advanced')} title="Every setting: tools, models, permissions, cron, JSON">
            Advanced
          </button>
        </div>
        <UsageMeter usage={usage} queue={queue} />
        <button className={`btn sm inbox-btn ${inbox.length ? 'has' : ''}`} onClick={() => setShowInbox(!showInbox)} title="Reviews and questions waiting for you">
          Inbox{inbox.length ? <span className="count">{inbox.length}</span> : null}
        </button>
        <ClaudeBadge status={claude} onRefresh={() => api.claude(true).then(setClaude)} onSetup={() => setShowSetup(true)} />
        <button className="btn ghost sm" onClick={() => setShowSettings(true)}>
          Settings
        </button>
      </header>

      {view === 'insights' ? (
        <div className="main dash-main">
          <Insights
            initial={insightsFor}
            templates={templates}
            notify={notify}
            onTemplate={(key) => {
              setView('workflows');
              void createFromTemplate(key);
            }}
          />
        </div>
      ) : view === 'plugins' ? (
        <div className="main dash-main">
          <PluginsPage notify={notify} />
        </div>
      ) : view === 'dashboard' ? (
        <div className="main dash-main">
          <Dashboard
            inbox={inbox}
            claude={claude}
            workflows={workflows.map((w) => ({ id: w.id, name: w.name }))}
            nav={nav}
            notify={notify}
            onOpenInbox={() => setShowInbox(true)}
            onWorkflowsChanged={() => void refreshList()}
            describeNonce={describeNonce}
            onCreated={(wf) => void onCreated(wf)}
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
                onOpenPlugins={() => setView('plugins')}
                onOpenInsights={(name) => {
                  setInsightsFor(datasetIdFor(name));
                  setView('insights');
                }}
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
            simple ? (
              <div className="welcome simple-welcome">
                <h1>Automate your work with Claude</h1>
                <p className="muted">Describe what you want, or start from a ready-made automation. Everything runs on your own Claude plan, on this Mac.</p>
                <Describe onCreated={(wf) => void onCreated(wf)} notify={notify} />
                <h2 className="welcome-sub">Ready-made automations</h2>
                <div className="ins-tpls">
                  {templates.map((t) => (
                    <button key={t.key} className="ins-tpl" onClick={() => void createFromTemplate(t.key)}>
                      <span className={`tag tag-${t.pattern}`}>{PATTERN_LABEL[t.pattern]}</span>
                      <b>{t.name}</b>
                      <span>{t.description}</span>
                    </button>
                  ))}
                </div>
              </div>
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
            )
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
      {showSettings && (
        <SettingsDialog
          onClose={() => {
            setShowSettings(false);
            void loadMode();
          }}
          notify={notify}
          onSetup={() => {
            setShowSettings(false);
            setShowSetup(true);
          }}
        />
      )}
      {wizard && <TemplateWizard template={wizard} onClose={() => setWizard(null)} onCreated={(wf) => void onCreated(wf)} notify={notify} />}
      {showSetup && (
        <Setup
          claude={claude}
          onClaude={setClaude}
          onClose={() => {
            setShowSetup(false);
            void saveProfile({ setupDone: true });
          }}
          onDone={(how) => {
            setShowSetup(false);
            if (how === 'templates') setView('workflows');
            else {
              setView('dashboard');
              if (how === 'describe') setDescribeNonce(Date.now());
            }
          }}
        />
      )}
      <FileViewer />
      {toast && (
        <div className={`toast ${toast.kind}`} role="status">
          {toast.msg}
        </div>
      )}
    </div>
  );
}
