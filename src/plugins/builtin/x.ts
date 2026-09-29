import { Item } from '../../common/types';
import { BuiltinPlugin, PluginContext } from '../api';

const API = 'https://api.x.com/2';

async function x(ctx: PluginContext, path: string, params: Record<string, string>) {
  const bearer = await ctx.secret('bearer');
  if (!bearer) throw new Error('Add an X API bearer token under Plugins → X.');
  return ctx.json(`${API}${path}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${bearer}` } });
}

const FIELDS = { 'tweet.fields': 'created_at,public_metrics,author_id,lang,conversation_id', expansions: 'author_id', 'user.fields': 'username,name,public_metrics' };

function toItems(r: any): Item[] {
  const users = new Map<string, any>((r.includes?.users ?? []).map((u: any) => [u.id, u]));
  return (r.data ?? []).map((t: any) => {
    const u = users.get(t.author_id);
    const m = t.public_metrics ?? {};
    return {
      id: t.id,
      kind: 'post',
      text: t.text,
      url: `https://x.com/${u?.username ?? 'i'}/status/${t.id}`,
      author: u ? `@${u.username}` : t.author_id,
      publishedAt: Date.parse(t.created_at),
      metrics: { likes: m.like_count, comments: m.reply_count, shares: (m.retweet_count ?? 0) + (m.quote_count ?? 0), views: m.impression_count },
      extra: { lang: t.lang, followers: u?.public_metrics?.followers_count },
    };
  });
}

export const xPlugin: BuiltinPlugin = {
  manifest: {
    id: 'x',
    name: 'X (Twitter)',
    version: '1.0.0',
    icon: '𝕏',
    description: 'Posts that mention your brand or topic from the last 7 days, and follower counts of accounts.',
    notice: 'Needs an X API bearer token. Search requires a paid X API tier (Basic or higher); the free tier cannot search.',
    homepage: 'https://developer.x.com/en/portal/dashboard',
    credentials: [{ key: 'bearer', label: 'Bearer token' }],
    sources: [
      {
        id: 'search',
        title: 'X recent search',
        hint: 'Posts from the last 7 days matching a query',
        kind: 'post',
        needs: ['bearer'],
        fields: [
          { key: 'query', label: 'Query', type: 'text', required: true, placeholder: '(acme OR @acme) -is:retweet lang:en', help: 'X search operators work.' },
          { key: 'max', label: 'Max posts per run', type: 'number', default: 50, help: '10–100. Each post counts against your monthly cap.' },
        ],
      },
      {
        id: 'user',
        title: 'Account stats & posts',
        hint: 'Followers over time and latest posts',
        kind: 'post',
        needs: ['bearer'],
        fields: [{ key: 'username', label: 'Username', type: 'text', required: true, placeholder: '@acme' }],
      },
    ],
    insights: [{ title: 'Followers', panel: 'timeseries', series: 'x:' }],
  },
  module: {
    sources: {
      async search(c, ctx) {
        const params: Record<string, string> = { query: String(c.query), max_results: String(Math.max(10, Math.min(100, Number(c.max) || 50))), ...FIELDS };
        // Only ask for posts newer than last time: saves the monthly cap.
        if (ctx.state.sinceId) params.since_id = ctx.state.sinceId;
        const r = await x(ctx, '/tweets/search/recent', params);
        if (r.meta?.newest_id) ctx.state.sinceId = r.meta.newest_id;
        return { items: toItems(r) };
      },
      async user(c, ctx) {
        const name = String(c.username).replace(/^@/, '').trim();
        const u = await x(ctx, `/users/by/username/${encodeURIComponent(name)}`, { 'user.fields': 'public_metrics' });
        if (!u.data) throw new Error(`X account not found: @${name}`);
        const m = u.data.public_metrics ?? {};
        const t = Date.now();
        const posts = await x(ctx, `/users/${u.data.id}/tweets`, { max_results: '20', exclude: 'retweets,replies', ...FIELDS });
        return {
          points: [
            { series: `x:@${name}:followers`, t, value: m.followers_count ?? 0 },
            { series: `x:@${name}:posts`, t, value: m.tweet_count ?? 0 },
          ],
          items: toItems(posts),
        };
      },
    },
    async test(ctx) {
      await x(ctx, '/users/by/username/X', {});
      return 'X token works.';
    },
  },
};
