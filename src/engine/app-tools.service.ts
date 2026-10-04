import { Injectable } from '@nestjs/common';
import { DatasetsService } from '../datasets/datasets.service';
import { MemoryService } from '../memory/memory.service';
import { PluginsService } from '../plugins/plugins.service';
import { AppToolScope, appToolNames, fence } from './app-tools';

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], isError });

/**
 * Runs the app's agent tools for one agent's scope. Claude agents call it in
 * process; Codex agents reach it through the stdio server and /api/internal/tools/call.
 * A tool outside the scope is refused, so an agent only sees its own stores.
 */
@Injectable()
export class AppToolsService {
  constructor(
    private readonly memory: MemoryService,
    private readonly datasets: DatasetsService,
    private readonly plugins: PluginsService,
  ) {}

  async call(name: string, args: Record<string, any> | undefined, scope: AppToolScope): Promise<ToolResult> {
    if (!appToolNames(scope).includes(name)) return text(`Unknown tool ${name}`, true);
    const a = args ?? {};
    try {
      switch (name) {
        case 'ask_user':
          return text('Your question was sent to the user. Your turn ends here; the answer arrives as the next message.');
        case 'memory_search': {
          const hits = this.memory.search(scope.memory!.search, String(a.query ?? ''), Math.min(Number(a.limit) || 6, 20));
          if (!hits.length) return text('No matches in memory.');
          return text(hits.map((h, i) => `[${i + 1}] ${h.kind === 'note' ? 'NOTE' : 'DOC'} ${h.key}\n${h.content.slice(0, 2000)}`).join('\n\n---\n\n'));
        }
        case 'memory_save': {
          const key = String(a.key ?? '');
          this.memory.saveNote(scope.memory!.write!, key, String(a.content ?? ''), 'agent', scope.memory!.runId);
          return text(`Saved "${key}".`);
        }
        case 'dataset_search':
        case 'dataset_stats':
        case 'dataset_top':
          // Collected posts and web results are outside content: fenced like any other.
          return text(fence(this.datasetQuery(name, scope.datasets ?? [], a)));
        default:
          return text(fence(await this.plugins.callTool(name, a, AbortSignal.timeout(120_000))));
      }
    } catch (err: any) {
      return text(`Tool failed: ${err?.message ?? err}`, true);
    }
  }

  private datasetQuery(tool: string, datasets: string[], a: Record<string, any>): string {
    const allowed = datasets.filter((d) => this.datasets.exists(d));
    if (!allowed.length) return 'No dataset is connected (or it is still empty).';
    const pick = a.dataset && allowed.includes(a.dataset) ? [a.dataset] : allowed;
    const clip = (s?: string, n = 400) => (!s ? '' : s.length > n ? `${s.slice(0, n)}…` : s);
    const fmt = (i: any) =>
      `- [${i.source}${i.kind !== 'post' ? ` ${i.kind}` : ''}] ${i.title ?? ''}${i.author ? ` — ${i.author}` : ''}${i.publishedAt ? `, ${new Date(i.publishedAt).toISOString().slice(0, 10)}` : ''}${
        i.sentiment != null ? `, sentiment ${Number(i.sentiment).toFixed(2)}` : ''
      }${i.metrics ? `, ${Object.entries(i.metrics).map(([k, v]) => `${k} ${v}`).join(' ')}` : ''}\n  ${clip(i.text)}${i.url ? `\n  ${i.url}` : ''}`;
    if (tool === 'dataset_stats') return pick.map((d) => this.datasets.statsText(d, a.range || '7d')).join('\n\n');
    return pick
      .map((d) => {
        const r = this.datasets.search(d, {
          q: tool === 'dataset_search' ? a.query : undefined,
          range: a.range,
          source: a.source,
          sentiment: a.sentiment,
          sort: tool === 'dataset_top' ? 'engagement' : 'recent',
          limit: Math.min(Number(a.limit) || 15, 50),
        });
        return `Dataset "${d}": ${r.total} matching item(s)${r.items.length < r.total ? `, showing ${r.items.length}` : ''}\n${r.items.map(fmt).join('\n')}`;
      })
      .join('\n\n');
  }
}
