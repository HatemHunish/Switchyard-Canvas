import { Item } from '../../common/types';
import { arr, BuiltinPlugin, get, num, stripHtml, toMs } from '../api';

/** "likes=stats.likes, views=stats.views" -> { likes: 'stats.likes', views: 'stats.views' } */
const pairs = (s: unknown) =>
  Object.fromEntries(
    String(s ?? '')
      .split(/[\n,]/)
      .map((p) => p.split('=').map((x) => x.trim()))
      .filter((p) => p.length === 2 && p[0] && p[1]),
  );

/** Maps a list of arbitrary JSON records into items with dot paths. Shared with the Apify plugin. */
export function mapRecords(records: any[], m: { id?: string; title?: string; text?: string; url?: string; author?: string; date?: string; metrics?: unknown }, kind: Item['kind'] = 'post'): Item[] {
  const metricPaths = pairs(m.metrics);
  return records.map((r, i) => {
    const metrics: Record<string, number> = {};
    for (const [k, p] of Object.entries(metricPaths)) {
      const v = num(get(r, String(p)));
      if (v !== undefined) metrics[k] = v;
    }
    const text = get(r, m.text);
    return {
      id: String(get(r, m.id || 'id') ?? get(r, m.url || 'url') ?? i),
      kind,
      title: m.title ? String(get(r, m.title) ?? '') || undefined : undefined,
      text: text == null ? undefined : typeof text === 'string' ? stripHtml(text) : JSON.stringify(text),
      url: m.url ? get(r, m.url) : undefined,
      author: m.author ? String(get(r, m.author) ?? '') || undefined : undefined,
      publishedAt: m.date ? toMs(get(r, m.date)) : undefined,
      metrics: Object.keys(metrics).length ? metrics : undefined,
    };
  });
}

export const httpPlugin: BuiltinPlugin = {
  manifest: {
    id: 'http',
    name: 'HTTP JSON',
    version: '1.0.0',
    icon: '🔌',
    description: 'Pull records from any JSON API (your CRM, helpdesk, analytics, a partner feed) and map them into items.',
    credentials: [{ key: 'token', label: 'API token', optional: true, help: 'Used where you write {{token}} in the headers or URL.' }],
    sources: [
      {
        id: 'json',
        title: 'JSON API',
        hint: 'Any API that returns a list',
        kind: 'post',
        fields: [
          { key: 'url', label: 'URL', type: 'text', required: true, placeholder: 'https://api.example.com/tickets?status=open' },
          { key: 'method', label: 'Method', type: 'select', options: ['GET', 'POST'], default: 'GET' },
          { key: 'headers', label: 'Headers (JSON)', type: 'textarea', placeholder: '{"Authorization": "Bearer {{token}}"}' },
          { key: 'body', label: 'Body (POST)', type: 'textarea' },
          { key: 'itemsPath', label: 'List path', type: 'text', placeholder: 'data.items', help: 'Where the array is in the reply. Empty = the reply is the array.' },
          { key: 'idPath', label: 'ID field', type: 'text', default: 'id' },
          { key: 'titlePath', label: 'Title field', type: 'text', placeholder: 'subject' },
          { key: 'textPath', label: 'Text field', type: 'text', placeholder: 'description' },
          { key: 'urlPath', label: 'Link field', type: 'text', placeholder: 'html_url' },
          { key: 'authorPath', label: 'Author field', type: 'text', placeholder: 'user.name' },
          { key: 'datePath', label: 'Date field', type: 'text', placeholder: 'created_at' },
          { key: 'metrics', label: 'Metrics', type: 'textarea', placeholder: 'likes=reactions.total\nviews=view_count', help: 'name=field, one per line.' },
        ],
      },
    ],
  },
  module: {
    sources: {
      async json(c, ctx) {
        const token = (await ctx.secret('token')) ?? '';
        const sub = (s: string) => s.replace(/\{\{\s*token\s*\}\}/g, token);
        let headers: Record<string, string> = {};
        if (String(c.headers ?? '').trim()) {
          try {
            headers = JSON.parse(sub(String(c.headers)));
          } catch {
            throw new Error('Headers must be a JSON object.');
          }
        }
        const method = c.method === 'POST' ? 'POST' : 'GET';
        const reply = await ctx.json(sub(String(c.url)), { method, headers: { ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers }, body: method === 'POST' ? sub(String(c.body ?? '')) : undefined });
        const list = arr(get(reply, c.itemsPath || undefined));
        return { items: mapRecords(list, { id: c.idPath, title: c.titlePath, text: c.textPath, url: c.urlPath, author: c.authorPath, date: c.datePath, metrics: c.metrics }) };
      },
    },
  },
};
