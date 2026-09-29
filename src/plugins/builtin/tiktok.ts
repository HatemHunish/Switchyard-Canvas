import { BuiltinPlugin, PluginContext } from '../api';

const API = 'https://open.tiktokapis.com/v2';

async function tt(ctx: PluginContext, path: string, init: RequestInit = {}) {
  const token = await ctx.secret('accessToken');
  if (!token) throw new Error('Add a TikTok user access token under Plugins → TikTok.');
  const r = await ctx.json(`${API}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers as Record<string, string>) } });
  if (r.error && r.error.code !== 'ok') throw new Error(`TikTok: ${r.error.message || r.error.code}`);
  return r.data;
}

export const tiktokPlugin: BuiltinPlugin = {
  manifest: {
    id: 'tiktok',
    name: 'TikTok',
    version: '1.0.0',
    icon: '🎵',
    description: 'Your TikTok account: videos with views, likes, comments and shares, and follower growth.',
    notice:
      'TikTok’s Display API only covers the account that authorised your app (scopes user.info.stats and video.list). Public search of other accounts or hashtags needs TikTok’s Research API (approved researchers only) or the Apify plugin.',
    homepage: 'https://developers.tiktok.com/',
    credentials: [{ key: 'accessToken', label: 'User access token', help: 'From your TikTok developer app’s login flow (Login Kit).' }],
    sources: [
      {
        id: 'my-videos',
        title: 'TikTok: my videos',
        hint: 'Latest videos with views/likes/shares',
        kind: 'video',
        needs: ['accessToken'],
        fields: [{ key: 'max', label: 'Videos', type: 'number', default: 20 }],
      },
      {
        id: 'my-stats',
        title: 'TikTok: account stats',
        hint: 'Followers and total likes over time',
        kind: 'other',
        needs: ['accessToken'],
        fields: [],
      },
    ],
    insights: [{ title: 'Followers', panel: 'timeseries', series: 'tiktok:' }],
  },
  module: {
    sources: {
      async 'my-videos'(c, ctx) {
        const fields = 'id,title,video_description,create_time,share_url,cover_image_url,view_count,like_count,comment_count,share_count';
        const data = await tt(ctx, `/video/list/?fields=${fields}`, { method: 'POST', body: JSON.stringify({ max_count: Math.min(20, Number(c.max) || 20) }) });
        return {
          items: (data?.videos ?? []).map((v: any) => ({
            id: v.id,
            kind: 'video',
            title: v.title || undefined,
            text: v.video_description,
            url: v.share_url,
            publishedAt: v.create_time * 1000,
            metrics: { views: v.view_count, likes: v.like_count, comments: v.comment_count, shares: v.share_count },
            media: v.cover_image_url ? [{ type: 'image', url: v.cover_image_url }] : undefined,
            extra: { platform: 'tiktok' },
          })),
        };
      },
      async 'my-stats'(_c, ctx) {
        const data = await tt(ctx, '/user/info/?fields=display_name,follower_count,following_count,likes_count,video_count');
        const u = data?.user ?? {};
        const t = Date.now();
        const name = u.display_name || 'me';
        return {
          items: [],
          points: [
            { series: `tiktok:${name}:followers`, t, value: u.follower_count ?? 0 },
            { series: `tiktok:${name}:likes`, t, value: u.likes_count ?? 0 },
            { series: `tiktok:${name}:videos`, t, value: u.video_count ?? 0 },
          ],
        };
      },
    },
    async test(ctx) {
      const data = await tt(ctx, '/user/info/?fields=display_name');
      return `TikTok token works for ${data?.user?.display_name ?? 'your account'}.`;
    },
  },
};
