import { useState } from 'react';
import { api, ApiError } from '../api';
import type { NotifyChannel, NotifyConfig } from '../types';

const ADD: Array<{ type: NotifyChannel['type']; label: string }> = [
  { type: 'email', label: '✉️ Email' },
  { type: 'slack', label: '# Slack' },
  { type: 'teams', label: 'Teams' },
  { type: 'webhook', label: '🔗 Webhook' },
  { type: 'desktop', label: '🔔 Desktop' },
];

interface Props {
  value?: NotifyConfig;
  onChange: (v: NotifyConfig) => void;
  kind: 'review' | 'question';
  notify: (msg: string, kind?: 'ok' | 'err') => void;
}

/** "Tell someone it's waiting": channels + reminders, shared by Human review and question-asking agents. */
export function NotifyEditor({ value, onChange, kind, notify }: Props) {
  const cfg: NotifyConfig = value ?? { channels: [] };
  const [testing, setTesting] = useState(false);
  const set = (patch: Partial<NotifyConfig>) => onChange({ ...cfg, ...patch });
  const setCh = (i: number, patch: Partial<NotifyChannel>) => set({ channels: cfg.channels.map((c, j) => (j === i ? { ...c, ...patch } : c)) });

  const test = async () => {
    setTesting(true);
    try {
      const { results } = await api.testNotify(cfg, kind);
      const failed = results.filter((r) => !r.ok);
      notify(failed.length ? failed.map((r) => r.text).join(' · ') : results.map((r) => r.text).join(' · ') || 'No channels to test', failed.length ? 'err' : 'ok');
    } catch (e) {
      notify((e as ApiError).message, 'err');
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="notify-ed">
      {cfg.channels.map((c, i) => (
        <div key={i} className="notify-ch">
          <span className="notify-type">{ADD.find((a) => a.type === c.type)?.label}</span>
          {c.type === 'email' && (
            <>
              <input value={c.to ?? ''} placeholder="reviewer@example.com, …" onChange={(e) => setCh(i, { to: e.target.value })} />
              <select value={c.via ?? 'mail'} onChange={(e) => setCh(i, { via: e.target.value as 'mail' | 'smtp' })} title="How to send">
                <option value="mail">Mail app</option>
                <option value="smtp">SMTP</option>
              </select>
            </>
          )}
          {(c.type === 'slack' || c.type === 'teams' || c.type === 'webhook') && (
            <input
              className="mono"
              value={c.url ?? ''}
              placeholder={c.type === 'slack' ? 'https://hooks.slack.com/services/…' : c.type === 'teams' ? 'https://…webhook.office.com/…' : 'https://example.com/hook'}
              onChange={(e) => setCh(i, { url: e.target.value })}
            />
          )}
          {c.type === 'desktop' && <span className="muted small grow">macOS notification on this Mac</span>}
          <button className="linkbtn danger" onClick={() => set({ channels: cfg.channels.filter((_, j) => j !== i) })} aria-label="Remove channel">
            ✕
          </button>
        </div>
      ))}
      <div className="notify-add">
        {ADD.map((a) => (
          <button key={a.type} type="button" onClick={() => set({ channels: [...cfg.channels, { type: a.type, via: a.type === 'email' ? 'mail' : undefined }] })}>
            + {a.label}
          </button>
        ))}
      </div>
      {cfg.channels.length > 0 && (
        <>
          <div className="notify-remind">
            <span>Remind every</span>
            <input type="number" min={0} value={cfg.remindEveryMinutes ?? ''} placeholder="–" onChange={(e) => set({ remindEveryMinutes: e.target.value ? Number(e.target.value) : undefined })} />
            <span>min, up to</span>
            <input type="number" min={0} max={20} value={cfg.remindTimes ?? ''} placeholder="–" onChange={(e) => set({ remindTimes: e.target.value ? Number(e.target.value) : undefined })} />
            <span>times while it’s still waiting</span>
          </div>
          <div className="notify-foot">
            <span className="field-hint">
              Messages include the {kind === 'review' ? 'content to review' : 'question'} and a <b>Review now</b> link to answer without the canvas. Links point to this Mac unless you set a public URL in
              Settings. Email via the Mail app sends immediately.
            </span>
            <button className="btn sm" onClick={test} disabled={testing}>
              {testing ? 'Sending…' : 'Send test'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
