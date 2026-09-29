import { createHash } from 'crypto';
import { Item } from '../../common/types';
import { asList, BuiltinPlugin, stripHtml } from '../api';

/** Keeps the part of the page you care about, minus noise that changes on every load. */
function focus(text: string, start?: string, end?: string, ignore?: string[]) {
  let t = text;
  if (start) {
    const i = t.indexOf(start);
    if (i >= 0) t = t.slice(i);
  }
  if (end) {
    const j = t.indexOf(end, start ? start.length : 0);
    if (j >= 0) t = t.slice(0, j + end.length);
  }
  for (const pattern of ignore ?? []) {
    try {
      t = t.replace(new RegExp(pattern, 'g'), '');
    } catch {
      /* invalid pattern: skip */
    }
  }
  return t.replace(/\s+/g, ' ').trim();
}

/** Sentence-level diff: what appeared and what disappeared. */
function diff(before: string, after: string) {
  const split = (s: string) => s.split(/(?<=[.!?])\s+|\s{2,}|\s[|•·]\s/).map((x) => x.trim()).filter((x) => x.length > 2);
  const a = new Set(split(before));
  const b = new Set(split(after));
  return { added: [...b].filter((x) => !a.has(x)), removed: [...a].filter((x) => !b.has(x)) };
}

export const webwatchPlugin: BuiltinPlugin = {
  manifest: {
    id: 'webwatch',
    name: 'Web page watch',
    version: '1.0.0',
    icon: '👁️',
    description: 'Watch web pages for changes: competitor pricing, product pages, policies, job boards. Emits an item whenever the watched text changes.',
    notice: 'Only reads public pages. Pages built entirely by JavaScript may look empty; point it at a page or feed that has the text in its HTML.',
    sources: [
      {
        id: 'page',
        title: 'Page change',
        hint: 'Alerts when the text of a page changes',
        kind: 'page',
        fields: [
          { key: 'urls', label: 'Pages', type: 'list', required: true, placeholder: 'https://competitor.com/pricing', help: 'One per line.' },
          { key: 'start', label: 'Start at text', type: 'text', placeholder: 'Pricing', help: 'Optional. Ignore everything before this text.' },
          { key: 'end', label: 'Stop at text', type: 'text', placeholder: 'Frequently asked', help: 'Optional. Ignore everything after this text.' },
          { key: 'ignore', label: 'Ignore patterns', type: 'list', placeholder: '\\d+ minutes ago', help: 'Optional regular expressions for noise such as timestamps.' },
        ],
      },
    ],
  },
  module: {
    sources: {
      async page(c, ctx) {
        const items: Item[] = [];
        const pages: Record<string, { hash: string; text: string; at: number }> = (ctx.state.pages ??= {});
        for (const url of asList(c.urls)) {
          try {
            const html = await ctx.text(url, { headers: { accept: 'text/html,*/*' } });
            const title = stripHtml(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '') || url;
            const text = focus(stripHtml(html), c.start || undefined, c.end || undefined, asList(c.ignore));
            const hash = createHash('sha256').update(text).digest('hex');
            const prev = pages[url];
            if (prev?.hash === hash) continue;
            const d = prev ? diff(prev.text, text) : null;
            const summary = !prev
              ? `First snapshot (${text.length} characters). Changes will be reported from the next run.`
              : [d!.added.length ? `Added:\n${d!.added.slice(0, 20).map((x) => `+ ${x}`).join('\n')}` : '', d!.removed.length ? `Removed:\n${d!.removed.slice(0, 20).map((x) => `- ${x}`).join('\n')}` : '']
                  .filter(Boolean)
                  .join('\n\n') || 'Small change (formatting or whitespace).';
            items.push({
              id: `${url}#${hash.slice(0, 16)}`,
              kind: 'page',
              title: prev ? `Changed: ${title}` : `Watching: ${title}`,
              text: summary,
              url,
              publishedAt: Date.now(),
              extra: { firstSnapshot: !prev, added: d?.added.length ?? 0, removed: d?.removed.length ?? 0 },
            });
            pages[url] = { hash, text: text.slice(0, 60_000), at: Date.now() };
          } catch (err: any) {
            ctx.log(`${url}: ${err.message}`);
          }
        }
        return { items };
      },
    },
  },
};
