import type { Run } from '../types';

const TRIGGER_LABEL: Record<string, string> = {
  'trigger.manual': 'manual',
  'trigger.schedule': 'schedule',
  'trigger.file': 'file',
  'trigger.webhook': 'webhook',
};

function ago(ts: number) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

interface Props {
  runs: Run[];
  viewedRunId?: string;
  following: boolean;
  onSelect: (id: string) => void;
  onFollow: () => void;
  onCancel: (id: string) => void;
  onClose: () => void;
}

export function RunsPanel({ runs, viewedRunId, following, onSelect, onFollow, onCancel, onClose }: Props) {
  return (
    <div className="runs">
      <div className="runs-head">
        <strong>Run history</strong>
        <button className={`btn sm ${following ? 'on' : ''}`} onClick={onFollow} title="Always show the newest run on the canvas">
          {following ? '● Following live' : 'Follow live'}
        </button>
        <span className="spacer" />
        <button className="btn ghost sm" onClick={onClose} aria-label="Close run history">
          ✕
        </button>
      </div>
      <div className="runs-list">
        {runs.length === 0 && <p className="muted small pad">No runs yet. Press Run, or enable the workflow so its triggers fire.</p>}
        {runs.map((r) => (
          <div key={r.id} className={`run-row ${r.id === viewedRunId ? 'on' : ''}`} onClick={() => onSelect(r.id)}>
            <span className={`pill st-${r.status}`}>{r.status}</span>
            <span className="run-trig">{TRIGGER_LABEL[r.triggerKind] ?? r.triggerKind}</span>
            <span className="muted small">{ago(r.startedAt)}</span>
            <span className="muted small">{r.finishedAt ? `${Math.round((r.finishedAt - r.startedAt) / 1000)}s` : '…'}</span>
            {r.error && r.status === 'failed' && (
              <span className="run-err" title={r.error}>
                {r.error}
              </span>
            )}
            <span className="spacer" />
            {r.status === 'running' && (
              <button
                className="btn ghost danger sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onCancel(r.id);
                }}
              >
                Cancel
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
