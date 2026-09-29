import { Item } from '../../common/types';
import { BuiltinPlugin, PluginContext, stripHtml } from '../api';

async function search(ctx: PluginContext, query: string, tags: string, minPoints = 0, hits = 50): Promise<Item[]> {
  const params = new URLSearchParams({ query, hitsPerPage: String(Math.min(100, hits)) });
  if (tags && tags !== 'all') params.set('tags', tags);
  if (minPoints > 0) params.set('numericFilters', `points>=${minPoints}`);
  const r = await ctx.json(`https://hn.algolia.com/api/v1/search_by_date?${params}`);
  return (r.hits ?? []).map((h: any) => {
    const isComment = !!h.comment_text;
    return {
      id: String(h.objectID),
      kind: isComment ? 'comment' : 'post',
      title: h.title || (h.story_title ? `Re: ${h.story_title}` : undefined),
      text: stripHtml(h.comment_text || h.story_text || '') || undefined,
      url: !isComment && h.url ? h.url : `https://news.ycombinator.com/item?id=${h.objectID}`,
      author: h.author,
      publishedAt: h.created_at_i ? h.created_at_i * 1000 : undefined,
      metrics: { score: h.points ?? undefined, comments: h.num_comments ?? undefined },
      extra: { discussion: `https://news.ycombinator.com/item?id=${h.story_id ?? h.objectID}` },
    };
  });
}

export const hackernewsPlugin: BuiltinPlugin = {
  manifest: {
    id: 'hackernews',
    name: 'Hacker News',
    version: '1.0.0',
    icon: '🟧',
    description: 'Stories and comments on Hacker News that mention your keywords. No key needed.',
    sources: [
      {
        id: 'search',
        title: 'Hacker News search',
        hint: 'Newest stories/comments matching keywords',
        kind: 'post',
        fields: [
          { key: 'query', label: 'Keywords', type: 'text', required: true, placeholder: 'acme' },
          { key: 'tags', label: 'Include', type: 'select', default: 'story', options: [{ value: 'story', label: 'Stories' }, { value: 'comment', label: 'Comments' }, { value: 'all', label: 'Both' }] },
          { key: 'minPoints', label: 'Minimum points', type: 'number', default: 0 },
        ],
      },
    ],
    tools: [
      {
        name: 'hn_search',
        description: 'Search Hacker News stories and comments by keyword, newest first.',
        inputSchema: { type: 'object', properties: { query: { type: 'string' }, tags: { type: 'string', enum: ['story', 'comment', 'all'] } }, required: ['query'] },
      },
    ],
  },
  module: {
    sources: {
      search: async (c, ctx) => ({ items: await search(ctx, String(c.query), String(c.tags || 'story'), Number(c.minPoints) || 0) }),
    },
    tools: {
      async hn_search(a, ctx) {
        const items = await search(ctx, String(a.query ?? ''), String(a.tags || 'all'), 0, 20);
        return items.map((i) => `- [${i.metrics?.score ?? 0} pts] ${i.title ?? ''} ${i.text ? `— ${i.text.slice(0, 200)}` : ''}\n  ${i.url}`).join('\n') || 'No results.';
      },
    },
  },
};
