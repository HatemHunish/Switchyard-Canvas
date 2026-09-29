import { Item } from '../../common/types';
import { BuiltinPlugin, get, num, toMs } from '../api';
import { mapRecords } from './http';

const first = (r: any, paths: string[]) => {
  for (const p of paths) {
    const v = get(r, p);
    if (v != null && v !== '') return v;
  }
  return undefined;
};

/** Field names used by the popular Instagram, TikTok, Facebook, X and YouTube scrapers on Apify. */
function autoMap(r: any): Item {
  const text = first(r, ['caption', 'text', 'desc', 'description', 'message', 'postText', 'content', 'title']);
  const url = first(r, ['url', 'postUrl', 'webVideoUrl', 'link', 'permalink', 'topLevelUrl']);
  return {
    id: String(first(r, ['id', 'postId', 'shortCode', 'videoId', 'aweme_id', 'url']) ?? JSON.stringify(r).slice(0, 80)),
    kind: first(r, ['videoUrl', 'webVideoUrl', 'videoMeta', 'playCount', 'videoViewCount']) ? 'video' : 'post',
    title: typeof r.title === 'string' && r.title !== text ? r.title : undefined,
    text: text == null ? undefined : String(text),
    url: typeof url === 'string' ? url : undefined,
    author: first(r, ['ownerUsername', 'authorMeta.name', 'author.uniqueId', 'author.userName', 'user.username', 'user.name', 'author', 'pageName', 'channelName', 'username']),
    publishedAt: toMs(first(r, ['timestamp', 'createTimeISO', 'createTime', 'time', 'date', 'publishedAt', 'created_at'])),
    metrics: {
      likes: num(first(r, ['likesCount', 'diggCount', 'likes', 'likeCount', 'reactionsCount', 'favoriteCount'])),
      comments: num(first(r, ['commentsCount', 'commentCount', 'comments', 'replyCount'])),
      shares: num(first(r, ['sharesCount', 'shareCount', 'shares', 'retweetCount'])),
      views: num(first(r, ['videoViewCount', 'playCount', 'viewsCount', 'views', 'viewCount'])),
    },
    tags: Array.isArray(r.hashtags) ? r.hashtags.map((h: any) => (typeof h === 'string' ? h : h?.name)).filter(Boolean) : undefined,
    extra: { platform: first(r, ['platform', 'inputUrl']) },
  };
}

export const apifyPlugin: BuiltinPlugin = {
  manifest: {
    id: 'apify',
    name: 'Apify (public social data)',
    version: '1.0.0',
    icon: '🕷️',
    description: 'Run any Apify actor (for example Instagram, TikTok or Facebook scrapers for public profiles, hashtags and competitors) and collect its results as items.',
    notice:
      'Apify actors collect public data from platforms that may not allow it. You are responsible for following each platform’s terms and privacy law. Runs use your Apify credits.',
    homepage: 'https://apify.com/store',
    credentials: [{ key: 'token', label: 'Apify API token', help: 'https://console.apify.com/settings/integrations' }],
    sources: [
      {
        id: 'actor',
        title: 'Apify actor',
        hint: 'Public Instagram/TikTok/Facebook data via Apify',
        kind: 'post',
        needs: ['token'],
        fields: [
          { key: 'actor', label: 'Actor', type: 'text', required: true, placeholder: 'apify/instagram-hashtag-scraper', help: 'From the actor’s page in the Apify Store.' },
          { key: 'input', label: 'Input (JSON)', type: 'textarea', required: true, placeholder: '{"hashtags": ["coffee"], "resultsLimit": 50}', help: 'Copy it from the actor’s Input tab (JSON view). {{templates}} work.' },
          { key: 'mapping', label: 'Field mapping', type: 'select', default: 'auto', options: [{ value: 'auto', label: 'Automatic (common scrapers)' }, { value: 'custom', label: 'Custom paths' }] },
          { key: 'idPath', label: 'ID field (custom)', type: 'text' },
          { key: 'textPath', label: 'Text field (custom)', type: 'text' },
          { key: 'urlPath', label: 'Link field (custom)', type: 'text' },
          { key: 'authorPath', label: 'Author field (custom)', type: 'text' },
          { key: 'datePath', label: 'Date field (custom)', type: 'text' },
          { key: 'metrics', label: 'Metrics (custom)', type: 'textarea', placeholder: 'likes=likesCount\nviews=videoViewCount' },
        ],
      },
    ],
  },
  module: {
    sources: {
      async actor(c, ctx) {
        const token = (await ctx.secret('token'))!;
        let input: unknown;
        try {
          input = JSON.parse(String(c.input || '{}'));
        } catch {
          throw new Error('Input must be valid JSON.');
        }
        const actor = String(c.actor).trim().replace('/', '~');
        ctx.log(`Running Apify actor ${c.actor} (this can take a few minutes)…`);
        const records = await ctx.json(`https://api.apify.com/v2/acts/${encodeURIComponent(actor)}/run-sync-get-dataset-items?timeout=280&token=${encodeURIComponent(token)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
          timeoutMs: 300_000,
        });
        const list = Array.isArray(records) ? records : [];
        return {
          items: c.mapping === 'custom' ? mapRecords(list, { id: c.idPath, text: c.textPath, url: c.urlPath, author: c.authorPath, date: c.datePath, metrics: c.metrics }) : list.map(autoMap),
          note: `Apify returned ${list.length} records.`,
        };
      },
    },
    async test(ctx) {
      const r = await ctx.json(`https://api.apify.com/v2/users/me?token=${encodeURIComponent((await ctx.secret('token')) ?? '')}`);
      return `Apify token works for ${r.data?.username ?? 'your account'}.`;
    },
  },
};
