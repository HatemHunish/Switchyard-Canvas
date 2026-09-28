import { BadRequestException, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Database from 'better-sqlite3';
import { readdirSync, readFileSync, statSync } from 'fs';
import { extname, join } from 'path';
import { DATA_DIR, expandHome } from '../common/paths';
import { MemoryData, MemoryItem, MemoryStats, WfNode } from '../common/types';

const TEXT_EXT = new Set([
  '.md', '.mdx', '.txt', '.rst', '.log', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.env.example',
  '.html', '.htm', '.xml', '.css', '.scss', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs', '.java',
  '.kt', '.cs', '.php', '.sh', '.sql', '.c', '.h', '.cpp', '.hpp', '.swift', '.vue', '.svelte',
]);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__', '.cache', 'coverage']);
const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES = 3000;
const CHUNK_CHARS = 1400;
const NOTE_INJECT_CHARS = 6000;

/** Where a memory node's data lives. Shared stores are addressed by name across workflows. */
export function storeIdFor(workflowId: string, node: WfNode): string {
  const d = node.data as MemoryData;
  if (d.scope === 'shared') {
    const name = (d.name || 'shared').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'shared';
    return `shared:${name}`;
  }
  return `wf:${workflowId}:${node.id}`;
}

/** Turns free text into a safe FTS5 query: quoted terms OR-ed together (BM25 ranks the best matches). */
export function toFtsQuery(text: string): string | null {
  const terms = [...new Set((text.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? []).filter((t) => !STOP.has(t)))].slice(0, 40);
  return terms.length ? terms.map((t) => `"${t}"`).join(' OR ') : null;
}
const STOP = new Set('the and for with that this from are was were you your our have has had not but can will what when where which who how why into about than then them they their there these those its also just any all use using'.split(' '));

function chunk(text: string): string[] {
  const paras = text.replace(/\r\n/g, '\n').split(/\n{2,}/);
  const out: string[] = [];
  let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length > CHUNK_CHARS) {
      out.push(cur.trim());
      // Small overlap keeps a sentence that spans a boundary findable from both sides.
      cur = cur.slice(-200) + '\n\n';
    }
    if (p.length > CHUNK_CHARS * 1.5) {
      for (let i = 0; i < p.length; i += CHUNK_CHARS) out.push(p.slice(i, i + CHUNK_CHARS));
      cur = '';
      continue;
    }
    cur += p + '\n\n';
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter((c) => c.length > 20);
}

/**
 * Context stores for agents: notes (facts, remembered answers) and indexed
 * documents, searched locally with SQLite FTS5/BM25. No embeddings API needed.
 */
@Injectable()
export class MemoryService implements OnModuleDestroy {
  private readonly logger = new Logger(MemoryService.name);
  private db = new Database(join(DATA_DIR, 'memory.db'));

  constructor() {
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY,
        store TEXT NOT NULL,
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        mtime INTEGER,
        run_id TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS items_by_store ON items (store, kind);
      CREATE UNIQUE INDEX IF NOT EXISTS notes_by_key ON items (store, key) WHERE kind = 'note';
      CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(key, content, tokenize = 'porter unicode61');
      CREATE TABLE IF NOT EXISTS stores (id TEXT PRIMARY KEY, last_indexed_at INTEGER);
    `);
  }

  onModuleDestroy() {
    this.db.close();
  }

  private insert(store: string, kind: 'note' | 'chunk', key: string, content: string, source: string, extra: { mtime?: number; runId?: string } = {}) {
    const info = this.db
      .prepare(`INSERT INTO items (store, kind, key, content, source, mtime, run_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(store, kind, key, content, source, extra.mtime ?? null, extra.runId ?? null, Date.now());
    this.db.prepare(`INSERT INTO items_fts (rowid, key, content) VALUES (?, ?, ?)`).run(info.lastInsertRowid, key, content);
    return Number(info.lastInsertRowid);
  }

  private remove(ids: number[]) {
    const delItem = this.db.prepare(`DELETE FROM items WHERE id = ?`);
    const delFts = this.db.prepare(`DELETE FROM items_fts WHERE rowid = ?`);
    this.db.transaction(() => ids.forEach((id) => (delItem.run(id), delFts.run(id))))();
  }

  /** Save (or overwrite) a note by key. */
  saveNote(store: string, key: string, content: string, source: 'agent' | 'answer' | 'manual', runId?: string): MemoryItem {
    key = key.trim().slice(0, 300);
    content = content.trim().slice(0, 20_000);
    if (!key || !content) throw new BadRequestException('key and content are required');
    return this.db.transaction(() => {
      const existing = this.db.prepare(`SELECT id FROM items WHERE store = ? AND kind = 'note' AND key = ?`).get(store, key) as { id: number } | undefined;
      if (existing) this.remove([existing.id]);
      const id = this.insert(store, 'note', key, content, source, { runId });
      return this.get(id)!;
    })();
  }

  get(id: number): MemoryItem | null {
    const r = this.db.prepare(`SELECT * FROM items WHERE id = ?`).get(id);
    return r ? toItem(r) : null;
  }

  deleteItem(store: string, id: number) {
    const r = this.db.prepare(`SELECT id FROM items WHERE id = ? AND store = ?`).get(id, store);
    if (r) this.remove([id]);
  }

  clear(store: string, kind?: 'note' | 'chunk') {
    const ids = (kind
      ? this.db.prepare(`SELECT id FROM items WHERE store = ? AND kind = ?`).all(store, kind)
      : this.db.prepare(`SELECT id FROM items WHERE store = ?`).all(store)) as Array<{ id: number }>;
    this.remove(ids.map((r) => r.id));
  }

  notes(stores: string[], limit = 200): MemoryItem[] {
    if (!stores.length) return [];
    const q = `SELECT * FROM items WHERE kind = 'note' AND store IN (${stores.map(() => '?').join(',')}) ORDER BY updated_at DESC LIMIT ?`;
    return this.db.prepare(q).all(...stores, limit).map(toItem);
  }

  /** Browse a store: newest notes first, then document chunks; or ranked matches for `query`. */
  list(store: string, query?: string, limit = 100): MemoryItem[] {
    if (query?.trim()) return this.search([store], query, limit);
    return this.db.prepare(`SELECT * FROM items WHERE store = ? ORDER BY kind DESC, updated_at DESC LIMIT ?`).all(store, limit).map(toItem);
  }

  search(stores: string[], query: string, limit = 6, kind?: 'note' | 'chunk'): MemoryItem[] {
    const fts = toFtsQuery(query);
    if (!fts || !stores.length) return [];
    const sql = `SELECT i.*, bm25(items_fts) AS score FROM items_fts JOIN items i ON i.id = items_fts.rowid
      WHERE items_fts MATCH ? AND i.store IN (${stores.map(() => '?').join(',')}) ${kind ? 'AND i.kind = ?' : ''}
      ORDER BY score LIMIT ?`;
    const args: unknown[] = [fts, ...stores, ...(kind ? [kind] : []), limit];
    return this.db.prepare(sql).all(...args).map(toItem);
  }

  stats(store: string): MemoryStats {
    const c = this.db
      .prepare(
        `SELECT SUM(kind = 'note') AS notes, SUM(kind = 'chunk') AS chunks, COUNT(DISTINCT CASE WHEN kind = 'chunk' THEN source END) AS files FROM items WHERE store = ?`,
      )
      .get(store) as { notes: number | null; chunks: number | null; files: number | null };
    const s = this.db.prepare(`SELECT last_indexed_at FROM stores WHERE id = ?`).get(store) as { last_indexed_at: number } | undefined;
    return { storeId: store, notes: c.notes ?? 0, chunks: c.chunks ?? 0, files: c.files ?? 0, lastIndexedAt: s?.last_indexed_at ?? undefined };
  }

  /**
   * Incrementally index files for RAG: new/changed files are (re)chunked,
   * unchanged files are skipped, files that disappeared are dropped.
   */
  index(store: string, sources: string[]): { files: number; added: number; updated: number; removed: number; skipped: number } {
    const files = new Map<string, number>();
    const skipped = { n: 0 };
    for (const raw of sources.map((s) => s.trim()).filter(Boolean)) {
      this.collect(expandHome(raw), files, skipped);
      if (files.size >= MAX_FILES) break;
    }
    const existing = new Map<string, { mtime: number; ids: number[] }>();
    for (const r of this.db.prepare(`SELECT id, source, mtime FROM items WHERE store = ? AND kind = 'chunk'`).all(store) as Array<{ id: number; source: string; mtime: number }>) {
      const e = existing.get(r.source) ?? { mtime: r.mtime, ids: [] };
      e.ids.push(r.id);
      existing.set(r.source, e);
    }
    let added = 0;
    let updated = 0;
    let removed = 0;
    this.db.transaction(() => {
      for (const [path, e] of existing) {
        if (!files.has(path)) {
          this.remove(e.ids);
          removed++;
        }
      }
      for (const [path, mtime] of files) {
        const e = existing.get(path);
        if (e && e.mtime === mtime) continue;
        let text: string;
        try {
          text = readFileSync(path, 'utf8');
        } catch {
          skipped.n++;
          continue;
        }
        if (text.includes('\u0000')) {
          skipped.n++;
          continue;
        }
        if (e) {
          this.remove(e.ids);
          updated++;
        } else added++;
        chunk(text).forEach((c, i) => this.insert(store, 'chunk', `${path}#${i + 1}`, c, path, { mtime }));
      }
      this.db.prepare(`INSERT INTO stores (id, last_indexed_at) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET last_indexed_at = excluded.last_indexed_at`).run(store, Date.now());
    })();
    return { files: files.size, added, updated, removed, skipped: skipped.n };
  }

  private collect(path: string, out: Map<string, number>, skipped: { n: number }) {
    let st;
    try {
      st = statSync(path);
    } catch {
      skipped.n++;
      return;
    }
    if (st.isDirectory()) {
      let entries: string[] = [];
      try {
        entries = readdirSync(path);
      } catch {
        return;
      }
      for (const name of entries) {
        if (out.size >= MAX_FILES) return;
        if (name.startsWith('.') && name !== '.github') continue;
        if (SKIP_DIRS.has(name)) continue;
        this.collect(join(path, name), out, skipped);
      }
    } else if (st.isFile()) {
      const ext = extname(path).toLowerCase();
      if ((TEXT_EXT.has(ext) || ext === '') && st.size <= MAX_FILE_BYTES) out.set(path, Math.floor(st.mtimeMs));
      else skipped.n++;
    }
  }

  /** The block added to an agent's system prompt for its connected stores. */
  contextFor(stores: Array<{ id: string; data: MemoryData }>, prompt: string): string {
    const parts: string[] = [];
    const noteStores = stores.filter((s) => s.data.injectNotes).map((s) => s.id);
    const notes = this.notes(noteStores);
    if (notes.length) {
      let used = 0;
      const lines: string[] = [];
      for (const n of notes) {
        const line = `- ${n.key}: ${n.content.replace(/\n+/g, ' ')}`;
        if (used + line.length > NOTE_INJECT_CHARS) break;
        lines.push(line);
        used += line.length;
      }
      parts.push(`## Remembered notes\nFacts saved from earlier runs and answers the user already gave. Rely on these instead of asking again.\n${lines.join('\n')}`);
    }
    for (const s of stores.filter((x) => x.data.autoRetrieve > 0)) {
      const hits = this.search([s.id], prompt, s.data.autoRetrieve, 'chunk');
      if (hits.length) parts.push(`## Possibly relevant documents (${s.data.name})\n${hits.map((h) => `### ${h.key}\n${h.content}`).join('\n\n')}`);
    }
    const names = stores.map((s) => `"${s.data.name}"`).join(', ');
    const canWrite = stores.some((s) => s.data.allowWrite);
    parts.unshift(
      `## Memory\nYou have access to memory store(s) ${names}. Use the mcp__agent_canvas__memory_search tool to look up facts and documents before asking the user or guessing.${canWrite ? ' Use mcp__agent_canvas__memory_save to store durable facts that will help in future runs (decisions, preferences, names, answers), keyed by a short descriptive key.' : ''}`,
    );
    return parts.join('\n\n');
  }
}

function toItem(r: any): MemoryItem {
  return { id: r.id, kind: r.kind, key: r.key, content: r.content, source: r.source, updatedAt: r.updated_at, runId: r.run_id ?? undefined };
}
