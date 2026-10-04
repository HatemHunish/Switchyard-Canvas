import { BadRequestException, Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { execFile } from 'child_process';
import { PLUGINS_DIR } from '../common/paths';
import { DatasetsService } from '../datasets/datasets.service';
import { PluginsService } from './plugins.service';

@Controller('api')
export class PluginsController {
  constructor(
    private readonly plugins: PluginsService,
    private readonly datasets: DatasetsService,
  ) {}

  @Get('plugins')
  async list() {
    const plugins = await Promise.all(
      this.plugins.all().map(async (p) => ({
        ...p.manifest,
        builtin: p.builtin,
        dir: p.dir,
        enabled: p.enabled,
        error: p.error,
        hasCode: !!(p.module.sources || p.module.tools),
        credentialsSet: await this.plugins.credentialStatus(p.manifest.id),
      })),
    );
    return { plugins, failures: this.plugins.failures(), folder: PLUGINS_DIR };
  }

  @Put('plugins/:id')
  setEnabled(@Param('id') id: string, @Body() body: { enabled?: boolean }) {
    this.plugins.setEnabled(id, !!body?.enabled);
    return { enabled: !!body?.enabled };
  }

  /** Values go to the Keychain; an empty string removes one. Never returned. */
  @Put('plugins/:id/credentials')
  async credentials(@Param('id') id: string, @Body() body: { values?: Record<string, string> }) {
    if (!body?.values || typeof body.values !== 'object') throw new BadRequestException('values is required');
    await this.plugins.setCredentials(id, body.values);
    return { credentialsSet: await this.plugins.credentialStatus(id) };
  }

  @Post('plugins/:id/test')
  async test(@Param('id') id: string) {
    try {
      return { ok: true, text: await this.plugins.test(id) };
    } catch (err: any) {
      return { ok: false, text: String(err?.message ?? err) };
    }
  }

  @Post('plugins/reload')
  reload() {
    this.plugins.reload();
    return this.list();
  }

  @Post('plugins/open-folder')
  openFolder() {
    execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [PLUGINS_DIR]);
    return { opened: PLUGINS_DIR };
  }

  /** Runs a source once without saving anything, so the inspector can show what it returns. */
  @Post('plugins/preview')
  async preview(@Body() body: { plugin?: string; source?: string; config?: Record<string, unknown>; workflowId?: string; nodeId?: string }) {
    if (!body?.plugin || !body.source) throw new BadRequestException('plugin and source are required');
    const log: string[] = [];
    const started = Date.now();
    // Use a copy of the node's state so a preview can't move its cursor.
    const state = body.workflowId && body.nodeId ? structuredClone(this.datasets.getState(`${body.workflowId}:${body.nodeId}`)) : {};
    try {
      const r = await this.plugins.runSource(body.plugin, body.source, body.config ?? {}, { log: (t) => log.push(t), state, signal: AbortSignal.timeout(120_000) });
      return { ok: true, count: r.items.length, items: r.items.slice(0, 8), points: r.points?.length ?? 0, note: r.note, log, ms: Date.now() - started };
    } catch (err: any) {
      return { ok: false, error: String(err?.response?.message ?? err?.message ?? err), log, ms: Date.now() - started };
    }
  }

  @Get('plugins/tools')
  tools() {
    return this.plugins.tools();
  }
}
