import { Item, Point } from '../../common/types';
import { BuiltinPlugin, PluginContext } from '../api';

const GRAPH = 'https://graph.facebook.com/v21.0';

async function graph(ctx: PluginContext, path: string, params: Record<string, string> = {}, token?: string) {
  const t = token ?? (await ctx.secret('accessToken'));
  if (!t) throw new Error('Add a Meta access token under Plugins → Instagram & Facebook.');
  const r = await ctx.json(`${GRAPH}/${path}?${new URLSearchParams({ ...params, access_token: t })}`);
  if (r.error) throw new Error(`Meta: ${r.error.message}`);
  return r;
}

const igMedia = (m: any): Item => ({
  id: m.id,
  kind: m.media_type === 'VIDEO' || m.media_product_type === 'REELS' ? 'video' : 'post',
  text: m.caption,
  url: m.permalink,
  author: m.username ? `@${m.username}` : undefined,
  publishedAt: Date.parse(m.timestamp),
  metrics: { likes: m.like_count, comments: m.comments_count },
  tags: (String(m.caption ?? '').match(/#[\p{L}\p{N}_]+/gu) ?? []).slice(0, 20),
  media: m.media_url || m.thumbnail_url ? [{ type: m.media_type === 'VIDEO' ? 'video' : 'image', url: m.thumbnail_url || m.media_url }] : undefined,
  extra: { platform: 'instagram', mediaType: m.media_type },
});

const MEDIA_FIELDS = 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count,username';

/** A Page's own token (Page endpoints need it); falls back to the saved token. */
async function pageToken(ctx: PluginContext, pageId: string) {
  try {
    return (await graph(ctx, pageId, { fields: 'access_token' })).access_token as string | undefined;
  } catch {
    return undefined;
  }
}

export const metaPlugin: BuiltinPlugin = {
  manifest: {
    id: 'meta',
    name: 'Instagram & Facebook',
    version: '1.0.0',
    icon: '📸',
    description: 'Your Instagram Business/Creator account and Facebook Pages: posts, engagement, comments, followers, and Instagram hashtag search.',
    notice:
      'Meta’s official API only gives data for accounts and Pages you manage (plus public hashtag search from your Business account). It does not give competitors’ posts or followers; for public data on other accounts use the Apify plugin. Needs a long-lived access token from a Meta app with instagram_basic, instagram_manage_insights, pages_read_engagement and pages_show_list.',
    homepage: 'https://developers.facebook.com/tools/explorer/',
    credentials: [{ key: 'accessToken', label: 'Long-lived access token', help: 'Graph API Explorer → generate a user token, then extend it (Access Token Debugger).' }],
    sources: [
      {
        id: 'ig-media',
        title: 'Instagram: my posts',
        hint: 'Your latest posts with likes/comments + followers',
        kind: 'post',
        needs: ['accessToken'],
        fields: [{ key: 'igUserId', label: 'Instagram account ID', type: 'text', required: true, help: 'Find it: GET /me/accounts?fields=instagram_business_account in the Graph API Explorer.' }],
      },
      {
        id: 'ig-comments',
        title: 'Instagram: comments on my posts',
        hint: 'What people say under your latest posts',
        kind: 'comment',
        needs: ['accessToken'],
        fields: [
          { key: 'igUserId', label: 'Instagram account ID', type: 'text', required: true },
          { key: 'posts', label: 'Latest posts to scan', type: 'number', default: 10 },
        ],
      },
      {
        id: 'ig-hashtag',
        title: 'Instagram: hashtag',
        hint: 'Top or recent public posts for a hashtag',
        kind: 'post',
        needs: ['accessToken'],
        fields: [
          { key: 'igUserId', label: 'Your Instagram account ID', type: 'text', required: true, help: 'Hashtag search runs through your Business account (30 hashtags per 7 days).' },
          { key: 'hashtag', label: 'Hashtag', type: 'text', required: true, placeholder: 'coffee' },
          { key: 'edge', label: 'Posts', type: 'select', default: 'recent_media', options: [{ value: 'recent_media', label: 'Recent (24h)' }, { value: 'top_media', label: 'Top' }] },
        ],
      },
      {
        id: 'fb-page',
        title: 'Facebook: Page posts',
        hint: 'Posts, reactions, comments, shares + followers',
        kind: 'post',
        needs: ['accessToken'],
        fields: [{ key: 'pageId', label: 'Page ID', type: 'text', required: true, help: 'Find it: GET /me/accounts in the Graph API Explorer.' }],
      },
    ],
    insights: [{ title: 'Followers', panel: 'timeseries', series: 'instagram:' }],
  },
  module: {
    sources: {
      async 'ig-media'(c, ctx) {
        const id = String(c.igUserId).trim();
        const [acct, media] = await Promise.all([graph(ctx, id, { fields: 'username,followers_count,media_count' }), graph(ctx, `${id}/media`, { fields: MEDIA_FIELDS, limit: '50' })]);
        const t = Date.now();
        const points: Point[] = [
          { series: `instagram:@${acct.username}:followers`, t, value: acct.followers_count ?? 0 },
          { series: `instagram:@${acct.username}:posts`, t, value: acct.media_count ?? 0 },
        ];
        return { points, items: (media.data ?? []).map(igMedia) };
      },
      async 'ig-comments'(c, ctx) {
        const id = String(c.igUserId).trim();
        const media = await graph(ctx, `${id}/media`, { fields: 'id,permalink,caption', limit: String(Math.min(25, Number(c.posts) || 10)) });
        const items: Item[] = [];
        for (const m of media.data ?? []) {
          const r = await graph(ctx, `${m.id}/comments`, { fields: 'id,text,username,timestamp,like_count,replies{id,text,username,timestamp,like_count}', limit: '100' });
          for (const cm of r.data ?? []) {
            for (const x of [cm, ...(cm.replies?.data ?? [])]) {
              items.push({
                id: x.id,
                kind: 'comment',
                title: m.caption ? `On: ${String(m.caption).slice(0, 80)}` : undefined,
                text: x.text,
                url: m.permalink,
                author: x.username ? `@${x.username}` : undefined,
                publishedAt: Date.parse(x.timestamp),
                metrics: { likes: x.like_count },
                extra: { platform: 'instagram', mediaId: m.id },
              });
            }
          }
        }
        return { items };
      },
      async 'ig-hashtag'(c, ctx) {
        const user = String(c.igUserId).trim();
        const tag = String(c.hashtag).replace(/^#/, '').trim();
        const found = await graph(ctx, 'ig_hashtag_search', { user_id: user, q: tag });
        const hid = found.data?.[0]?.id;
        if (!hid) throw new Error(`Hashtag not found: #${tag}`);
        const edge = c.edge === 'top_media' ? 'top_media' : 'recent_media';
        const r = await graph(ctx, `${hid}/${edge}`, { user_id: user, fields: 'id,caption,media_type,permalink,timestamp,like_count,comments_count', limit: '50' });
        return { items: (r.data ?? []).map((m: any) => ({ ...igMedia(m), extra: { platform: 'instagram', hashtag: `#${tag}` } })) };
      },
      async 'fb-page'(c, ctx) {
        const id = String(c.pageId).trim();
        const token = await pageToken(ctx, id);
        const [page, posts] = await Promise.all([
          graph(ctx, id, { fields: 'name,followers_count,fan_count' }, token),
          graph(ctx, `${id}/posts`, { fields: 'id,message,created_time,permalink_url,shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),full_picture', limit: '50' }, token),
        ]);
        const t = Date.now();
        return {
          points: [{ series: `facebook:${page.name}:followers`, t, value: page.followers_count ?? page.fan_count ?? 0 }],
          items: (posts.data ?? []).map((p: any) => ({
            id: p.id,
            kind: 'post' as const,
            text: p.message,
            url: p.permalink_url,
            author: page.name,
            publishedAt: Date.parse(p.created_time),
            metrics: { likes: p.reactions?.summary?.total_count, comments: p.comments?.summary?.total_count, shares: p.shares?.count },
            media: p.full_picture ? [{ type: 'image' as const, url: p.full_picture }] : undefined,
            extra: { platform: 'facebook' },
          })),
        };
      },
    },
    async test(ctx) {
      const me = await graph(ctx, 'me', { fields: 'id,name' });
      const pages = await graph(ctx, 'me/accounts', { fields: 'id,name,instagram_business_account' }).catch(() => ({ data: [] }));
      const list = (pages.data ?? []).map((p: any) => `${p.name} (Page ${p.id}${p.instagram_business_account ? `, Instagram ${p.instagram_business_account.id}` : ''})`);
      return `Token works for ${me.name}.${list.length ? ` Pages: ${list.join('; ')}.` : ' No Pages found for this token.'}`;
    },
  },
};
