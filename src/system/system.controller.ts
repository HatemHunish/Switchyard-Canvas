import { BadRequestException, Body, Controller, Get, Post, Put, Query } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { loadSettings, saveSettings, Settings } from '../common/paths';
import { getSecret, setSecret } from '../common/secrets';
import { ActionsService } from '../actions/actions.service';
import { findChrome } from '../output/convert';
import { EventBus } from '../engine/event-bus';
import { ProcessQueue } from '../engine/queue';

const run = promisify(execFile);

export interface ClaudeStatus {
  installed: boolean;
  version?: string;
  loggedIn?: boolean;
  authMethod?: string;
  subscriptionType?: string;
  error?: string;
}

@Controller('api/system')
export class SystemController {
  private cache: { at: number; status: ClaudeStatus } | null = null;

  constructor(
    private readonly bus: EventBus,
    private readonly queue: ProcessQueue,
    private readonly actions: ActionsService,
  ) {}

  /** Is the Claude Code CLI installed and logged in? Uses `claude auth status`, which costs no tokens. */
  @Get('claude')
  async claude(@Query('refresh') refresh?: string): Promise<ClaudeStatus> {
    if (!refresh && this.cache && Date.now() - this.cache.at < 60_000) return this.cache.status;
    const bin = loadSettings().claudeBin;
    let status: ClaudeStatus;
    try {
      const { stdout: v } = await run(bin, ['--version'], { timeout: 15_000 });
      status = { installed: true, version: v.trim() };
      try {
        const { stdout } = await run(bin, ['auth', 'status'], { timeout: 15_000 });
        const auth = JSON.parse(stdout);
        // Only surface what the UI needs; the CLI also reports email/org.
        Object.assign(status, { loggedIn: !!auth.loggedIn, authMethod: auth.authMethod, subscriptionType: auth.subscriptionType });
      } catch (err: any) {
        Object.assign(status, { loggedIn: false, error: err.stdout?.toString() || err.message });
      }
    } catch (err: any) {
      status = { installed: false, error: err.code === 'ENOENT' ? `"${bin}" not found on PATH` : err.message };
    }
    this.cache = { at: Date.now(), status };
    return status;
  }

  @Get('usage')
  usage() {
    return { usage: this.bus.usage, queue: this.queue.stats };
  }

  @Get('settings')
  async settings() {
    const s = loadSettings();
    return { ...s, hasSmtpPassword: !!(await getSecret('smtp')), detectedChrome: findChrome(s.chromePath) };
  }

  /** Stored in the macOS Keychain (never in settings.json). */
  @Put('smtp-password')
  async smtpPassword(@Body() body: { password?: string }) {
    if (typeof body?.password !== 'string') throw new BadRequestException('password is required');
    await setSecret('smtp', body.password);
    return { saved: true };
  }

  @Post('test-email')
  async testEmail(@Body() body: { to?: string; via?: 'mail' | 'smtp' }) {
    const r = await this.actions.run(
      { action: 'email', via: body?.via ?? 'smtp', to: body?.to, subject: 'Agent Canvas test email', body: 'If you can read this, email actions work.', sendNow: true, attach: false },
      { text: '', files: [], ctx: {}, onEvent: () => undefined },
    );
    return { ok: true, summary: r.summary };
  }

  @Put('settings')
  updateSettings(@Body() body: Partial<Settings>): Settings {
    const next = { ...loadSettings() };
    if (body.concurrency !== undefined) {
      const c = Number(body.concurrency);
      if (!(c >= 1 && c <= 10)) throw new BadRequestException('concurrency must be 1–10');
      next.concurrency = Math.floor(c);
    }
    if (body.claudeBin !== undefined) {
      if (!String(body.claudeBin).trim()) throw new BadRequestException('claudeBin cannot be empty');
      next.claudeBin = String(body.claudeBin).trim();
    }
    if (body.desktopNotifications !== undefined) next.desktopNotifications = !!body.desktopNotifications;
    if (body.outputsDir !== undefined && String(body.outputsDir).trim()) next.outputsDir = String(body.outputsDir).trim();
    if (body.chromePath !== undefined) next.chromePath = String(body.chromePath).trim();
    if (body.publicUrl !== undefined) {
      const u = String(body.publicUrl).trim().replace(/\/+$/, '');
      if (u && !/^https?:\/\//.test(u)) throw new BadRequestException('Public URL must start with http:// or https://');
      next.publicUrl = u;
    }
    if (body.smtp !== undefined) {
      const m = body.smtp as Partial<Settings['smtp']>;
      next.smtp = {
        host: String(m.host ?? next.smtp.host).trim(),
        port: Number(m.port ?? next.smtp.port) || 587,
        secure: !!(m.secure ?? next.smtp.secure),
        user: String(m.user ?? next.smtp.user).trim(),
        from: String(m.from ?? next.smtp.from).trim(),
      };
    }
    if (body.rateLimitRetryMs !== undefined) next.rateLimitRetryMs = Math.max(0, Number(body.rateLimitRetryMs) || 0);
    saveSettings(next);
    this.queue.setLimit(next.concurrency);
    this.cache = null;
    return next;
  }
}
