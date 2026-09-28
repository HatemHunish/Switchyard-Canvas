import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { NodeEvent, NodeRun } from '../types';

function EventRow({ e }: { e: NodeEvent }) {
  const [open, setOpen] = useState(false);
  if (e.t === 'tool') {
    const input = typeof e.input === 'object' && e.input ? (e.input as Record<string, unknown>) : {};
    const brief = String(input.command ?? input.file_path ?? input.pattern ?? input.path ?? input.url ?? input.query ?? '');
    return (
      <div className="ev ev-tool" onClick={() => setOpen(!open)}>
        <span className="ev-tag">{e.name}</span> <span className="mono">{brief.slice(0, 120)}</span>
        {open && <pre className="code">{JSON.stringify(e.input, null, 2)}</pre>}
      </div>
    );
  }
  if (e.t === 'tool_result') {
    return (
      <div className="ev ev-result" onClick={() => setOpen(!open)}>
        <span className="ev-tag">result</span> <span className="mono">{open ? '' : (e.text ?? '').split('\n')[0].slice(0, 100)}</span>
        {open && <pre className="code">{e.text}</pre>}
      </div>
    );
  }
  return <div className={`ev ev-${e.t}`}>{e.text}</div>;
}

export function RunOutput({ nodeRun }: { nodeRun: NodeRun }) {
  const [tab, setTab] = useState<'output' | 'activity' | 'prompt'>(nodeRun.status === 'running' ? 'activity' : 'output');
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (nodeRun.status === 'running') setTab('activity');
  }, [nodeRun.status]);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [nodeRun.events.length, tab]);

  const out = nodeRun.output;
  const resume = nodeRun.sessionId ? `claude --resume ${nodeRun.sessionId}` : '';

  return (
    <section className="runout">
      <div className="runout-head">
        <span className={`pill st-${nodeRun.status}`}>{nodeRun.status}</span>
        {nodeRun.startedAt && nodeRun.finishedAt && <span className="muted small">{((nodeRun.finishedAt - nodeRun.startedAt) / 1000).toFixed(1)}s</span>}
        {nodeRun.costUsd ? <span className="muted small" title="Equivalent API cost reported by the CLI; on a subscription this counts toward your usage limits, not a bill.">≈${nodeRun.costUsd.toFixed(3)}</span> : null}
        <div className="tabs">
          {(['output', 'activity', 'prompt'] as const).map((t) => (
            <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {t}
              {t === 'activity' && nodeRun.events.length ? ` (${nodeRun.events.length})` : ''}
            </button>
          ))}
        </div>
      </div>

      {tab === 'output' && (
        <div className="runout-body">
          {nodeRun.error && <div className="err">{nodeRun.error}</div>}
          {out?.files?.length ? (
            <ul className="files-out">
              {out.files.map((f) => (
                <li key={f.id}>
                  <div className="file-top">
                    <span className="file-fmt">{f.format}</span>
                    <a href={`/api/files/${f.id}`} target="_blank" rel="noreferrer" title={f.path}>
                      {f.name}
                    </a>
                    <span className="muted small">{Math.max(1, Math.round(f.bytes / 1024))} KB</span>
                  </div>
                  <div className="file-actions">
                  <button className="linkbtn" onClick={() => api.openFile(f.id, 'open')}>
                    Open
                  </button>
                  <button className="linkbtn" onClick={() => api.openFile(f.id, 'reveal')}>
                    Show in Finder
                  </button>
                  <a className="linkbtn" href={`/api/files/${f.id}?download=1`}>
                    Download
                  </a>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
          {out?.reason && out.pass === undefined && <div className="verdict yes">{out.reason}</div>}
          {out?.pass !== undefined && (
            <div className={`verdict ${out.pass ? 'yes' : 'no'}`}>
              {out.pass ? 'Yes' : 'No'}
              {out.reason ? `: ${out.reason}` : ''}
            </div>
          )}
          {out?.structured !== undefined ? (
            <pre className="code">{JSON.stringify(out.structured, null, 2)}</pre>
          ) : out?.text ? (
            <pre className="text">{out.text}</pre>
          ) : (
            !nodeRun.error && <p className="muted small">{nodeRun.status === 'running' ? 'Working…' : 'No output.'}</p>
          )}
          {resume && (
            <div className="resume">
              <span className="muted small">Continue this session in your terminal:</span>
              <code onClick={() => navigator.clipboard?.writeText(resume)} title="Click to copy">
                {resume}
              </code>
            </div>
          )}
        </div>
      )}
      {tab === 'activity' && (
        <div className="runout-body log" ref={logRef}>
          {nodeRun.events.length ? nodeRun.events.map((e, i) => <EventRow key={i} e={e} />) : <p className="muted small">No activity yet.</p>}
        </div>
      )}
      {tab === 'prompt' && (
        <div className="runout-body">
          <pre className="text">{nodeRun.prompt || '(no prompt: this step does not call Claude)'}</pre>
        </div>
      )}
    </section>
  );
}
