import { Item, Point } from '../../common/types';
import { arr, asList, BuiltinPlugin, num, PluginContext, toMs, xt } from '../api';

const TIMEFRAMES = [
  { value: 'now 7-d', label: 'Past 7 days', serp: 'now 7-d' },
  { value: 'today 1-m', label: 'Past 30 days', serp: 'today 1-m' },
  { value: 'today 3-m', label: 'Past 90 days', serp: 'today 3-m' },
  { value: 'today 12-m', label: 'Past 12 months', serp: 'today 12-m' },
];

async function daily(ctx: PluginContext, geo: string): Promise<Item[]> {
  const doc = ctx.xml(await ctx.text(`https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`));
  return arr(doc?.rss?.channel?.item).map((it: any) => {
    const news = arr(it['ht:news_item']);
    const published = toMs(xt(it.pubDate));
    const title = xt(it.title);
    return {
      id: `${geo}:${title.toLowerCase()}:${published ? new Date(published).toISOString().slice(0, 10) : ''}`,
      kind: 'trend' as const,
      title,
      text: news.map((n: any) => `${xt(n['ht:news_item_title'])} (${xt(n['ht:news_item_source'])})`).join('\n') || undefined,
      url: xt(news[0]?.['ht:news_item_url']) || `https://trends.google.com/trends/explore?geo=${geo}&q=${encodeURIComponent(title)}`,
      author: xt(news[0]?.['ht:news_item_source']) || undefined,
      publishedAt: published,
      metrics: { views: num(xt(it['ht:approx_traffic'])) },
      media: xt(it['ht:picture']) ? [{ type: 'image' as const, url: xt(it['ht:picture']) }] : undefined,
      extra: { geo, traffic: xt(it['ht:approx_traffic']) },
    };
  });
}

/** SerpApi's Google Trends engine (reliable, needs a key). */
async function serpInterest(ctx: PluginContext, key: string, keywords: string[], geo: string, time: string): Promise<Point[]> {
  const params = new URLSearchParams({ engine: 'google_trends', q: keywords.join(','), data_type: 'TIMESERIES', date: time, api_key: key });
  if (geo) params.set('geo', geo);
  const r = await ctx.json(`https://serpapi.com/search.json?${params}`, { timeoutMs: 60_000 });
  if (r.error) throw new Error(`SerpApi: ${r.error}`);
  const points: Point[] = [];
  for (const row of r.interest_over_time?.timeline_data ?? []) {
    const t = Number(row.timestamp) * 1000;
    for (const v of row.values ?? []) points.push({ series: `interest:${v.query}${geo ? `:${geo}` : ''}`, t, value: Number(v.extracted_value) || 0 });
  }
  return points;
}

/** The public Trends web endpoints (no key). Unofficial: Google often rate-limits them. */
async function webInterest(ctx: PluginContext, keywords: string[], geo: string, time: string): Promise<Point[]> {
  const home = await ctx.fetch(`https://trends.google.com/trends/?geo=${encodeURIComponent(geo)}`, { headers: { accept: 'text/html' }, redirect: 'manual' });
  const cookie = (home.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const headers = { cookie, 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36' };
  const strip = (s: string) => JSON.parse(s.slice(s.indexOf('{')));
  const req = { comparisonItem: keywords.map((keyword) => ({ keyword, geo, time })), category: 0, property: '' };
  const explore = strip(await ctx.text(`https://trends.google.com/trends/api/explore?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(req))}`, { headers }));
  const widget = (explore.widgets ?? []).find((w: any) => w.id === 'TIMESERIES');
  if (!widget) throw new Error('Google Trends returned no time series.');
  const data = strip(await ctx.text(`https://trends.google.com/trends/api/widgetdata/multiline?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(widget.request))}&token=${widget.token}`, { headers }));
  const points: Point[] = [];
  for (const row of data.default?.timelineData ?? []) {
    keywords.forEach((k, i) => points.push({ series: `interest:${k}${geo ? `:${geo}` : ''}`, t: Number(row.time) * 1000, value: Number(row.value?.[i]) || 0 }));
  }
  return points;
}

async function interest(ctx: PluginContext, keywords: string[], geo: string, time: string) {
  if (!keywords.length) throw new Error('Add at least one keyword.');
  if (keywords.length > 5) throw new Error('Google Trends compares at most 5 keywords.');
  const key = await ctx.secret('serpapi');
  if (key) return serpInterest(ctx, key, keywords, geo, time);
  try {
    return await webInterest(ctx, keywords, geo, time);
  } catch (err: any) {
    throw new Error(`${err.message}. The free Trends endpoint is unofficial and often rate-limited; add a SerpApi key under Plugins → Google Trends for reliable results.`);
  }
}

/** One line per keyword: latest value and change against the period's average. */
function summarize(points: Point[]) {
  const by = new Map<string, Point[]>();
  for (const p of points) by.set(p.series, [...(by.get(p.series) ?? []), p]);
  return [...by].map(([series, ps]) => {
    const last = ps[ps.length - 1]?.value ?? 0;
    const avg = ps.reduce((a, p) => a + p.value, 0) / Math.max(1, ps.length);
    const peak = ps.reduce((a, p) => (p.value > a.value ? p : a), ps[0]);
    return `${series.replace(/^interest:/, '')}: latest ${last}/100, average ${avg.toFixed(0)}, peak ${peak?.value} on ${peak ? new Date(peak.t).toISOString().slice(0, 10) : '—'} (${avg ? `${last >= avg ? '+' : ''}${(((last - avg) / avg) * 100).toFixed(0)}% vs average` : 'no data'})`;
  });
}

export const gtrendsPlugin: BuiltinPlugin = {
  manifest: {
    id: 'gtrends',
    name: 'Google Trends',
    version: '1.0.0',
    icon: '📈',
    description: 'What people search for: daily trending searches per country, and search interest over time for your keywords.',
    notice: 'Daily trends use Google’s official RSS feed. Interest over time uses Google’s unofficial web endpoints, which are often rate-limited; a SerpApi key (free tier available) makes it reliable and enables related queries.',
    homepage: 'https://serpapi.com/google-trends-api',
    credentials: [{ key: 'serpapi', label: 'SerpApi key', optional: true, help: 'https://serpapi.com/manage-api-key' }],
    sources: [
      {
        id: 'daily',
        title: 'Trending searches',
        hint: 'Today’s top searches in a country',
        kind: 'trend',
        fields: [{ key: 'geo', label: 'Country code', type: 'text', default: 'US', placeholder: 'US, SA, AE, EG, GB…' }],
      },
      {
        id: 'interest',
        title: 'Interest over time',
        hint: 'Search interest (0–100) for up to 5 keywords',
        kind: 'trend',
        fields: [
          { key: 'keywords', label: 'Keywords', type: 'list', required: true, placeholder: 'acme\ncompetitor', help: 'Up to 5; they are compared on one scale.' },
          { key: 'geo', label: 'Country code', type: 'text', placeholder: 'Empty = worldwide' },
          { key: 'time', label: 'Period', type: 'select', default: 'today 3-m', options: TIMEFRAMES.map(({ value, label }) => ({ value, label })) },
        ],
      },
      {
        id: 'related',
        title: 'Rising related searches',
        hint: 'Queries growing around a keyword (SerpApi key)',
        kind: 'trend',
        needs: ['serpapi'],
        fields: [
          { key: 'keyword', label: 'Keyword', type: 'text', required: true },
          { key: 'geo', label: 'Country code', type: 'text', placeholder: 'Empty = worldwide' },
          { key: 'time', label: 'Period', type: 'select', default: 'today 1-m', options: TIMEFRAMES.map(({ value, label }) => ({ value, label })) },
        ],
      },
    ],
    tools: [
      {
        name: 'trends_daily',
        description: 'Today’s trending Google searches in a country, with related headlines.',
        inputSchema: { type: 'object', properties: { geo: { type: 'string', description: 'Country code, e.g. US, SA, GB' } }, required: ['geo'] },
      },
      {
        name: 'trends_interest',
        description: 'Google search interest (0–100) over time for up to 5 keywords, compared on one scale. Returns latest, average, peak and change per keyword.',
        inputSchema: {
          type: 'object',
          properties: { keywords: { type: 'array', items: { type: 'string' } }, geo: { type: 'string' }, time: { type: 'string', enum: TIMEFRAMES.map((t) => t.value) } },
          required: ['keywords'],
        },
      },
    ],
    insights: [{ title: 'Search interest', panel: 'timeseries', series: 'interest:' }],
  },
  module: {
    sources: {
      daily: async (c, ctx) => ({ items: await daily(ctx, String(c.geo || 'US').toUpperCase()) }),
      async interest(c, ctx) {
        const geo = String(c.geo || '').toUpperCase();
        const points = await interest(ctx, asList(c.keywords), geo, String(c.time || 'today 3-m'));
        const lines = summarize(points);
        const today = new Date().toISOString().slice(0, 10);
        // One summary item per day, so the digest (and agents) see the numbers.
        return { points, items: lines.length ? [{ id: `interest:${asList(c.keywords).join(',')}:${geo}:${today}`, kind: 'trend', title: `Search interest ${today}`, text: lines.join('\n'), publishedAt: Date.now() }] : [] };
      },
      async related(c, ctx) {
        const key = (await ctx.secret('serpapi'))!;
        const params = new URLSearchParams({ engine: 'google_trends', q: String(c.keyword), data_type: 'RELATED_QUERIES', date: String(c.time || 'today 1-m'), api_key: key });
        if (c.geo) params.set('geo', String(c.geo).toUpperCase());
        const r = await ctx.json(`https://serpapi.com/search.json?${params}`, { timeoutMs: 60_000 });
        if (r.error) throw new Error(`SerpApi: ${r.error}`);
        const rising = r.related_queries?.rising ?? [];
        const top = r.related_queries?.top ?? [];
        const items: Item[] = [...rising.map((q: any) => ({ q, kind: 'rising' })), ...top.map((q: any) => ({ q, kind: 'top' }))].map(({ q, kind }) => ({
          id: `${c.keyword}:${kind}:${q.query}`,
          kind: 'trend',
          title: q.query,
          text: `${kind === 'rising' ? 'Rising' : 'Top'} search related to "${c.keyword}": ${q.value ?? q.extracted_value}`,
          url: q.link,
          publishedAt: Date.now(),
          metrics: { score: Number(q.extracted_value) || undefined },
          extra: { related: kind, keyword: c.keyword },
        }));
        return { items };
      },
    },
    tools: {
      async trends_daily(a, ctx) {
        const items = await daily(ctx, String(a.geo || 'US').toUpperCase());
        return items.map((i) => `- ${i.title} (${i.extra?.traffic ?? '?'} searches)${i.text ? `\n  ${i.text.split('\n')[0]}` : ''}`).join('\n') || 'Nothing trending.';
      },
      async trends_interest(a, ctx) {
        const points = await interest(ctx, asList(a.keywords), String(a.geo || '').toUpperCase(), String(a.time || 'today 3-m'));
        return summarize(points).join('\n');
      },
    },
    async test(ctx) {
      const key = await ctx.secret('serpapi');
      if (!key) {
        const items = await daily(ctx, 'US');
        return `Trending feed works (${items.length} searches). No SerpApi key saved: interest over time will use the unofficial endpoint.`;
      }
      const r = await ctx.json(`https://serpapi.com/account.json?api_key=${encodeURIComponent(key)}`);
      return `SerpApi key works: ${r.plan_searches_left ?? r.total_searches_left ?? '?'} searches left this month.`;
    },
  },
};
