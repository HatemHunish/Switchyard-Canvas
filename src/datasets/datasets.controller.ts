import { Body, Controller, Delete, ForbiddenException, Get, Header, Headers, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { isInternal } from '../common/runtime';
import { PluginsService } from '../plugins/plugins.service';
import { DatasetsService } from './datasets.service';

@Controller('api')
export class DatasetsController {
  constructor(
    private readonly datasets: DatasetsService,
    private readonly plugins: PluginsService,
  ) {}

  @Get('datasets')
  list() {
    return this.datasets.list();
  }

  @Get('datasets/:id/insights')
  insights(@Param('id') id: string, @Query('range') range = '30d', @Query('source') source?: string, @Query('feed') feed?: string) {
    const f = { range, source: source || undefined, feed: feed || undefined };
    const base = this.datasets.insights(id, f);
    // Panels declared by the plugins whose data is in this dataset.
    const present = new Set(base.bySource.map((s) => s.source).concat(base.series.map((s) => s.source)));
    const panels = this.plugins
      .all()
      .filter((p) => present.has(p.manifest.id))
      .flatMap((p) => (p.manifest.insights ?? []).map((i) => ({ ...i, plugin: p.manifest.id, pluginName: p.manifest.name, icon: p.manifest.icon })))
      .map((panel) => (panel.panel === 'top' && panel.by ? { ...panel, rows: this.datasets.topBy(id, panel.by, { ...f, source: panel.plugin }) } : panel));
    return { ...base, panels };
  }

  @Get('datasets/:id/items')
  items(
    @Param('id') id: string,
    @Query('q') q?: string,
    @Query('range') range?: string,
    @Query('source') source?: string,
    @Query('feed') feed?: string,
    @Query('sentiment') sentiment?: 'neg' | 'pos' | 'neutral',
    @Query('sort') sort?: 'recent' | 'engagement',
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.datasets.search(id, { q, range, source: source || undefined, feed: feed || undefined, sentiment, sort, limit: Number(limit) || 25, offset: Number(offset) || 0 });
  }

  @Get('datasets/:id/export.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  csv(@Param('id') id: string, @Query('range') range: string | undefined, @Query('source') source: string | undefined, @Res() res: Response) {
    res.setHeader('Content-Disposition', `attachment; filename="${id}.csv"`);
    res.send(`﻿${this.datasets.csv(id, { range, source: source || undefined })}`);
  }

  @Delete('datasets/:id')
  remove(@Param('id') id: string) {
    this.datasets.delete(id);
    return { deleted: true };
  }

  // ---- dataset_* tools for agents (bundled MCP server) ----

  @Post('internal/datasets/query')
  internal(@Headers('x-internal-token') token: string, @Body() body: { tool: string; datasets: string[]; args: Record<string, any> }) {
    if (!isInternal(token)) throw new ForbiddenException();
    const allowed = (body.datasets ?? []).filter((d) => this.datasets.exists(d));
    if (!allowed.length) return { text: 'No dataset is connected (or it is still empty).' };
    const a = body.args ?? {};
    const pick = a.dataset && allowed.includes(a.dataset) ? [a.dataset] : allowed;
    const clip = (s?: string, n = 400) => (!s ? '' : s.length > n ? `${s.slice(0, n)}…` : s);
    const fmt = (i: any) =>
      `- [${i.source}${i.kind !== 'post' ? ` ${i.kind}` : ''}] ${i.title ?? ''}${i.author ? ` — ${i.author}` : ''}${i.publishedAt ? `, ${new Date(i.publishedAt).toISOString().slice(0, 10)}` : ''}${
        i.sentiment != null ? `, sentiment ${Number(i.sentiment).toFixed(2)}` : ''
      }${i.metrics ? `, ${Object.entries(i.metrics).map(([k, v]) => `${k} ${v}`).join(' ')}` : ''}\n  ${clip(i.text)}${i.url ? `\n  ${i.url}` : ''}`;
    switch (body.tool) {
      case 'dataset_stats':
        return { text: pick.map((d) => this.datasets.statsText(d, a.range || '7d')).join('\n\n') };
      case 'dataset_search':
      case 'dataset_top': {
        const out = pick.map((d) => {
          const r = this.datasets.search(d, {
            q: body.tool === 'dataset_search' ? a.query : undefined,
            range: a.range,
            source: a.source,
            sentiment: a.sentiment,
            sort: body.tool === 'dataset_top' ? 'engagement' : 'recent',
            limit: Math.min(Number(a.limit) || 15, 50),
          });
          return `Dataset "${d}": ${r.total} matching item(s)${r.items.length < r.total ? `, showing ${r.items.length}` : ''}\n${r.items.map(fmt).join('\n')}`;
        });
        return { text: out.join('\n\n') };
      }
      default:
        return { text: `Unknown tool ${body.tool}` };
    }
  }
}
