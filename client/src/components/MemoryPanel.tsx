import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { MemoryItem, MemoryStats } from '../types';

interface Props {
  workflowId: string;
  nodeId: string;
  /** The node must be saved before its store can be read or indexed. */
  saved: boolean;
  hasSources: boolean;
  notify: (msg: string, kind?: 'ok' | 'err') => void;
}

const SOURCE_LABEL: Record<string, string> = { agent: 'saved by agent', answer: 'your answer', manual: 'added by you' };

/** Browse and manage what a memory store holds. */
export function MemoryPanel({ workflowId, nodeId, saved, hasSources, notify }: Props) {
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState('');
  const [content, setContent] = useState('');
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(
    async (query = q) => {
      if (!saved) return;
      try {
        const r = await api.memory(workflowId, nodeId, query);
        setStats(r.stats);
        setItems(r.items);
      } catch (err) {
        notify((err as ApiError).message, 'err');
      }
    },
    [workflowId, nodeId, saved, q, notify],
  );

  useEffect(() => {
    void load('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId, nodeId, saved]);

  if (!saved) return <div className="warn">Save the workflow to index documents and browse this memory.</div>;

  const index = async () => {
    setBusy(true);
    try {
      const r = await api.indexMemory(workflowId, nodeId);
      notify(`Indexed ${r.files} files: ${r.added} new, ${r.updated} changed, ${r.removed} removed${r.skipped ? `, ${r.skipped} skipped` : ''}`, 'ok');
      await load();
    } catch (err) {
      notify((err as ApiError).message, 'err');
    } finally {
      setBusy(false);
    }
  };

  const addNote = async () => {
    try {
      await api.addNote(workflowId, nodeId, key, content);
      setKey('');
      setContent('');
      await load();
    } catch (err) {
      notify((err as ApiError).message, 'err');
    }
  };

  return (
    <div className="mem">
      <div className="mem-stats">
        <div>
          <b>{stats?.notes ?? 0}</b>
          <span>notes</span>
        </div>
        <div>
          <b>{stats?.files ?? 0}</b>
          <span>files</span>
        </div>
        <div>
          <b>{stats?.chunks ?? 0}</b>
          <span>chunks</span>
        </div>
        <button className="btn sm" onClick={index} disabled={busy || !hasSources} title={hasSources ? 'Index new and changed files now' : 'Add a source above first'}>
          {busy ? 'Indexing…' : 'Index now'}
        </button>
      </div>
      {stats?.lastIndexedAt && <p className="muted small">Last indexed {new Date(stats.lastIndexedAt).toLocaleString()}</p>}

      <div className="copyrow">
        <input
          value={q}
          placeholder="Search memory…"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && load(q)}
        />
        <button className="btn sm" onClick={() => load(q)}>
          Search
        </button>
      </div>

      <ul className="mem-items">
        {items.length === 0 && <li className="muted small">{q ? 'No matches.' : 'Empty. Agents’ notes, your answers and indexed documents appear here.'}</li>}
        {items.map((it) => (
          <li key={it.id} className={`mem-item ${it.kind}`}>
            <div className="mem-item-head" onClick={() => setOpen(open === it.id ? null : it.id)}>
              <span className={`mem-kind ${it.kind}`}>{it.kind === 'note' ? 'note' : 'doc'}</span>
              <span className="mem-key" title={it.key}>
                {it.kind === 'chunk' ? it.key.split('/').slice(-2).join('/') : it.key}
              </span>
              {it.kind === 'note' && (
                <button
                  className="linkbtn danger"
                  onClick={async (e) => {
                    e.stopPropagation();
                    await api.deleteMemoryItem(workflowId, nodeId, it.id);
                    await load();
                  }}
                  aria-label="Delete note"
                >
                  delete
                </button>
              )}
            </div>
            <div className={`mem-content ${open === it.id ? 'open' : ''}`}>{it.content}</div>
            {it.kind === 'note' && open === it.id && <div className="muted small">{SOURCE_LABEL[it.source] ?? it.source} · {new Date(it.updatedAt).toLocaleString()}</div>}
          </li>
        ))}
      </ul>

      <details className="mem-add">
        <summary>Add a note</summary>
        <input value={key} placeholder="Key, e.g. customer:acme:contact" onChange={(e) => setKey(e.target.value)} />
        <textarea rows={2} value={content} placeholder="What agents should know" onChange={(e) => setContent(e.target.value)} />
        <button className="btn sm primary" disabled={!key.trim() || !content.trim()} onClick={addNote}>
          Save note
        </button>
      </details>

      <div className="mem-danger">
        <button
          className="linkbtn danger"
          onClick={async () => {
            if (!confirm('Delete all notes in this memory?')) return;
            await api.clearMemory(workflowId, nodeId, 'note');
            await load();
          }}
        >
          Clear notes
        </button>
        <button
          className="linkbtn danger"
          onClick={async () => {
            if (!confirm('Remove all indexed documents? (Index again to rebuild.)')) return;
            await api.clearMemory(workflowId, nodeId, 'chunk');
            await load();
          }}
        >
          Clear documents
        </button>
      </div>
    </div>
  );
}
