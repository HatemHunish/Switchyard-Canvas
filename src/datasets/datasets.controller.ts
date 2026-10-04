import { Body, Controller, Delete, Get, Header, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
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
}
