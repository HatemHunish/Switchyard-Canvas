import { Injectable, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import Database from 'better-sqlite3';
import { join } from 'path';
import { DATA_DIR } from '../common/paths';
import { DatasetItem, Item, Point } from '../common/types';
import { EventBus } from '../engine/event-bus';
import { toFtsQuery } from '../memory/memory.service';

/** Datasets are shared by name across workflows (a "brand" dataset can be fed by several). */
export const datasetIdFor = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'default';

const DAY = 86_400_000;
export const RANGE_MS: Record<string, number> = { '24h': DAY, '7d': 7 * DAY, '14d': 14 * DAY, '30d': 30 * DAY, '90d': 90 * DAY, '365d': 365 * DAY };

/** One number for "how much attention did this get", comparable across platforms. */
const ENGAGEMENT = `(COALESCE(json_extract(metrics,'$.likes'),0) + 2*COALESCE(json_extract(metrics,'$.comments'),0) + 3*COALESCE(json_extract(metrics,'$.shares'),0) + COALESCE(json_extract(metrics,'$.score'),0) + COALESCE(json_extract(metrics,'$.views'),0)/100.0)`;
/** When an item happened: its publish date, else when we first saw it. */
const WHEN = `COALESCE(published_at, first_seen)`;

export interface InsightFilter {
  range?: string;
  source?: string;
  feed?: string;
}

@Injectable()
export class DatasetsService implements OnModuleDestroy {
  private db = new Database(join(DATA_DIR, 'datasets.db'));

  constructor(private readonly bus: EventBus) {
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS datasets (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS items (
        dataset TEXT NOT NULL, source TEXT NOT NULL, id TEXT NOT NULL,
        feed TEXT NOT NULL, label TEXT, kind TEXT NOT NULL,
        title TEXT, text TEXT, url TEXT, author TEXT, published_at INTEGER,
        first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
        metrics TEXT, tags TEXT, media TEXT, extra TEXT,
        sentiment REAL, topics TEXT, enrich TEXT, enriched_at INTEGER, run_id TEXT,
        UNIQUE (dataset, source, id)
      );
      CREATE INDEX IF NOT EXISTS items_seen ON items (dataset, first_seen);
      CREATE INDEX IF NOT EXISTS items_pending ON items (dataset, enriched_at);
      CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(title, text, author, tokenize = 'porter unicode61');
      CREATE TABLE IF NOT EXISTS points (dataset TEXT NOT NULL, source TEXT NOT NULL, series TEXT NOT NULL, t INTEGER NOT NULL, value REAL NOT NULL, PRIMARY KEY (dataset, source, series, t));
      CREATE TABLE IF NOT EXISTS source_state (key TEXT PRIMARY KEY, json TEXT NOT NULL);
    `);
  }

  onModuleDestroy() {
    this.db.close();
  }

  ensure(name: string): string {
    const id = datasetIdFor(name);
    this.db.prepare(`INSERT OR IGNORE INTO datasets (id, name, created_at) VALUES (?, ?, ?)`).run(id, name.trim() || id, Date.now());
    return id;
  }

  list() {
    return this.db
      .prepare(
        `SELECT d.id, d.name, d.created_at AS createdAt,
          (SELECT COUNT(*) FROM items i WHERE i.dataset = d.id) AS items,
          (SELECT MAX(first_seen) FROM items i WHERE i.dataset = d.id) AS lastItemAt,
          (SELECT COUNT(DISTINCT series) FROM points p WHERE p.dataset = d.id) AS series,
          (SELECT json_group_array(DISTINCT source) FROM items i WHERE i.dataset = d.id) AS sources
         FROM datasets d ORDER BY COALESCE(lastItemAt, d.created_at) DESC`,
      )
      .all()
      .map((r: any) => ({ ...r, sources: JSON.parse(r.sources || '[]') }));
  }

  exists(id: string) {
    return !!this.db.prepare(`SELECT 1 FROM datasets WHERE id = ?`).get(id);
  }

  private must(id: string) {
    if (!this.exists(id)) throw new NotFoundException(`No dataset "${id}".`);
  }

  delete(id: string) {
    this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT rowid FROM items WHERE dataset = ?`).all(id) as Array<{ rowid: number }>;
      const del = this.db.prepare(`DELETE FROM items_fts WHERE rowid = ?`);
      for (const r of rows) del.run(r.rowid);
      this.db.prepare(`DELETE FROM items WHERE dataset = ?`).run(id);
      this.db.prepare(`DELETE FROM points WHERE dataset = ?`).run(id);
      this.db.prepare(`DELETE FROM datasets WHERE id = ?`).run(id);
    })();
  }

  getState(key: string): Record<string, any> {
    const r = this.db.prepare(`SELECT json FROM source_state WHERE key = ?`).get(key) as { json: string } | undefined;
    try {
      return r ? JSON.parse(r.json) : {};
    } catch {
      return {};
    }
  }

  setState(key: string, state: Record<string, any>) {
    const json = JSON.stringify(state ?? {});
    if (json.length > 200_000) return; // state is for cursors, not data
    this.db.prepare(`INSERT INTO source_state (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json`).run(key, json);
  }

  /** Adds new items and refreshes known ones (metrics change over time). Returns the ones not seen before. */
  upsert(datasetName: string, source: string, feed: string, label: string | undefined, items: Item[], points: Point[] = [], runId?: string) {
    const ds = this.ensure(datasetName);
    const now = Date.now();
    const find = this.db.prepare(`SELECT rowid FROM items WHERE dataset = ? AND source = ? AND id = ?`);
    const insert = this.db.prepare(
      `INSERT INTO items (dataset, source, id, feed, label, kind, title, text, url, author, published_at, first_seen, last_seen, metrics, tags, media, extra, run_id)
       VALUES (@dataset, @source, @id, @feed, @label, @kind, @title, @text, @url, @author, @published_at, @now, @now, @metrics, @tags, @media, @extra, @run_id)`,
    );
    const update = this.db.prepare(
      `UPDATE items SET last_seen = @now, metrics = COALESCE(@metrics, metrics), title = COALESCE(@title, title), text = COALESCE(@text, text) WHERE rowid = @rowid`,
    );
    const fts = this.db.prepare(`INSERT INTO items_fts (rowid, title, text, author) VALUES (?, ?, ?, ?)`);
    const point = this.db.prepare(`INSERT INTO points (dataset, source, series, t, value) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET value = excluded.value`);
    const fresh: Item[] = [];
    this.db.transaction(() => {
      for (const i of items) {
        const row = {
          dataset: ds,
          source,
          id: i.id,
          feed,
          label: label ?? null,
          kind: i.kind,
          title: i.title ?? null,
          text: i.text ?? null,
          url: i.url ?? null,
          author: i.author ?? null,
          published_at: i.publishedAt ?? null,
          now,
          metrics: i.metrics ? JSON.stringify(i.metrics) : null,
          tags: i.tags?.length ? JSON.stringify(i.tags) : null,
          media: i.media?.length ? JSON.stringify(i.media) : null,
          extra: i.extra ? JSON.stringify(i.extra) : null,
          run_id: runId ?? null,
        };
        const existing = find.get(ds, source, i.id) as { rowid: number } | undefined;
        if (existing) {
          update.run({ ...row, rowid: existing.rowid });
        } else {
          const info = insert.run(row);
          fts.run(info.lastInsertRowid, i.title ?? '', i.text ?? '', i.author ?? '');
          fresh.push(i);
        }
      }
      for (const p of points) point.run(ds, source, p.series, Math.round(p.t), p.value);
    })();
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM items WHERE dataset = ?`).get(ds) as { n: number }).n;
    if (fresh.length || points.length) this.bus.emit({ type: 'dataset', dataset: ds, added: fresh.length });
    return { dataset: ds, fresh, total };
  }

  /** Items the Insight node hasn't labelled yet, oldest first. */
  unenriched(ds: string, limit: number) {
    return this.db
      .prepare(`SELECT rowid, * FROM items WHERE dataset = ? AND enriched_at IS NULL ORDER BY first_seen ASC LIMIT ?`)
      .all(ds, limit)
      .map((r: any) => ({ rowid: r.rowid as number, item: toItem(r) }));
  }

  enrich(rowid: number, e: { sentiment?: number; topics?: string[]; enrich?: Record<string, unknown> }) {
    this.db
      .prepare(`UPDATE items SET sentiment = ?, topics = ?, enrich = ?, enriched_at = ? WHERE rowid = ?`)
      .run(Number.isFinite(e.sentiment) ? Math.max(-1, Math.min(1, e.sentiment!)) : null, e.topics?.length ? JSON.stringify(e.topics.slice(0, 8)) : null, e.enrich ? JSON.stringify(e.enrich) : null, Date.now(), rowid);
  }

  // ---- queries (agent tools + Insights tab) ----

  private where(ds: string, f: InsightFilter, alias = '') {
    const a = alias ? `${alias}.` : '';
    const clauses = [`${a}dataset = @ds`];
    const params: Record<string, unknown> = { ds };
    if (f.range && RANGE_MS[f.range]) {
      clauses.push(`COALESCE(${a}published_at, ${a}first_seen) >= @since`);
      params.since = Date.now() - RANGE_MS[f.range];
    }
    if (f.source) (clauses.push(`${a}source = @source`), (params.source = f.source));
    if (f.feed) (clauses.push(`${a}feed = @feed`), (params.feed = f.feed));
    return { sql: clauses.join(' AND '), params };
  }

  search(ds: string, opts: { q?: string; limit?: number; offset?: number; sentiment?: 'neg' | 'pos' | 'neutral'; sort?: 'recent' | 'engagement' } & InsightFilter = {}) {
    this.must(ds);
    const w = this.where(ds, opts, 'i');
    let from = `items i`;
    const fts = opts.q?.trim() ? toFtsQuery(opts.q) : null;
    if (fts) {
      from = `items_fts f JOIN items i ON i.rowid = f.rowid`;
      w.sql += ` AND items_fts MATCH @fts`;
      w.params.fts = fts;
    }
    if (opts.sentiment === 'neg') w.sql += ` AND i.sentiment <= -0.25`;
    if (opts.sentiment === 'pos') w.sql += ` AND i.sentiment >= 0.25`;
    if (opts.sentiment === 'neutral') w.sql += ` AND i.sentiment > -0.25 AND i.sentiment < 0.25`;
    const order = opts.sort === 'engagement' ? `${ENGAGEMENT.replace(/metrics/g, 'i.metrics')} DESC` : fts ? `bm25(items_fts)` : `COALESCE(i.published_at, i.first_seen) DESC`;
    const limit = Math.min(Math.max(1, Number(opts.limit) || 25), 200);
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM ${from} WHERE ${w.sql}`).get(w.params) as { n: number }).n;
    const rows = this.db.prepare(`SELECT i.* FROM ${from} WHERE ${w.sql} ORDER BY ${order} LIMIT ${limit} OFFSET ${Math.max(0, Number(opts.offset) || 0)}`).all(w.params);
    return { total, items: rows.map(toItem) };
  }

  /** Everything the Insights tab draws, in one call. */
  insights(ds: string, f: InsightFilter) {
    this.must(ds);
    const w = this.where(ds, f);
    const q = <T = any>(sql: string, extra: Record<string, unknown> = {}) => this.db.prepare(sql).all({ ...w.params, ...extra }) as T[];
    const one = <T = any>(sql: string, extra: Record<string, unknown> = {}) => this.db.prepare(sql).get({ ...w.params, ...extra }) as T;
    const startOfToday = new Date(new Date().setHours(0, 0, 0, 0)).getTime();

    const kpis = one(
      `SELECT COUNT(*) AS items,
        SUM(CASE WHEN first_seen >= @today THEN 1 ELSE 0 END) AS newToday,
        AVG(sentiment) AS avgSentiment,
        SUM(CASE WHEN sentiment <= -0.25 THEN 1 ELSE 0 END) AS negative,
        SUM(CASE WHEN sentiment IS NOT NULL THEN 1 ELSE 0 END) AS labelled,
        SUM(${ENGAGEMENT}) AS engagement
       FROM items WHERE ${w.sql}`,
      { today: startOfToday },
    );
    const previous = f.range && RANGE_MS[f.range]
      ? one<{ items: number }>(`SELECT COUNT(*) AS items FROM items WHERE dataset = @ds ${f.source ? 'AND source = @source' : ''} AND ${WHEN} >= @p0 AND ${WHEN} < @since`, { p0: Date.now() - 2 * RANGE_MS[f.range] }).items
      : undefined;
    const bySource = q<{ source: string; n: number }>(`SELECT source, COUNT(*) AS n FROM items WHERE ${w.sql} GROUP BY source ORDER BY n DESC`);
    const volume = q<{ day: string; source: string; n: number }>(
      `SELECT strftime('%Y-%m-%d', ${WHEN} / 1000, 'unixepoch', 'localtime') AS day, source, COUNT(*) AS n FROM items WHERE ${w.sql} GROUP BY day, source ORDER BY day`,
    );
    const sentiment = q<{ day: string; pos: number; neg: number; neutral: number; avg: number }>(
      `SELECT strftime('%Y-%m-%d', ${WHEN} / 1000, 'unixepoch', 'localtime') AS day,
        SUM(CASE WHEN sentiment >= 0.25 THEN 1 ELSE 0 END) AS pos,
        SUM(CASE WHEN sentiment <= -0.25 THEN 1 ELSE 0 END) AS neg,
        SUM(CASE WHEN sentiment > -0.25 AND sentiment < 0.25 THEN 1 ELSE 0 END) AS neutral,
        AVG(sentiment) AS avg
       FROM items WHERE ${w.sql} AND sentiment IS NOT NULL GROUP BY day ORDER BY day`,
    );
    const topics = q<{ topic: string; n: number; avg: number }>(
      `SELECT lower(j.value) AS topic, COUNT(*) AS n, AVG(items.sentiment) AS avg FROM items, json_each(items.topics) j WHERE ${w.sql} AND items.topics IS NOT NULL GROUP BY lower(j.value) ORDER BY n DESC LIMIT 12`,
    );
    const authors = q<{ author: string; n: number; engagement: number }>(
      `SELECT author, COUNT(*) AS n, SUM(${ENGAGEMENT}) AS engagement FROM items WHERE ${w.sql} AND author IS NOT NULL AND author != '' GROUP BY author ORDER BY n DESC, engagement DESC LIMIT 10`,
    );
    const top = q(`SELECT *, ${ENGAGEMENT} AS engagement FROM items WHERE ${w.sql} ORDER BY engagement DESC LIMIT 10`).map((r: any) => ({ ...toItem(r), engagement: r.engagement }));
    const feeds = q<{ source: string; feed: string; label: string; n: number }>(`SELECT source, feed, MAX(label) AS label, COUNT(*) AS n FROM items WHERE dataset = @ds GROUP BY source, feed ORDER BY n DESC`);

    const pw = f.range && RANGE_MS[f.range] ? `AND t >= @since` : '';
    const series = q<{ source: string; series: string; t: number; value: number }>(
      `SELECT source, series, t, value FROM points WHERE dataset = @ds ${f.source ? 'AND source = @source' : ''} ${pw} ORDER BY series, t`,
    );
    const seriesMap = new Map<string, { source: string; series: string; points: Array<{ t: number; value: number }> }>();
    for (const p of series) {
      const k = `${p.source}\u0000${p.series}`;
      if (!seriesMap.has(k)) seriesMap.set(k, { source: p.source, series: p.series, points: [] });
      seriesMap.get(k)!.points.push({ t: p.t, value: p.value });
    }
    return { kpis: { ...kpis, previous }, bySource, volume, sentiment, topics, authors, top, feeds, series: [...seriesMap.values()] };
  }

  /** A "top N by field" panel declared by a plugin. */
  topBy(ds: string, path: string, f: InsightFilter) {
    this.must(ds);
    const m = /^(author|source|feed|kind|extra\.[\w.]+|enrich\.[\w.]+)$/.exec(path);
    if (!m) return [];
    const expr = path.startsWith('extra.') ? `json_extract(extra, '$.${path.slice(6)}')` : path.startsWith('enrich.') ? `json_extract(enrich, '$.${path.slice(7)}')` : path;
    const w = this.where(ds, f);
    return this.db.prepare(`SELECT ${expr} AS name, COUNT(*) AS n FROM items WHERE ${w.sql} AND ${expr} IS NOT NULL AND ${expr} != '' GROUP BY name ORDER BY n DESC LIMIT 10`).all(w.params);
  }

  /** Compact stats for agents (dataset_stats tool). */
  statsText(ds: string, range = '7d') {
    const r = this.insights(ds, { range });
    const k = r.kpis;
    const lines = [
      `Dataset "${ds}", last ${range}: ${k.items} items (${k.newToday ?? 0} new today${k.previous !== undefined ? `, ${k.previous} in the period before` : ''}).`,
      `By source: ${r.bySource.map((s) => `${s.source} ${s.n}`).join(', ') || '—'}.`,
      k.labelled ? `Sentiment: average ${Number(k.avgSentiment).toFixed(2)} (−1..1), ${k.negative} negative of ${k.labelled} labelled.` : 'Sentiment: not labelled yet.',
      r.topics.length ? `Top topics: ${r.topics.map((t) => `${t.topic} (${t.n})`).join(', ')}.` : '',
      r.authors.length ? `Most active authors: ${r.authors.slice(0, 5).map((a) => `${a.author} (${a.n})`).join(', ')}.` : '',
      r.series.length ? `Series: ${r.series.map((s) => `${s.series} latest ${s.points[s.points.length - 1]?.value}`).join('; ')}.` : '',
      r.top.length ? `Most engaging:\n${r.top.slice(0, 5).map((i) => `- ${i.title || clipText(i.text, 90)} (${i.source}${i.url ? `, ${i.url}` : ''})`).join('\n')}` : '',
    ];
    return lines.filter(Boolean).join('\n');
  }

  csv(ds: string, f: InsightFilter) {
    this.must(ds);
    const w = this.where(ds, f);
    const rows = this.db.prepare(`SELECT * FROM items WHERE ${w.sql} ORDER BY ${WHEN} DESC LIMIT 50000`).all(w.params).map(toItem);
    const cols = ['source', 'feed', 'kind', 'publishedAt', 'firstSeen', 'author', 'title', 'text', 'url', 'likes', 'comments', 'shares', 'views', 'score', 'sentiment', 'topics'];
    const cell = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const iso = (t?: number) => (t ? new Date(t).toISOString() : '');
    return [
      cols.join(','),
      ...rows.map((i) =>
        [i.source, i.feed, i.kind, iso(i.publishedAt), iso(i.firstSeen), i.author, i.title, i.text, i.url, i.metrics?.likes, i.metrics?.comments, i.metrics?.shares, i.metrics?.views, i.metrics?.score, i.sentiment, i.topics?.join('; ')]
          .map(cell)
          .join(','),
      ),
    ].join('\n');
  }
}

const clipText = (s: string | undefined, n: number) => (!s ? '' : s.length > n ? `${s.slice(0, n)}…` : s);

const parse = (s: string | null) => {
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

function toItem(r: any): DatasetItem {
  return {
    id: r.id,
    source: r.source,
    feed: r.feed,
    label: r.label ?? undefined,
    kind: r.kind,
    title: r.title ?? undefined,
    text: r.text ?? undefined,
    url: r.url ?? undefined,
    author: r.author ?? undefined,
    publishedAt: r.published_at ?? undefined,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    metrics: parse(r.metrics),
    tags: parse(r.tags),
    media: parse(r.media),
    extra: parse(r.extra),
    sentiment: r.sentiment ?? undefined,
    topics: parse(r.topics),
    enrich: parse(r.enrich),
  };
}
