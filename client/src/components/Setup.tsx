import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type ClaudeStatus, type SetupJob } from '../api';
import { saveProfile, setMode, useSettingsState } from '../lib/mode';

interface Props {
  claude: ClaudeStatus | null;
  onClaude: (s: ClaudeStatus) => void;
  /** Where to go when done: describe a workflow, pick a template, or just look around. */
  onDone: (start: 'describe' | 'templates' | 'explore') => void;
  onClose: () => void;
}

/** First-run setup: connect Claude (install + log in without a terminal), your email, how to start. */
export function Setup({ claude, onClaude, onDone, onClose }: Props) {
  const settings = useSettingsState();
  const [job, setJob] = useState<SetupJob | null>(null);
  const [email, setEmail] = useState(settings.userEmail);
  const [err, setErr] = useState('');
  const [advanced, setAdvanced] = useState(settings.mode === 'advanced');
  const poll = useRef<ReturnType<typeof setInterval>>();

  const ready = !!claude?.installed && !!claude.loggedIn;

  // While installing or waiting for the browser sign-in, keep checking.
  useEffect(() => {
    if (!job?.running) return;
    poll.current = setInterval(async () => {
      const j = await api.setupJob();
      setJob(j);
      const s = await api.claude(true);
      onClaude(s);
      if (!j.running || (j.kind === 'login' && s.loggedIn)) {
        clearInterval(poll.current);
        if (j.kind === 'login' && s.loggedIn && j.running) void api.cancelSetupJob();
      }
    }, 2500);
    return () => clearInterval(poll.current);
  }, [job?.running, onClaude]);

  const start = async (kind: 'install' | 'login') => {
    setErr('');
    if (kind === 'install' && !confirm('This downloads and runs Anthropic’s official Claude Code installer (from claude.ai). It takes about a minute. Continue?')) return;
    try {
      if (kind === 'install') await api.installClaude();
      else await api.loginClaude(email || undefined);
      setJob({ kind, running: true, log: [] });
    } catch (e) {
      setErr((e as ApiError).message);
    }
  };

  const finish = async (how: 'describe' | 'templates' | 'explore') => {
    try {
      if (email.trim() !== settings.userEmail) await saveProfile({ userEmail: email.trim() });
      if (advanced !== (settings.mode === 'advanced')) await setMode(advanced ? 'advanced' : 'simple');
      await saveProfile({ setupDone: true });
      onDone(how);
    } catch (e) {
      setErr((e as ApiError).message);
    }
  };

  const step1 = !claude ? (
    <p className="muted">Checking this Mac…</p>
  ) : !claude.installed ? (
    <>
      <p>This app runs its AI steps with <b>Claude Code</b>, Anthropic’s app for your Claude plan. It isn’t installed on this Mac yet.</p>
      <button className="btn primary" onClick={() => void start('install')} disabled={!!job?.running}>
        {job?.kind === 'install' && job.running ? 'Installing…' : 'Install Claude Code'}
      </button>
    </>
  ) : !claude.loggedIn ? (
    <>
      <p>
        Sign in with your <b>Claude account</b> (Pro, Max, Team or Enterprise). Your AI steps then run on your own plan. This app never sees your password.
      </p>
      <label className="field">
        <span className="field-label">Your Claude email (optional, fills in the sign-in page)</span>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
      </label>
      <button className="btn primary" onClick={() => void start('login')} disabled={!!job?.running && job.kind === 'login'}>
        {job?.kind === 'login' && job.running ? 'Waiting for you to sign in…' : 'Log in to Claude'}
      </button>
      {job?.kind === 'login' && job.running && <p className="field-hint">A browser window opened. Sign in there, then come back; this screen updates by itself.</p>}
    </>
  ) : (
    <p className="setup-ok">
      ✓ Connected to your Claude plan{claude.subscriptionType ? ` (${claude.subscriptionType})` : ''}. Claude Code {claude.version?.split(' ')[0]}.
    </p>
  );

  return (
    <div className="setup-back">
      <div className="setup" role="dialog" aria-label="Set up Agent Canvas">
        <header className="setup-head">
          <span className="logo">✦</span>
          <div>
            <h1>Welcome to Agent Canvas</h1>
            <p className="muted">Automate work with Claude: reports, monitoring, research, emails and more. Two minutes to set up.</p>
          </div>
          <button className="btn ghost sm" onClick={onClose} title="You can finish this later from Settings">
            Skip for now
          </button>
        </header>

        <ol className="setup-steps">
          <li className={ready ? 'done' : 'current'}>
            <h2>
              <span className="setup-num">{ready ? '✓' : 1}</span> Connect your Claude plan
            </h2>
            {step1}
            {job?.log?.length ? (
              <details className="setup-log" open={job.running && job.kind === 'install'}>
                <summary>{job.running ? 'Working…' : job.exitCode === 0 ? 'Finished' : 'Details'}</summary>
                <pre>{job.log.join('\n')}</pre>
              </details>
            ) : null}
            {job && !job.running && job.exitCode !== 0 && !ready && (
              <p className="warnish small">
                That didn’t finish. Try again, or open Terminal and run <code>{job.kind === 'install' ? 'curl -fsSL https://claude.ai/install.sh | bash' : 'claude'}</code>.
              </p>
            )}
            {claude && !ready && (
              <button className="linkbtn small" onClick={async () => onClaude(await api.claude(true))}>
                Check again
              </button>
            )}
          </li>

          <li className={ready ? 'current' : ''}>
            <h2>
              <span className="setup-num">2</span> Where should results go?
            </h2>
            <label className="field">
              <span className="field-label">Your email address (optional)</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
              <span className="field-hint">Used when an automation emails results “to me”, and for approval requests.</span>
            </label>
            <label className="toggle-row">
              <input type="checkbox" checked={advanced} onChange={(e) => setAdvanced(e.target.checked)} />
              <span>
                <b>I’m technical: show every setting</b>
                <span className="field-hint">Tools, models, permissions, cron schedules, JSON. You can switch any time at the top.</span>
              </span>
            </label>
          </li>

          <li className={ready ? 'current' : ''}>
            <h2>
              <span className="setup-num">3</span> How would you like to start?
            </h2>
            <div className="setup-starts">
              <button className="setup-start" onClick={() => void finish('describe')} disabled={!ready}>
                <b>💬 Describe what I want</b>
                <span>Say it in your own words; Claude builds the automation for you to check.</span>
              </button>
              <button className="setup-start" onClick={() => void finish('templates')}>
                <b>📋 Pick a ready-made one</b>
                <span>Brand monitoring, weekly reports, competitor watch, review digests…</span>
              </button>
              <button className="setup-start" onClick={() => void finish('explore')}>
                <b>👀 Just look around</b>
                <span>Go to the dashboard.</span>
              </button>
            </div>
            {!ready && <p className="field-hint">Connect Claude first to run anything. You can still browse.</p>}
          </li>
        </ol>
        {err && <p className="warnish">{err}</p>}
      </div>
    </div>
  );
}
