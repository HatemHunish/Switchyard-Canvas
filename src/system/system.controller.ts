import { BadRequestException, Body, Controller, Get, Post, Put, Query } from '@nestjs/common';
import { ChildProcess, execFile, spawn } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { promisify } from 'util';
import { childPath, loadSettings, resolveClaude, saveSettings, Settings, WORKSPACE_DIR } from '../common/paths';
import { getSecret, setSecret } from '../common/secrets';
import { ActionsService } from '../actions/actions.service';
import { findChrome } from '../output/convert';
import { EventBus } from '../engine/event-bus';
import { ProcessQueue } from '../engine/queue';

const run = promisify(execFile);

const LOGIN_LABEL = 'com.agentcanvas.app';
const loginPlist = () => join(homedir(), 'Library', 'LaunchAgents', `${LOGIN_LABEL}.plist`);
/** When running from Agent Canvas.app, the bundled launcher next to our Node binary. */
function appLauncher(): string | null {
  if (!process.execPath.endsWith('/Contents/Resources/node')) return null;
  const launcher = resolve(dirname(process.execPath), '..', 'MacOS', 'Agent Canvas');
  return existsSync(launcher) ? launcher : null;
}
/** The Codex CLI that ships with @openai/codex-sdk (run through our own Node). */
const codexCli = () => require.resolve('@openai/codex/bin/codex.js');
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface ClaudeStatus {
  installed: boolean;
  version?: string;
  loggedIn?: boolean;
  authMethod?: string;
  subscriptionType?: string;
  error?: string;
}

export interface CodexStatus {
  installed: boolean;
  version?: string;
  loggedIn?: boolean;
  /** e.g. "Logged in using ChatGPT". */
  detail?: string;
  error?: string;
}

@Controller('api/system')
export class SystemController {
  private cache: { at: number; status: ClaudeStatus } | null = null;
  /** The Claude Code installer or login started from the setup screen. */
  private codexCache: { at: number; status: CodexStatus } | null = null;
  private job: { kind: 'install' | 'login' | 'codex-login'; child: ChildProcess; log: string[]; exitCode: number | null; startedAt: number } | null = null;

  constructor(
    private readonly bus: EventBus,
    private readonly queue: ProcessQueue,
    private readonly actions: ActionsService,
  ) {}

  /** Is the Claude Code CLI installed and logged in? Uses `claude auth status`, which costs no tokens. */
  @Get('claude')
  async claude(@Query('refresh') refresh?: string): Promise<ClaudeStatus> {
    if (!refresh && this.cache && Date.now() - this.cache.at < 60_000) return this.cache.status;
    const bin = resolveClaude(loadSettings().claudeBin);
    let status: ClaudeStatus;
    try {
      const { stdout: v } = await run(bin, ['--version'], { timeout: 15_000, env: { ...process.env, PATH: childPath() } });
      status = { installed: true, version: v.trim() };
      try {
        const { stdout } = await run(bin, ['auth', 'status'], { timeout: 15_000, env: { ...process.env, PATH: childPath() } });
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

  /** Runs a setup step in the background; the setup screen polls /job for its output. */
  private startJob(kind: 'install' | 'login' | 'codex-login', cmd: string, args: string[]) {
    if (this.job && this.job.exitCode === null) throw new BadRequestException(`Already running: ${this.job.kind}`);
    const child = spawn(cmd, args, { env: { ...process.env, PATH: childPath() }, stdio: ['ignore', 'pipe', 'pipe'] });
    const job = { kind, child, log: [] as string[], exitCode: null as number | null, startedAt: Date.now() };
    const add = (b: Buffer) => {
      // Strip terminal colours/cursor codes from installer output.
      for (const line of b.toString().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n|\r/)) if (line.trim()) job.log.push(line.trim());
      if (job.log.length > 300) job.log.splice(0, job.log.length - 300);
    };
    child.stdout?.on('data', add);
    child.stderr?.on('data', add);
    child.on('error', (err) => (job.log.push(err.message), (job.exitCode = -1)));
    child.on('exit', (code) => {
      job.exitCode = code ?? -1;
      this.cache = null;
      this.codexCache = null;
    });
    // A login left open in the browser shouldn't hang around forever.
    setTimeout(() => job.exitCode === null && child.kill(), 15 * 60_000).unref();
    this.job = job;
    return { started: true };
  }

  /** Installs Claude Code with Anthropic's official installer (the user clicks Install on the setup screen). */
  @Post('claude/install')
  install() {
    return this.startJob('install', '/bin/bash', ['-c', 'curl -fsSL https://claude.ai/install.sh | bash']);
  }

  /** Opens the browser to sign in to the user's Claude plan (the CLI handles it; this app never sees credentials). */
  @Post('claude/login')
  login(@Body() body: { email?: string }) {
    const email = String(body?.email ?? '').trim();
    return this.startJob('login', resolveClaude(loadSettings().claudeBin), ['auth', 'login', '--claudeai', ...(/^[^\s@]+@[^\s@]+$/.test(email) ? ['--email', email] : [])]);
  }

  /** Is Codex (bundled with the app) logged in? `codex login status` costs no tokens. */
  @Get('codex')
  async codex(@Query('refresh') refresh?: string): Promise<CodexStatus> {
    if (!refresh && this.codexCache && Date.now() - this.codexCache.at < 60_000) return this.codexCache.status;
    const env = { ...process.env, PATH: childPath() };
    let status: CodexStatus;
    try {
      const cli = codexCli();
      const { stdout: v } = await run(process.execPath, [cli, '--version'], { timeout: 15_000, env });
      status = { installed: true, version: v.trim() };
      try {
        const { stdout, stderr } = await run(process.execPath, [cli, 'login', 'status'], { timeout: 15_000, env });
        Object.assign(status, { loggedIn: true, detail: (stdout || stderr).trim() });
      } catch (err: any) {
        Object.assign(status, { loggedIn: false, detail: (err.stdout || err.stderr || '').toString().trim() || 'Not logged in' });
      }
    } catch (err: any) {
      status = { installed: false, error: err.message };
    }
    this.codexCache = { at: Date.now(), status };
    return status;
  }

  /** Opens the browser to sign in to ChatGPT for Codex (Codex stores the login; this app never sees it). */
  @Post('codex/login')
  codexLogin() {
    return this.startJob('codex-login', process.execPath, [codexCli(), 'login']);
  }

  @Get('claude/job')
  jobStatus() {
    if (!this.job) return { kind: null };
    const { kind, log, exitCode, startedAt } = this.job;
    return { kind, log: log.slice(-40), running: exitCode === null, exitCode, startedAt };
  }

  @Post('claude/job/cancel')
  cancelJob() {
    if (this.job?.exitCode === null) this.job.child.kill();
    return { cancelled: true };
  }

  /** Native "choose folder" dialog on this Mac, so nobody has to type paths. */
  @Post('choose-folder')
  async chooseFolder(@Body() body: { prompt?: string }) {
    if (process.platform !== 'darwin') throw new BadRequestException('Folder picker is only available on macOS; type the path instead.');
    const prompt = String(body?.prompt || 'Choose a folder').replace(/["\\]/g, '');
    try {
      const { stdout } = await run('osascript', ['-e', 'activate', '-e', `set f to choose folder with prompt "${prompt}"`, '-e', 'POSIX path of f'], { timeout: 10 * 60_000 });
      return { path: stdout.trim().replace(/\/$/, '') || null };
    } catch {
      return { path: null }; // cancelled
    }
  }

  /** Is this the packaged Mac app, and does it start at login? */
  @Get('app')
  appInfo() {
    const launcher = appLauncher();
    return { bundled: !!launcher, loginItem: existsSync(loginPlist()) };
  }

  /** "Start Agent Canvas when I log in": a per-user LaunchAgent that runs the launcher in the background. */
  @Put('login-item')
  async loginItem(@Body() body: { enabled?: boolean }) {
    const launcher = appLauncher();
    if (!launcher) throw new BadRequestException('Only available in the Agent Canvas app (npm run package:mac).');
    const plist = loginPlist();
    if (body?.enabled) {
      mkdirSync(dirname(plist), { recursive: true });
      writeFileSync(
        plist,
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LOGIN_LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(launcher)}</string><string>--background</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
`,
      );
    } else {
      await run('launchctl', ['bootout', `gui/${process.getuid?.() ?? ''}/${LOGIN_LABEL}`]).catch(() => undefined);
      rmSync(plist, { force: true });
    }
    return { loginItem: existsSync(plist) };
  }

  /** Stops the app (used by the Mac app's "Quit" in Settings). */
  @Post('quit')
  quit() {
    setTimeout(() => process.exit(0), 300);
    return { quitting: true };
  }

  @Get('usage')
  usage() {
    return { usage: this.bus.usage, queue: this.queue.stats };
  }

  @Get('settings')
  async settings() {
    const s = loadSettings();
    return { ...s, hasSmtpPassword: !!(await getSecret('smtp')), detectedChrome: findChrome(s.chromePath), workspaceDir: WORKSPACE_DIR };
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
    if (body.uiMode !== undefined) next.uiMode = body.uiMode === 'advanced' ? 'advanced' : 'simple';
    if (body.setupDone !== undefined) next.setupDone = !!body.setupDone;
    if (body.userEmail !== undefined) {
      const e = String(body.userEmail).trim();
      if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new BadRequestException('That email address doesn’t look right.');
      next.userEmail = e;
    }
    if (body.rateLimitRetryMs !== undefined) next.rateLimitRetryMs = Math.max(0, Number(body.rateLimitRetryMs) || 0);
    if (body.rateLimitRetries !== undefined) next.rateLimitRetries = Math.min(10, Math.max(0, Math.floor(Number(body.rateLimitRetries) || 0)));
    if (body.rateLimitMaxWaitMs !== undefined) next.rateLimitMaxWaitMs = Math.max(0, Number(body.rateLimitMaxWaitMs) || 0);
    if (body.maxTurns !== undefined) next.maxTurns = Math.max(1, Math.floor(Number(body.maxTurns) || 1));
    if (body.maxBudgetUsd !== undefined) next.maxBudgetUsd = Math.max(0, Number(body.maxBudgetUsd) || 0);
    saveSettings(next);
    this.queue.setLimit(next.concurrency);
    this.cache = null;
    return next;
  }
}
