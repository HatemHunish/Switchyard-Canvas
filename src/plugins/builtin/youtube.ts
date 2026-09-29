import { Item, Point } from '../../common/types';
import { BuiltinPlugin, num, PluginContext } from '../api';

const API = 'https://www.googleapis.com/youtube/v3';

async function yt(ctx: PluginContext, path: string, params: Record<string, string>) {
  const key = await ctx.secret('apiKey');
  if (!key) throw new Error('Add a YouTube Data API key under Plugins → YouTube.');
  return ctx.json(`${API}/${path}?${new URLSearchParams({ ...params, key })}`);
}

/** Full details (stats) for up to 50 video ids. */
async function videos(ctx: PluginContext, ids: string[]): Promise<Item[]> {
  if (!ids.length) return [];
  const r = await yt(ctx, 'videos', { part: 'snippet,statistics', id: ids.slice(0, 50).join(','), maxResults: '50' });
  return (r.items ?? []).map((v: any) => ({
    id: v.id,
    kind: 'video',
    title: v.snippet?.title,
    text: v.snippet?.description?.slice(0, 3000) || undefined,
    url: `https://www.youtube.com/watch?v=${v.id}`,
    author: v.snippet?.channelTitle,
    publishedAt: Date.parse(v.snippet?.publishedAt),
    metrics: { views: num(v.statistics?.viewCount), likes: num(v.statistics?.likeCount), comments: num(v.statistics?.commentCount) },
    tags: v.snippet?.tags?.slice(0, 15),
    media: v.snippet?.thumbnails?.medium?.url ? [{ type: 'image', url: v.snippet.thumbnails.medium.url }] : undefined,
    extra: { channelId: v.snippet?.channelId },
  }));
}

async function search(ctx: PluginContext, q: string, order = 'date', max = 25, publishedAfter?: string) {
  const params: Record<string, string> = { part: 'id', q, type: 'video', order, maxResults: String(Math.min(50, max)) };
  if (publishedAfter) params.publishedAfter = publishedAfter;
  const r = await yt(ctx, 'search', params);
  return videos(ctx, (r.items ?? []).map((i: any) => i.id?.videoId).filter(Boolean));
}

async function channel(ctx: PluginContext, ref: string) {
  const s = ref.trim().replace(/^https?:\/\/(www\.)?youtube\.com\//, '');
  const params: Record<string, string> = { part: 'snippet,statistics,contentDetails' };
  if (/^UC[\w-]{20,}$/.test(s)) params.id = s;
  else if (s.startsWith('channel/')) params.id = s.slice(8).split('/')[0];
  else params.forHandle = s.startsWith('@') ? s.split('/')[0] : `@${s.split('/')[0]}`;
  const r = await yt(ctx, 'channels', params);
  const ch = r.items?.[0];
  if (!ch) throw new Error(`YouTube channel not found: ${ref}`);
  return ch;
}

export const youtubePlugin: BuiltinPlugin = {
  manifest: {
    id: 'youtube',
    name: 'YouTube',
    version: '1.0.0',
    icon: '▶️',
    description: 'Videos about your topic, your or competitors’ channel growth, and comments on videos.',
    notice: 'Needs a free YouTube Data API v3 key (Google Cloud console). The free quota is 10,000 units/day; a search costs 100.',
    homepage: 'https://console.cloud.google.com/apis/library/youtube.googleapis.com',
    credentials: [{ key: 'apiKey', label: 'YouTube Data API key', help: 'https://developers.google.com/youtube/v3/getting-started' }],
    sources: [
      {
        id: 'search',
        title: 'YouTube search',
        hint: 'Videos matching keywords, with views/likes',
        kind: 'video',
        needs: ['apiKey'],
        fields: [
          { key: 'query', label: 'Keywords', type: 'text', required: true },
          { key: 'order', label: 'Order', type: 'select', default: 'date', options: [{ value: 'date', label: 'Newest' }, { value: 'relevance', label: 'Relevance' }, { value: 'viewCount', label: 'Most viewed' }] },
          { key: 'max', label: 'Max videos', type: 'number', default: 25 },
        ],
      },
      {
        id: 'channel',
        title: 'Channel stats & uploads',
        hint: 'Subscribers, views and latest videos of a channel',
        kind: 'video',
        needs: ['apiKey'],
        fields: [{ key: 'channel', label: 'Channel', type: 'text', required: true, placeholder: '@handle, channel ID or link' }],
      },
      {
        id: 'comments',
        title: 'Video comments',
        hint: 'Latest comments on a video',
        kind: 'comment',
        needs: ['apiKey'],
        fields: [{ key: 'video', label: 'Video', type: 'text', required: true, placeholder: 'Video link or ID' }],
      },
    ],
    tools: [
      {
        name: 'youtube_search',
        description: 'Search YouTube videos by keyword. Returns title, channel, date, views and link.',
        inputSchema: { type: 'object', properties: { query: { type: 'string' }, order: { type: 'string', enum: ['date', 'relevance', 'viewCount'] } }, required: ['query'] },
      },
    ],
    insights: [
      { title: 'Channel subscribers', panel: 'timeseries', series: 'youtube:' },
      { title: 'Top channels', panel: 'top', by: 'author' },
    ],
  },
  module: {
    sources: {
      search: async (c, ctx) => ({ items: await search(ctx, String(c.query), String(c.order || 'date'), Number(c.max) || 25) }),
      async channel(c, ctx) {
        const ch = await channel(ctx, String(c.channel));
        const name = ch.snippet?.customUrl || ch.snippet?.title || ch.id;
        const t = Date.now();
        const points: Point[] = [
          { series: `youtube:${name}:subscribers`, t, value: Number(ch.statistics?.subscriberCount) || 0 },
          { series: `youtube:${name}:views`, t, value: Number(ch.statistics?.viewCount) || 0 },
          { series: `youtube:${name}:videos`, t, value: Number(ch.statistics?.videoCount) || 0 },
        ];
        const uploads = ch.contentDetails?.relatedPlaylists?.uploads;
        const list = uploads ? await yt(ctx, 'playlistItems', { part: 'contentDetails', playlistId: uploads, maxResults: '25' }) : { items: [] };
        return { points, items: await videos(ctx, (list.items ?? []).map((i: any) => i.contentDetails?.videoId).filter(Boolean)) };
      },
      async comments(c, ctx) {
        const s = String(c.video);
        const id = /[?&]v=([\w-]{11})/.exec(s)?.[1] ?? /youtu\.be\/([\w-]{11})/.exec(s)?.[1] ?? /shorts\/([\w-]{11})/.exec(s)?.[1] ?? s.trim();
        const r = await yt(ctx, 'commentThreads', { part: 'snippet', videoId: id, order: 'time', maxResults: '100', textFormat: 'plainText' });
        return {
          items: (r.items ?? []).map((th: any) => {
            const top = th.snippet?.topLevelComment?.snippet ?? {};
            return {
              id: th.id,
              kind: 'comment',
              text: top.textDisplay,
              url: `https://www.youtube.com/watch?v=${id}&lc=${th.id}`,
              author: top.authorDisplayName,
              publishedAt: Date.parse(top.publishedAt),
              metrics: { likes: top.likeCount, comments: th.snippet?.totalReplyCount },
              extra: { videoId: id },
            };
          }),
        };
      },
    },
    tools: {
      async youtube_search(a, ctx) {
        const items = await search(ctx, String(a.query ?? ''), String(a.order || 'relevance'), 15);
        return items.map((i) => `- ${i.title} — ${i.author}, ${new Date(i.publishedAt!).toISOString().slice(0, 10)}, ${i.metrics?.views ?? '?'} views\n  ${i.url}`).join('\n') || 'No videos found.';
      },
    },
    async test(ctx) {
      await yt(ctx, 'videos', { part: 'id', chart: 'mostPopular', maxResults: '1' });
      return 'YouTube key works.';
    },
  },
};
