import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type DatasetInfo, type DatasetInsights, type ItemQuery, type TemplateInfo } from '../../api';
import { ago } from '../../lib/format';
import { subscribe } from '../../lib/live';
import { pluginById, usePlugins } from '../../lib/plugins';
import type { DatasetItem } from '../../types';
import { HBars } from '../dashboard/charts';
import { CATEGORICAL, DivergingColumns, LineChart, StackedColumns, type Bucket } from './charts';

const RANGES = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: '365d', label: '12 months' },
];
const RANGE_DAYS: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 };

export const datasetIdFor = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'default';

const PLATFORM: Record<string, string> = { youtube: 'YouTube', instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', x: 'X', interest: 'Search interest', rating: 'App Store rating' };

/** "youtube:@acme:subscribers" → group "youtube:subscribers", line "@acme". Lines in a group share a unit. */
function seriesGroup(name: string): { group: string; line: string } {
  const parts = name.split(':');
  if (parts[0] === 'interest') return { group: `interest${parts[2] ? `:${parts[2]}` : ''}`, line: parts[1] ?? name };
  if (parts[0] === 'rating') return { group: 'rating', line: [parts[1], parts[2]].filter(Boolean).join(' · ') };
  if (parts.length >= 3) return { group: `${parts[0]}:${parts[parts.length - 1]}`, line: parts.slice(1, -1).join(':') };
  if (parts.length === 2) return { group: parts[0], line: parts[1] };
  return { group: name, line: name };
}
const groupTitle = (g: string) => {
  const [a, b] = g.split(':');
  if (a === 'interest') return `Search interest${b ? ` (${b})` : ''}`;
  return `${PLATFORM[a] ?? a}${b ? ` ${b}` : ''}`;
};

/** Day buckets covering the whole range (weeks past 60 days), so gaps show as gaps. */
function buckets(range: string): Array<{ key: string; label: string; days: string[] }> {
  const n = RANGE_DAYS[range] ?? 30;
  const days: string[] = [];
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(d.getTime() - i * 86_400_000);
    days.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`);
  }
  const label = (day: string, o: Intl.DateTimeFormatOptions) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, o);
  if (n <= 60) return days.map((day) => ({ key: day, label: label(day, { day: 'numeric', month: 'short' }), days: [day] }));
  const out: Array<{ key: string; label: string; days: string[] }> = [];
  for (let i = 0; i < days.length; i += 7) {
    const chunk = days.slice(i, i + 7);
    out.push({ key: chunk[0], label: label(chunk[0], { day: 'numeric', month: 'short' }), days: chunk });
  }
  return out;
}

function Sentiment({ v }: { v?: number | null }) {
  if (v == null) return <span className="sent none">not labelled</span>;
  const cls = v >= 0.25 ? 'pos' : v <= -0.25 ? 'neg' : 'neu';
  return (
    <span className={`sent ${cls}`} title={`Sentiment ${v.toFixed(2)} (−1…1)`}>
      <span className="sent-dot" aria-hidden />
      {cls === 'pos' ? 'positive' : cls === 'neg' ? 'negative' : 'neutral'} {v.toFixed(2)}
    </span>
  );
}

const sourceName = (id: string) => pluginById(id)?.name ?? id;
const sourceIcon = (id: string) => pluginById(id)?.icon ?? '•';
const metricsText = (m?: Record<string, number | undefined>) =>
  m
    ? Object.entries(m)
        .filter(([, v]) => v != null)
        .map(([k, v]) => `${k} ${Number(v) >= 10_000 ? `${Math.round(Number(v) / 1000)}k` : v}`)
        .join(' · ')
    : '';

function ItemRow({ i }: { i: DatasetItem }) {
  return (
    <li className="feed-item">
      <div className="feed-title">
        <span className="feed-src" title={sourceName(i.source)}>
          {sourceIcon(i.source)}
        </span>
        {i.url ? (
          <a href={i.url} target="_blank" rel="noreferrer" dir="auto">
            {i.title || i.text?.slice(0, 120) || i.id}
          </a>
        ) : (
          <span dir="auto">{i.title || i.text?.slice(0, 120) || i.id}</span>
        )}
      </div>
      <div className="feed-meta">
        {[sourceName(i.source), i.label && i.label !== sourceName(i.source) ? i.label : '', i.author, ago(i.publishedAt ?? i.firstSeen), metricsText(i.metrics)].filter(Boolean).join(' · ')}
      </div>
      {i.title && i.text && (
        <div className="feed-text" dir="auto">
          {i.text.slice(0, 280)}
        </div>
      )}
      <div className="feed-tags">
        <Sentiment v={i.sentiment} />
        {i.topics?.map((t) => (
          <span key={t} className="chip-sm">
            {t}
          </span>
        ))}
        {typeof i.enrich?.summary === 'string' && <span className="feed-summary">{i.enrich.summary}</span>}
      </div>
    </li>
  );
}

interface Props {
  /** Dataset to show first (e.g. from a Dataset node's "Open in Insights"). */
  initial?: string;
  templates: TemplateInfo[];
  onTemplate: (key: string) => void;
  notify: (msg: string, kind?: 'ok' | 'err') => void;
}

/** Collected media per dataset: volume, sentiment, topics, people, metrics and the items themselves. */
export function Insights({ initial, templates, onTemplate, notify }: Props) {
  usePlugins();
  const [sets, setSets] = useState<DatasetInfo[] | null>(null);
  const [id, setId] = useState<string | null>(() => {
    try {
      return initial ?? localStorage.getItem('ac.insights.ds');
    } catch {
      return initial ?? null;
    }
  });
  const [range, setRange] = useState('30d');
  const [source, setSource] = useState('');
  const [data, setData] = useState<DatasetInsights | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState<ItemQuery>({ sort: 'recent' });
  const [feed, setFeed] = useState<{ total: number; items: DatasetItem[] }>({ total: 0, items: [] });
  const [tables, setTables] = useState(false);
  const [search, setSearch] = useState('');
  const reqRef = useRef(0);

  // Typing searches after a short pause, not on every key.
  useEffect(() => {
    const t = setTimeout(() => setQ((x) => (x.q === search ? x : { ...x, q: search })), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (initial) setId(initial);
  }, [initial]);

  const loadSets = useCallback(() => api.datasets().then(setSets).catch(() => setSets([])), []);
  useEffect(() => {
    void loadSets();
  }, [loadSets]);

  const current = sets?.find((s) => s.id === id) ?? sets?.[0] ?? null;
  const ds = current?.id;
  useEffect(() => {
    if (!ds) return;
    try {
      localStorage.setItem('ac.insights.ds', ds);
    } catch {
      /* storage unavailable */
    }
  }, [ds]);

  const load = useCallback(async () => {
    if (!ds) return;
    const n = ++reqRef.current;
    setLoading(true);
    try {
      const [d, f] = await Promise.all([api.datasetInsights(ds, range, source || undefined), api.datasetItems(ds, { ...q, range, source: source || undefined, limit: 20 })]);
      if (n !== reqRef.current) return;
      setData(d);
      setFeed(f);
    } catch (err) {
      notify((err as Error).message, 'err');
    } finally {
      if (n === reqRef.current) setLoading(false);
    }
  }, [ds, range, source, q, notify]);

  useEffect(() => {
    void load();
  }, [load]);

  // New items arrive while a workflow runs: refresh (debounced).
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const unsub = subscribe((e) => {
      if (e.type !== 'dataset') return;
      clearTimeout(t);
      t = setTimeout(() => {
        void loadSets();
        if (e.dataset === ds) void load();
      }, 800);
    });
    return () => (unsub(), clearTimeout(t));
  }, [ds, load, loadSets]);

  // Colour follows the source: fixed order from the dataset's full source list, not the current counts.
  const sourceOrder = useMemo(() => [...(current?.sources ?? [])].sort(), [current?.sources]);
  const colorOf = (s: string) => CATEGORICAL[Math.max(0, sourceOrder.indexOf(s)) % CATEGORICAL.length];

  const volume = useMemo(() => {
    if (!data) return [];
    const byDay = new Map<string, Record<string, number>>();
    for (const r of data.volume) byDay.set(r.day, { ...byDay.get(r.day), [r.source]: r.n });
    return buckets(range).map<Bucket>((b) => {
      const values: Record<string, number> = {};
      for (const day of b.days) for (const [s, n] of Object.entries(byDay.get(day) ?? {})) values[s] = (values[s] ?? 0) + n;
      return { key: b.key, label: b.label, values };
    });
  }, [data, range]);

  const sentiment = useMemo(() => {
    if (!data) return [];
    const byDay = new Map(data.sentiment.map((r) => [r.day, r]));
    return buckets(range).map((b) => {
      const rows = b.days.map((d) => byDay.get(d)).filter(Boolean) as DatasetInsights['sentiment'];
      const pos = rows.reduce((a, r) => a + r.pos, 0);
      const neg = rows.reduce((a, r) => a + r.neg, 0);
      const neutral = rows.reduce((a, r) => a + r.neutral, 0);
      const n = pos + neg + neutral;
      return { key: b.key, label: b.label, pos, neg, neutral, avg: n ? rows.reduce((a, r) => a + r.avg * (r.pos + r.neg + r.neutral), 0) / n : null };
    });
  }, [data, range]);

  const seriesGroups = useMemo(() => {
    const m = new Map<string, Array<{ name: string; points: Array<{ t: number; value: number }> }>>();
    for (const s of data?.series ?? []) {
      const { group, line } = seriesGroup(s.series);
      m.set(group, [...(m.get(group) ?? []), { name: line, points: s.points }]);
    }
    return [...m];
  }, [data]);

  if (sets && !sets.length) {
    const tpls = templates.filter((t) => t.pattern === 'insights');
    return (
      <div className="ins-empty">
        <h1>Insights</h1>
        <p className="muted">
          Collect posts, comments, news, reviews and trends with <b>Source</b> nodes (Reddit, Hacker News, Google News, Google Trends, YouTube, Instagram, Facebook, TikTok, X, RSS, any web page or
          API). Everything they collect lands in a dataset, and shows up here with volume, sentiment, topics and metrics over time.
        </p>
        <div className="ins-tpls">
          {tpls.map((t) => (
            <button key={t.key} className="ins-tpl" onClick={() => onTemplate(t.key)}>
              <b>{t.name}</b>
              <span>{t.description}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }
  if (!sets || !current) return <div className="dash-loading muted">Loading insights…</div>;

  const k = data?.kpis;
  const change = k && k.previous !== undefined && k.previous > 0 ? (k.items - k.previous) / k.previous : null;
  const sentSeries = sentiment.some((b) => b.pos || b.neg || b.neutral);
  const topPanels = (data?.panels ?? []).filter((p) => p.panel === 'top' && p.rows?.length);

  return (
    <div className="dash ins">
      <div className="filters" role="toolbar" aria-label="Insights filters">
        <select className="ins-ds" value={current.id} onChange={(e) => (setId(e.target.value), setSource(''))} aria-label="Dataset">
          {sets.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.items})
            </option>
          ))}
        </select>
        <div className="seg" role="radiogroup" aria-label="Time range">
          {RANGES.map((r) => (
            <button key={r.value} role="radio" aria-checked={range === r.value} className={range === r.value ? 'on' : ''} onClick={() => setRange(r.value)}>
              {r.label}
            </button>
          ))}
        </div>
        <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Source">
          <option value="">All sources</option>
          {sourceOrder.map((s) => (
            <option key={s} value={s}>
              {sourceName(s)}
            </option>
          ))}
        </select>
        <span className="spacer" />
        <button className="btn ghost sm" onClick={() => setTables(!tables)} aria-pressed={tables}>
          {tables ? 'Show charts' : 'Show tables'}
        </button>
        <a className="btn ghost sm" href={`/api/datasets/${encodeURIComponent(current.id)}/export.csv?range=${range}${source ? `&source=${source}` : ''}`} download>
          Export CSV
        </a>
        <button
          className="btn ghost danger sm"
          onClick={async () => {
            if (!confirm(`Delete the dataset “${current.name}” and all ${current.items} items? Workflows that write to it will start a new one.`)) return;
            await api.deleteDataset(current.id);
            notify(`Deleted “${current.name}”`, 'ok');
            setId(null);
            void loadSets();
          }}
        >
          Delete
        </button>
      </div>

      <section className={`tiles ${loading ? 'refetch' : ''}`} aria-label="Key numbers">
        <div className="tile">
          <span className="tile-label">Items · {RANGES.find((r) => r.value === range)?.label}</span>
          <span className="tile-value">{k?.items ?? '–'}</span>
          <span className="tile-sub">
            {change != null && <span className={change >= 0 ? 'delta-up' : 'delta-down'}>{`${change >= 0 ? '▲' : '▼'} ${Math.abs(Math.round(change * 100))}% vs previous period · `}</span>}
            {current.items} in total
          </span>
        </div>
        <div className="tile">
          <span className="tile-label">New today</span>
          <span className="tile-value">{k?.newToday ?? 0}</span>
          <span className="tile-sub">{current.lastItemAt ? `last item ${ago(current.lastItemAt)}` : 'nothing yet'}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Average sentiment</span>
          <span className="tile-value tile-value-sm">{k?.labelled ? <Sentiment v={k.avgSentiment} /> : '–'}</span>
          <span className="tile-sub">{k?.labelled ? `${k.negative} negative of ${k.labelled} labelled` : 'add an Insight step to label items'}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Engagement</span>
          <span className="tile-value">{k?.engagement ? Math.round(k.engagement).toLocaleString() : '–'}</span>
          <span className="tile-sub">likes + 2×comments + 3×shares + score + views/100</span>
        </div>
        <div className="tile">
          <span className="tile-label">Sources</span>
          <span className="tile-value">{data?.bySource.length ?? 0}</span>
          <span className="tile-sub">{data?.bySource.map((s) => `${sourceName(s.source)} ${s.n}`).join(' · ') || '—'}</span>
        </div>
      </section>

      <div className="ins-grid">
        <section className={`card ${loading ? 'refetch' : ''}`} aria-label="Volume">
          <header className="card-head">
            <h2>Items per {RANGE_DAYS[range] > 60 ? 'week' : 'day'}</h2>
            {sourceOrder.length > 1 && (
              <span className="legend">
                {sourceOrder
                  .filter((s) => !source || s === source)
                  .map((s) => (
                    <span key={s}>
                      <span className="swatch" style={{ background: colorOf(s) }} /> {sourceName(s)}
                    </span>
                  ))}
              </span>
            )}
          </header>
          {tables ? (
            <table className="mini-table">
              <thead>
                <tr>
                  <th>{RANGE_DAYS[range] > 60 ? 'Week of' : 'Day'}</th>
                  {sourceOrder.map((s) => (
                    <th key={s} className="num">
                      {sourceName(s)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {volume
                  .filter((b) => Object.keys(b.values).length)
                  .map((b) => (
                    <tr key={b.key}>
                      <td>{b.label}</td>
                      {sourceOrder.map((s) => (
                        <td key={s} className="num">
                          {b.values[s] ?? 0}
                        </td>
                      ))}
                    </tr>
                  ))}
              </tbody>
            </table>
          ) : (
            <StackedColumns buckets={volume} series={sourceOrder} color={colorOf} label="Items per day by source" />
          )}
        </section>

        <section className={`card ${loading ? 'refetch' : ''}`} aria-label="Sentiment">
          <header className="card-head">
            <h2>Sentiment</h2>
            {sentSeries && (
              <span className="legend">
                <span>
                  <span className="swatch" style={{ background: 'var(--sent-pos)' }} /> ▲ Positive
                </span>
                <span>
                  <span className="swatch" style={{ background: 'var(--sent-neg)' }} /> ▼ Negative
                </span>
              </span>
            )}
          </header>
          {!sentSeries ? (
            <p className="empty">No labelled items in this period. Add an <b>Insight</b> step after your sources to get sentiment and topics.</p>
          ) : tables ? (
            <table className="mini-table">
              <thead>
                <tr>
                  <th>Day</th>
                  <th className="num">Positive</th>
                  <th className="num">Negative</th>
                  <th className="num">Neutral</th>
                  <th className="num">Average</th>
                </tr>
              </thead>
              <tbody>
                {sentiment
                  .filter((b) => b.pos || b.neg || b.neutral)
                  .map((b) => (
                    <tr key={b.key}>
                      <td>{b.label}</td>
                      <td className="num">{b.pos}</td>
                      <td className="num">{b.neg}</td>
                      <td className="num">{b.neutral}</td>
                      <td className="num">{b.avg?.toFixed(2)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          ) : (
            <DivergingColumns buckets={sentiment} label="Positive and negative items per day" />
          )}
        </section>

        <section className={`card ${loading ? 'refetch' : ''}`} aria-label="Topics">
          <header className="card-head">
            <h2>Top topics</h2>
          </header>
          {data?.topics.length ? (
            <HBars rows={data.topics.map((t) => ({ id: t.topic, name: t.topic, value: t.n }))} format={(v) => String(v)} label="Items per topic" />
          ) : (
            <p className="empty">Topics appear once an Insight step labels items.</p>
          )}
        </section>

        <section className={`card ${loading ? 'refetch' : ''}`} aria-label="Most active authors">
          <header className="card-head">
            <h2>Most active</h2>
            <span className="muted small">authors, outlets and channels</span>
          </header>
          {data?.authors.length ? <HBars rows={data.authors.map((a) => ({ id: a.author, name: a.author, value: a.n }))} format={(v) => `${v}`} label="Items per author" /> : <p className="empty">No authors in this period.</p>}
        </section>

        {topPanels.map((p) => (
          <section key={`${p.plugin}-${p.title}`} className={`card ${loading ? 'refetch' : ''}`} aria-label={p.title}>
            <header className="card-head">
              <h2>
                {p.icon} {p.title}
              </h2>
              <span className="muted small">{p.pluginName}</span>
            </header>
            <HBars rows={p.rows!.map((r) => ({ id: String(r.name), name: String(r.name), value: r.n }))} format={(v) => String(v)} label={p.title} />
          </section>
        ))}

        {seriesGroups.map(([group, lines]) => (
          <section key={group} className={`card ${loading ? 'refetch' : ''}`} aria-label={groupTitle(group)}>
            <header className="card-head">
              <h2>{groupTitle(group)}</h2>
              {lines.length > 1 && (
                <span className="legend">
                  {lines.slice(0, 8).map((l, i) => (
                    <span key={l.name}>
                      <span className="swatch line" style={{ background: CATEGORICAL[i % 8] }} /> {l.name}
                    </span>
                  ))}
                </span>
              )}
            </header>
            {tables ? (
              <table className="mini-table">
                <thead>
                  <tr>
                    <th>Series</th>
                    <th className="num">Latest</th>
                    <th className="num">First</th>
                    <th className="num">Points</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.name}>
                      <td>{l.name}</td>
                      <td className="num">{l.points[l.points.length - 1]?.value}</td>
                      <td className="num">{l.points[0]?.value}</td>
                      <td className="num">{l.points.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <>
                <LineChart lines={lines.slice(0, 8)} color={(name) => CATEGORICAL[lines.findIndex((l) => l.name === name) % 8]} label={groupTitle(group)} unit={group === 'interest' || group.startsWith('interest:') ? '' : undefined} />
                {lines.every((l) => l.points.length < 2) && <p className="field-hint">One data point so far; the line fills in with each run.</p>}
              </>
            )}
          </section>
        ))}

        <section className={`card ins-wide ${loading ? 'refetch' : ''}`} aria-label="Top items">
          <header className="card-head">
            <h2>Most engaging</h2>
            <span className="muted small">by likes, comments, shares, score and views</span>
          </header>
          {data?.top.length && data.top.some((t) => t.engagement > 0) ? (
            <table className="mini-table ins-top">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Source</th>
                  <th className="num">Engagement</th>
                  <th>Sentiment</th>
                </tr>
              </thead>
              <tbody>
                {data.top
                  .filter((t) => t.engagement > 0)
                  .map((t) => (
                    <tr key={`${t.source}-${t.id}`}>
                      <td>
                        {t.url ? (
                          <a href={t.url} target="_blank" rel="noreferrer" dir="auto">
                            {t.title || t.text?.slice(0, 100) || t.id}
                          </a>
                        ) : (
                          t.title || t.text?.slice(0, 100)
                        )}
                        <div className="muted small">{[t.author, metricsText(t.metrics)].filter(Boolean).join(' · ')}</div>
                      </td>
                      <td>
                        {sourceIcon(t.source)} {sourceName(t.source)}
                      </td>
                      <td className="num">{Math.round(t.engagement).toLocaleString()}</td>
                      <td>
                        <Sentiment v={t.sentiment} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          ) : (
            <p className="empty">No engagement numbers in this period (RSS and news feeds don’t have them).</p>
          )}
        </section>

        <section className="card ins-wide" aria-label="Items">
          <header className="card-head">
            <h2>Items</h2>
            <span className="muted small">{feed.total.toLocaleString()} matching</span>
          </header>
          <div className="filters ins-feed-filters">
            <input className="filter-search" placeholder="Search titles and text…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search items" />
            <div className="seg" role="radiogroup" aria-label="Sentiment">
              {[
                { v: undefined, l: 'All' },
                { v: 'neg', l: 'Negative' },
                { v: 'neutral', l: 'Neutral' },
                { v: 'pos', l: 'Positive' },
              ].map((o) => (
                <button key={o.l} role="radio" aria-checked={q.sentiment === o.v} className={q.sentiment === o.v ? 'on' : ''} onClick={() => setQ({ ...q, sentiment: o.v as ItemQuery['sentiment'] })}>
                  {o.l}
                </button>
              ))}
            </div>
            <div className="seg" role="radiogroup" aria-label="Sort">
              {(['recent', 'engagement'] as const).map((s) => (
                <button key={s} role="radio" aria-checked={q.sort === s} className={q.sort === s ? 'on' : ''} onClick={() => setQ({ ...q, sort: s })}>
                  {s === 'recent' ? 'Newest' : 'Most engaging'}
                </button>
              ))}
            </div>
          </div>
          {!feed.items.length && <p className="empty">No items match.</p>}
          <ul className="feed">
            {feed.items.map((i) => (
              <ItemRow key={`${i.source}-${i.id}`} i={i} />
            ))}
          </ul>
          {feed.items.length < feed.total && (
            <button
              className="btn ghost sm"
              onClick={async () => {
                const more = await api.datasetItems(current.id, { ...q, range, source: source || undefined, limit: 20, offset: feed.items.length });
                setFeed((f) => ({ total: more.total, items: [...f.items, ...more.items] }));
              }}
            >
              Show more
            </button>
          )}
        </section>
      </div>
    </div>
  );
}
