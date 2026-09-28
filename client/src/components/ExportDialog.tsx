import { useState } from 'react';
import { api, ApiError } from '../api';

interface Props {
  workflowId: string;
  agentCount: number;
  dirty: boolean;
  onClose: () => void;
  notify: (msg: string, kind?: 'ok' | 'err') => void;
}

export function ExportDialog({ workflowId, agentCount, dirty, onClose, notify }: Props) {
  const [dir, setDir] = useState(() => {
    try {
      return localStorage.getItem('ac.exportDir') || '~/';
    } catch {
      return '~/';
    }
  });
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<string[] | null>(null);

  const go = async () => {
    setBusy(true);
    try {
      const r = await api.exportAgents(workflowId, dir);
      setFiles(r.files);
      try {
        localStorage.setItem('ac.exportDir', dir);
      } catch {
        /* storage unavailable */
      }
      notify(`Exported ${r.files.length} agent${r.files.length === 1 ? '' : 's'}`, 'ok');
    } catch (err) {
      notify((err as ApiError).message, 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Export agents">
        <h3>Export agents to Claude Code</h3>
        <p className="muted">
          Writes each of the {agentCount} agent node{agentCount === 1 ? '' : 's'} as a subagent file in <code>&lt;project&gt;/.claude/agents/</code>. Inside Claude Code, <code>/agents</code> will list them
          and Claude can delegate to them. Use <code>~/</code> to make them available in every project (<code>~/.claude/agents/</code>).
        </p>
        {dirty && <div className="warn">You have unsaved changes; export uses the last saved version.</div>}
        <label className="field">
          <span className="field-label">Project directory</span>
          <input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="~/projects/my-app" />
        </label>
        {files && (
          <ul className="files">
            {files.map((f) => (
              <li key={f} className="mono small">
                {f}
              </li>
            ))}
          </ul>
        )}
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
          <button className="btn primary" disabled={busy || !agentCount || !dir.trim()} onClick={go}>
            {busy ? 'Exporting…' : 'Export'}
          </button>
        </div>
      </div>
    </div>
  );
}
