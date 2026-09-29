import { Item } from '../../common/types';
import { arr, asList, BuiltinPlugin, PluginContext, stripHtml, toMs, xt } from '../api';

/** RSS 2.0 and Atom feeds into items. */
export function parseFeed(ctx: PluginContext, body: string, fallbackAuthor?: string): Item[] {
  const doc = ctx.xml(body);
  const rssItems = arr(doc?.rss?.channel?.item ?? doc?.['rdf:RDF']?.item);
  if (rssItems.length) {
    return rssItems.map((it: any) => {
      const link = xt(it.link);
      const source = it.source ? xt(it.source) : '';
      return {
        id: xt(it.guid) || link || xt(it.title),
        kind: 'article' as const,
        title: stripHtml(xt(it.title)),
        text: stripHtml(xt(it['content:encoded']) || xt(it.description)).slice(0, 4000) || undefined,
        url: link || undefined,
        author: source || xt(it['dc:creator']) || xt(it.author) || fallbackAuthor,
        publishedAt: toMs(xt(it.pubDate) || xt(it['dc:date'])),
        tags: arr(it.category).map(xt).filter(Boolean),
        extra: source ? { outlet: source } : undefined,
      };
    });
  }
  return arr(doc?.feed?.entry).map((e: any) => {
    const links = arr(e.link);
    const href = links.find((l: any) => !l['@rel'] || l['@rel'] === 'alternate')?.['@href'] ?? links[0]?.['@href'] ?? '';
    return {
      id: xt(e.id) || href,
      kind: 'article' as const,
      title: stripHtml(xt(e.title)),
      text: stripHtml(xt(e.content) || xt(e.summary)).slice(0, 4000) || undefined,
      url: href || undefined,
      author: xt(arr(e.author)[0]?.name) || fallbackAuthor,
      publishedAt: toMs(xt(e.published) || xt(e.updated)),
      tags: arr(e.category).map((c: any) => c?.['@term'] ?? xt(c)).filter(Boolean),
    };
  });
}

const matches = (i: Item, words: string[]) => !words.length || words.some((w) => `${i.title} ${i.text}`.toLowerCase().includes(w.toLowerCase()));

const newsUrl = (q: string, hl: string, gl: string) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(gl)}&ceid=${encodeURIComponent(`${gl}:${hl.split('-')[0]}`)}`;

export const rssPlugin: BuiltinPlugin = {
  manifest: {
    id: 'rss',
    name: 'RSS & News',
    version: '1.0.0',
    icon: '📰',
    description: 'Any RSS/Atom feed, Google News searches, and App Store reviews. No key needed.',
    sources: [
      {
        id: 'feeds',
        title: 'RSS / Atom feeds',
        hint: 'Blogs, news sites, podcasts, changelogs',
        kind: 'article',
        fields: [
          { key: 'urls', label: 'Feed URLs', type: 'list', required: true, placeholder: 'https://example.com/feed.xml', help: 'One per line.' },
          { key: 'keywords', label: 'Only items mentioning', type: 'list', placeholder: 'acme, "acme corp"', help: 'Optional. Keeps items whose title or text contains any of these.' },
        ],
      },
      {
        id: 'google-news',
        title: 'Google News search',
        hint: 'News articles matching a search',
        kind: 'article',
        fields: [
          { key: 'query', label: 'Search', type: 'text', required: true, placeholder: '"Acme Corp" OR acme.com', help: 'Google News search syntax: quotes, OR, -exclude, when:7d.' },
          { key: 'language', label: 'Language', type: 'text', default: 'en-US', placeholder: 'en-US, ar, fr…' },
          { key: 'country', label: 'Country', type: 'text', default: 'US', placeholder: 'US, SA, AE, GB…' },
        ],
      },
      {
        id: 'app-reviews',
        title: 'App Store reviews',
        hint: 'Latest customer reviews of an iOS app',
        kind: 'review',
        fields: [
          { key: 'appId', label: 'App ID', type: 'text', required: true, placeholder: '284882215', help: 'The number after "id" in the App Store link.' },
          { key: 'country', label: 'Store country', type: 'text', default: 'us', placeholder: 'us, sa, ae, gb…' },
        ],
      },
    ],
    tools: [
      {
        name: 'news_search',
        description: 'Search Google News for recent articles. Returns headlines with outlet, date and link.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', description: 'Search terms (Google News syntax).' }, language: { type: 'string', description: 'e.g. en-US' }, country: { type: 'string', description: 'e.g. US' } },
          required: ['query'],
        },
      },
    ],
    insights: [{ title: 'Top outlets', panel: 'top', by: 'author' }],
  },
  module: {
    sources: {
      async feeds(c, ctx) {
        const words = asList(c.keywords);
        const items: Item[] = [];
        for (const url of asList(c.urls)) {
          try {
            items.push(...parseFeed(ctx, await ctx.text(url)).filter((i) => matches(i, words)));
          } catch (err: any) {
            ctx.log(`${url}: ${err.message}`);
          }
        }
        return { items };
      },
      async 'google-news'(c, ctx) {
        const body = await ctx.text(newsUrl(String(c.query), String(c.language || 'en-US'), String(c.country || 'US')));
        return { items: parseFeed(ctx, body) };
      },
      async 'app-reviews'(c, ctx) {
        const id = String(c.appId).replace(/\D/g, '');
        const cc = String(c.country || 'us').toLowerCase();
        const doc = await ctx.json(`https://itunes.apple.com/${encodeURIComponent(cc)}/rss/customerreviews/id=${id}/sortby=mostrecent/json`);
        const entries = arr(doc?.feed?.entry).filter((e: any) => e?.['im:rating']);
        const items: Item[] = entries.map((e: any) => {
          const rating = Number(e['im:rating']?.label);
          return {
            id: String(e.id?.label),
            kind: 'review',
            title: e.title?.label,
            text: e.content?.label,
            author: e.author?.name?.label,
            url: e.author?.uri?.label,
            publishedAt: toMs(e.updated?.label),
            metrics: { rating, likes: Number(e['im:voteCount']?.label) || 0 },
            extra: { rating, version: e['im:version']?.label, country: cc },
          };
        });
        const ratings = items.map((i) => i.metrics!.rating!).filter(Number.isFinite);
        const today = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
        return {
          items,
          points: ratings.length ? [{ series: `rating:${id}:${cc}`, t: today, value: Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 100) / 100 }] : [],
        };
      },
    },
    tools: {
      async news_search(a, ctx) {
        const items = parseFeed(ctx, await ctx.text(newsUrl(String(a.query ?? ''), String(a.language || 'en-US'), String(a.country || 'US')))).slice(0, 15);
        if (!items.length) return 'No articles found.';
        return items.map((i) => `- ${i.title} — ${i.author ?? ''}, ${i.publishedAt ? new Date(i.publishedAt).toISOString().slice(0, 10) : ''}\n  ${i.url}`).join('\n');
      },
    },
  },
};
