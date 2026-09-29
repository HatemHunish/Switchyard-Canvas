import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { ago, clock } from '../lib/format';
import { closeViewer, moveViewer, openViewer, useViewer } from '../lib/viewer';

interface Info {
  id: string;
  name: string;
  format: string;
  bytes: number;
  createdAt: number;
  path: string;
  workflowName?: string;
  exists: boolean;
  viewer: 'pdf' | 'image' | 'video' | 'audio' | 'page' | 'none';
}

const size = (b: number) => (b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${Math.round(b / 1024)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);
const ext = (name: string) => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '');

/** In-app viewer for files runs produced: PDF, Markdown, Word, Excel, PowerPoint, CSV, JSON, HTML, images, media, code and text. */
export function FileViewer() {
  const v = useViewer();
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState('');
  const [actual, setActual] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const file = v?.files[v.index];

  useEffect(() => {
    if (!file) return;
    setInfo(null);
    setError('');
    setActual(false);
    fetch(`/api/files/${file.id}/info`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('This file is no longer registered.'))))
      .then(setInfo)
      .catch((e) => setError(e.message));
  }, [file?.id]);

  useEffect(() => {
    if (!v) return;
    const prev = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeViewer();
      else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !(e.target as HTMLElement)?.closest?.('input, textarea, select') && v.files.length > 1) moveViewer(e.key === 'ArrowRight' ? 1 : -1);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [!!v, v?.files.length]);

  if (!v || !file) return null;
  const src = `/api/files/${file.id}`;
  const multi = v.files.length > 1;

  const body = () => {
    if (error) return <div className="fv-empty">{error}</div>;
    if (!info) return <div className="fv-empty muted">Loading…</div>;
    if (!info.exists)
      return (
        <div className="fv-empty">
          <p>This file was moved or deleted.</p>
          <p className="muted small mono">{info.path}</p>
        </div>
      );
    switch (info.viewer) {
      case 'pdf':
        // The browser's own PDF viewer; some browsers (or settings) don't have one.
        if (navigator.pdfViewerEnabled === false)
          return (
            <div className="fv-empty">
              <p>This browser can’t show PDFs inline.</p>
              <div className="row-btns">
                <button className="btn primary sm" onClick={() => void api.openFile(file.id, 'open')}>
                  Open in Preview
                </button>
                <a className="btn sm" href={src} target="_blank" rel="noreferrer">
                  Open in a new tab
                </a>
              </div>
            </div>
          );
        return <iframe key={file.id} className="fv-frame" src={src} title={info.name} />;
      case 'image':
        return (
          <div className={`fv-image ${actual ? 'actual' : ''}`} onClick={() => setActual(!actual)} title={actual ? 'Fit to window' : 'Actual size'}>
            <img src={src} alt={info.name} />
          </div>
        );
      case 'video':
        return (
          <div className="fv-media">
            <video src={src} controls />
          </div>
        );
      case 'audio':
        return (
          <div className="fv-media">
            <audio src={src} controls />
          </div>
        );
      case 'page':
        // Rendered server-side and sandboxed (no scripts); links open in a new tab.
        return <iframe key={file.id} className="fv-frame" src={`${src}/view`} title={info.name} sandbox="allow-popups allow-popups-to-escape-sandbox" />;
      default:
        return (
          <div className="fv-empty">
            <p>No preview for {ext(info.name) ? `.${ext(info.name)}` : 'this kind of'} files.</p>
            <button className="btn primary sm" onClick={() => void api.openFile(file.id, 'open')}>
              Open in its app
            </button>
          </div>
        );
    }
  };

  return (
    <div className="fv-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closeViewer()}>
      <div className="fv" role="dialog" aria-modal="true" aria-label={`Preview of ${file.name}`}>
        <header className="fv-head">
          <span className="file-fmt">{ext(file.name) || file.format || 'file'}</span>
          <div className="fv-title">
            <b title={info?.path}>{file.name}</b>
            <span className="muted small">
              {info ? [size(info.bytes), info.createdAt && <span key="t" title={clock(info.createdAt)}>{ago(info.createdAt)}</span>, info.workflowName].filter(Boolean).map((x, i) => (
                <span key={i}>
                  {i > 0 && ' · '}
                  {x}
                </span>
              )) : ' '}
            </span>
          </div>
          {multi && (
            <div className="fv-nav">
              <button className="btn ghost sm" onClick={() => moveViewer(-1)} aria-label="Previous file" title="Previous (←)">
                ‹
              </button>
              <span className="muted small">
                {v.index + 1} / {v.files.length}
              </span>
              <button className="btn ghost sm" onClick={() => moveViewer(1)} aria-label="Next file" title="Next (→)">
                ›
              </button>
            </div>
          )}
          <span className="spacer" />
          <button className="btn ghost sm" onClick={() => void api.openFile(file.id, 'open')} title="Open in its default app">
            Open in app
          </button>
          <button className="btn ghost sm" onClick={() => void api.openFile(file.id, 'reveal')}>
            Show in Finder
          </button>
          <a className="btn ghost sm" href={`${src}?download=1`}>
            Download
          </a>
          <a className="btn ghost sm" href={info?.viewer === 'page' ? `${src}/view` : src} target="_blank" rel="noreferrer" title="Open this preview in a new tab">
            ↗
          </a>
          <button ref={closeRef} className="btn ghost sm" onClick={closeViewer} aria-label="Close preview" title="Close (Esc)">
            ✕
          </button>
        </header>
        <div className={`fv-main ${multi ? 'with-list' : ''}`}>
          {multi && (
            <ul className="fv-list" aria-label="Files">
              {v.files.map((f, i) => (
                <li key={f.id}>
                  <button className={i === v.index ? 'on' : ''} aria-current={i === v.index} onClick={() => openViewer(v.files, i)} title={f.name}>
                    <span className="file-fmt">{ext(f.name) || f.format}</span>
                    <span className="fv-list-name">{f.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="fv-body">{body()}</div>
        </div>
      </div>
    </div>
  );
}
