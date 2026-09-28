import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { HumanRequest } from '../types';

interface Props {
  request: HumanRequest;
  /** Show which workflow it belongs to (used in the inbox). */
  showSource?: boolean;
  onOpen?: () => void;
  notify: (msg: string, kind?: 'ok' | 'err') => void;
}

function remaining(expiresAt?: number) {
  if (!expiresAt) return '';
  const m = Math.max(0, Math.round((expiresAt - Date.now()) / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m left` : `${m}m left`;
}

/** Answer an agent's question, or approve/reject a review. */
export function RespondCard({ request, showSource, onOpen, notify }: Props) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  const review = request.kind === 'review';

  useEffect(() => {
    if (!request.expiresAt) return;
    const t = setInterval(() => tick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, [request.expiresAt]);

  const send = async (decision?: 'approve' | 'reject') => {
    setBusy(true);
    try {
      await api.respond(request.id, { decision, text: text.trim() || undefined });
      notify(
        !review
          ? 'Answer sent. The agent is continuing'
          : decision === 'approve'
            ? 'Approved'
            : request.reviseTo
              ? `Sent back to ${request.reviseTo}. It will revise and you’ll review again`
              : 'Rejected. Taking the “no” path',
        'ok',
      );
    } catch (err) {
      notify((err as ApiError).message, 'err');
      setBusy(false);
    }
  };

  return (
    <div className={`respond ${review ? 'is-review' : 'is-question'}`}>
      <div className="respond-head">
        <span className="respond-kind">{review ? '👤 Review' : '💬 Question'}</span>
        <span className="respond-title">{review ? request.title : request.nodeName}</span>
        {request.round > 1 && <span className="muted small">round {request.round}</span>}
        {request.expiresAt && <span className="muted small">· {remaining(request.expiresAt)}</span>}
      </div>
      {showSource && (
        <div className="respond-src muted small">
          {request.workflowName} · {new Date(request.createdAt).toLocaleTimeString()}
          {onOpen && (
            <button className="linkbtn" onClick={onOpen}>
              Open in canvas
            </button>
          )}
        </div>
      )}
      {review && request.instructions && <p className="respond-instr">{request.instructions}</p>}
      {review ? <pre className="text respond-body">{request.body}</pre> : <p className="respond-q">{request.body}</p>}
      <textarea
        rows={review ? 2 : 3}
        value={text}
        placeholder={
          !review
            ? 'Your answer…'
            : request.reviseTo
              ? `Feedback or missing info for ${request.reviseTo}…`
              : 'Comment (optional)'
        }
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !review && text.trim()) void send();
        }}
        autoFocus={!showSource}
      />
      {review && (
        <p className="respond-hint">
          {request.reviseTo ? (
            <>
              <b>↩ Send back</b> gives your text to <b>{request.reviseTo}</b>, which revises (in the same session) and returns a new version for review
              {request.maxRounds ? ` (round ${request.round} of ${request.maxRounds})` : ''}. <b>Approve</b> accepts this result as it is
              {text.trim() ? '; your text is only attached as a note' : ''}.
            </>
          ) : (
            <>
              <b>Approve</b> continues on the green path; <b>Reject</b> takes the red “no” path
              {request.maxRounds && request.round >= request.maxRounds ? ' (last review round)' : ''}. Your comment is passed along either way.
            </>
          )}
        </p>
      )}
      <div className="respond-actions">
        {review ? (
          request.reviseTo ? (
            <>
              <button className="btn" disabled={busy} onClick={() => send('approve')}>
                Approve as is
              </button>
              <button className={`btn ${text.trim() ? 'primary' : ''}`} disabled={busy} onClick={() => send('reject')}>
                ↩ Send back to {request.reviseTo}
              </button>
            </>
          ) : (
            <>
              <button className="btn danger" disabled={busy} onClick={() => send('reject')}>
                Reject
              </button>
              <button className="btn primary" disabled={busy} onClick={() => send('approve')}>
                Approve
              </button>
            </>
          )
        ) : (
          <button className="btn primary" disabled={busy || !text.trim()} onClick={() => send()} title="⌘Enter">
            Send answer
          </button>
        )}
      </div>
    </div>
  );
}
