import { Item } from '../../common/types';
import { arr, BuiltinPlugin, PluginContext, stripHtml, toMs, xt } from '../api';

// Reddit blocks most anonymous JSON; without app credentials we read its RSS
// feeds (no scores), with them we use the official OAuth API (scores, comments).
let token: { value: string; until: number; for: string } | null = null;

async function oauth(ctx: PluginContext): Promise<string | null> {
  const id = await ctx.secret('clientId');
  const secret = await ctx.secret('clientSecret');
  if (!id || !secret) return null;
  if (token && token.for === id && token.until > Date.now() + 60_000) return token.value;
  const r = await ctx.json('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!r.access_token) throw new Error(`Reddit login failed: ${r.error ?? 'no token'}`);
  token = {
    value: r.access_token,
    until: Date.now() + (Number(r.expires_in) || 3600) * 1000,
    for: id,
  };
  return token.value;
}

const post = (d: any): Item => ({
  id: d.name ?? `t3_${d.id}`,
  kind: 'post',
  title: d.title,
  text: d.selftext ? d.selftext.slice(0, 4000) : undefined,
  url: `https://www.reddit.com${d.permalink}`,
  author: d.author ? `u/${d.author}` : undefined,
  publishedAt: d.created_utc ? d.created_utc * 1000 : undefined,
  metrics: { score: d.score, comments: d.num_comments },
  media: d.thumbnail?.startsWith?.('http') ? [{ type: 'image', url: d.thumbnail }] : undefined,
  extra: {
    subreddit: d.subreddit_name_prefixed ?? (d.subreddit ? `r/${d.subreddit}` : undefined),
    link: d.url_overridden_by_dest ?? d.url,
    flair: d.link_flair_text ?? undefined,
  },
});

const comment = (d: any): Item => ({
  id: d.name ?? `t1_${d.id}`,
  kind: 'comment',
  title: d.link_title ? `Re: ${d.link_title}` : undefined,
  text: d.body,
  url: d.permalink ? `https://www.reddit.com${d.permalink}` : undefined,
  author: d.author ? `u/${d.author}` : undefined,
  publishedAt: d.created_utc ? d.created_utc * 1000 : undefined,
  metrics: { score: d.score },
  extra: {
    subreddit: d.subreddit_name_prefixed ?? (d.subreddit ? `r/${d.subreddit}` : undefined),
  },
});

/** Reddit's Atom feeds (anonymous). */
async function rss(ctx: PluginContext, path: string, kind: 'post' | 'comment'): Promise<Item[]> {
  const doc = ctx.xml(
    await ctx.text(`https://www.reddit.com${path}`, {
      headers: { accept: 'application/atom+xml' },
    }),
  );
  return (
    arr(doc?.feed?.entry)
      // Search feeds mix in communities and users; keep posts/comments only.
      .filter((e: any) => /\/comments\//.test(arr(e.link)[0]?.['@href'] ?? ''))
      .map((e: any) => ({
        id: xt(e.id),
        kind,
        title: stripHtml(xt(e.title)),
        text:
          stripHtml(xt(e.content))
            .replace(/submitted by .*$/, '')
            .trim()
            .slice(0, 4000) || undefined,
        url: arr(e.link)[0]?.['@href'],
        author: xt(e.author?.name).replace(/^\/u\//, 'u/') || undefined,
        publishedAt: toMs(xt(e.published) || xt(e.updated)),
        extra: {
          subreddit: e.category?.['@label'] ?? (e.category?.['@term'] ? `r/${e.category['@term']}` : undefined),
        },
      }))
  );
}

async function search(ctx: PluginContext, c: Record<string, any>): Promise<Item[]> {
  const sub = String(c.subreddit ?? '')
    .replace(/^\/?r\//, '')
    .trim();
  const params = new URLSearchParams({
    q: String(c.query),
    sort: String(c.sort || 'new'),
    t: String(c.time || 'week'),
    limit: '100',
    restrict_sr: sub ? '1' : '0',
    type: 'link',
  });
  const t = await oauth(ctx);
  const base = sub ? `/r/${encodeURIComponent(sub)}/search` : '/search';
  if (!t) return rss(ctx, `${base}.rss?${params}`, 'post');
  const r = await ctx.json(`https://oauth.reddit.com${base}?${params}&raw_json=1`, { headers: { authorization: `Bearer ${t}` } });
  return (r.data?.children ?? []).map((ch: any) => post(ch.data));
}

export const redditPlugin: BuiltinPlugin = {
  manifest: {
    id: 'reddit',
    name: 'Reddit',
    version: '1.0.0',
    icon: '👽',
    description: 'Posts and comments that mention you, your products or competitors; new posts in communities you follow.',
    notice:
      'Works without a key through Reddit’s RSS feeds (no scores, low rate limits). Create a free “script” app at reddit.com/prefs/apps and add its ID and secret for scores, comment counts and higher limits.',
    homepage: 'https://www.reddit.com/prefs/apps',
    credentials: [
      {
        key: 'clientId',
        label: 'App client ID',
        optional: true,
        help: 'Under the app name at reddit.com/prefs/apps',
      },
      { key: 'clientSecret', label: 'App secret', optional: true },
    ],
    sources: [
      {
        id: 'search',
        title: 'Reddit search',
        hint: 'Posts matching keywords',
        kind: 'post',
        fields: [
          {
            key: 'query',
            label: 'Keywords',
            type: 'text',
            required: true,
            placeholder: '"acme" OR acmeapp',
          },
          {
            key: 'subreddit',
            label: 'Only in subreddit',
            type: 'text',
            placeholder: 'Optional, e.g. startups',
          },
          {
            key: 'sort',
            label: 'Sort',
            type: 'select',
            default: 'new',
            options: ['new', 'relevance', 'top', 'comments'],
          },
          {
            key: 'time',
            label: 'Period',
            type: 'select',
            default: 'week',
            options: ['hour', 'day', 'week', 'month', 'year', 'all'],
          },
        ],
      },
      {
        id: 'subreddit',
        title: 'Subreddit posts',
        hint: 'New or top posts in a community',
        kind: 'post',
        fields: [
          {
            key: 'name',
            label: 'Subreddit',
            type: 'text',
            required: true,
            placeholder: 'marketing',
          },
          {
            key: 'listing',
            label: 'Listing',
            type: 'select',
            default: 'new',
            options: ['new', 'hot', 'top', 'rising'],
          },
        ],
      },
      {
        id: 'comments',
        title: 'Post comments',
        hint: 'All comments on one post',
        kind: 'comment',
        fields: [
          {
            key: 'post',
            label: 'Post link',
            type: 'text',
            required: true,
            placeholder: 'https://www.reddit.com/r/…/comments/abc123/…',
          },
        ],
      },
    ],
    tools: [
      {
        name: 'reddit_search',
        description: 'Search Reddit posts by keyword (optionally within a subreddit). Returns titles, subreddit, score and links.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            subreddit: { type: 'string' },
            sort: {
              type: 'string',
              enum: ['new', 'relevance', 'top', 'comments'],
            },
            time: {
              type: 'string',
              enum: ['day', 'week', 'month', 'year', 'all'],
            },
          },
          required: ['query'],
        },
      },
    ],
    insights: [{ title: 'Top subreddits', panel: 'top', by: 'extra.subreddit' }],
  },
  module: {
    sources: {
      search: async (c, ctx) => ({ items: await search(ctx, c) }),
      async subreddit(c, ctx) {
        const name = String(c.name)
          .replace(/^\/?r\//, '')
          .trim();
        const listing = ['new', 'hot', 'top', 'rising'].includes(c.listing) ? c.listing : 'new';
        const t = await oauth(ctx);
        if (!t)
          return {
            items: await rss(ctx, `/r/${encodeURIComponent(name)}/${listing}.rss?limit=100`, 'post'),
          };
        const r = await ctx.json(`https://oauth.reddit.com/r/${encodeURIComponent(name)}/${listing}?limit=100&raw_json=1`, { headers: { authorization: `Bearer ${t}` } });
        return {
          items: (r.data?.children ?? []).map((ch: any) => post(ch.data)),
        };
      },
      async comments(c, ctx) {
        const m = /comments\/([a-z0-9]+)/i.exec(String(c.post)) ?? /^([a-z0-9]{5,10})$/i.exec(String(c.post).trim());
        if (!m) throw new Error('Paste a Reddit post link (…/comments/<id>/…).');
        const t = await oauth(ctx);
        if (!t)
          return {
            items: (await rss(ctx, `/comments/${m[1]}.rss?limit=200`, 'comment')).slice(1),
          };
        const r = await ctx.json(`https://oauth.reddit.com/comments/${m[1]}?limit=200&depth=4&raw_json=1`, { headers: { authorization: `Bearer ${t}` } });
        const title = r?.[0]?.data?.children?.[0]?.data?.title;
        const out: Item[] = [];
        const walk = (children: any[]) => {
          for (const ch of children ?? []) {
            if (ch.kind !== 't1') continue;
            out.push(comment({ ...ch.data, link_title: title }));
            if (ch.data.replies?.data?.children) walk(ch.data.replies.data.children);
          }
        };
        walk(r?.[1]?.data?.children);
        return { items: out };
      },
    },
    tools: {
      async reddit_search(a, ctx) {
        const items = (await search(ctx, { sort: 'new', time: 'week', ...a })).slice(0, 20);
        return (
          items.map((i) => `- ${i.extra?.subreddit ?? ''} ${i.metrics?.score != null ? `[${i.metrics.score}]` : ''} ${i.title}\n  ${i.url}${i.text ? `\n  ${i.text.slice(0, 200)}` : ''}`).join('\n') ||
          'No results.'
        );
      },
    },
    async test(ctx) {
      const t = await oauth(ctx);
      if (!t) return 'No app credentials saved: Reddit will be read through RSS (no scores).';
      return 'Reddit app credentials work.';
    },
  },
};
