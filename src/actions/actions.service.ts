import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'fs';
import { basename, extname, join } from 'path';
import { promisify } from 'util';
import { expandHome, loadSettings } from '../common/paths';
import { getSecret } from '../common/secrets';
import { ActionData, NodeEvent, OutputFile } from '../common/types';
import { renderTemplate } from '../engine/template';

const run = promisify(execFile);

export interface ActionInput {
  text: string;
  structured?: unknown;
  files: OutputFile[];
  ctx: Record<string, unknown>;
  onEvent: (e: NodeEvent) => void;
}

export interface ActionResult {
  summary: string;
  /** Files this action wrote (save), added to what flows downstream. */
  files?: Array<Omit<OutputFile, 'id'>>;
  details?: unknown;
}

/** Filesystem-safe name from a rendered template. */
export const safeName = (s: string) =>
  s
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150) || 'output';

/** Picks a free path: name.ext, name-2.ext, … unless overwriting. */
export function freePath(dir: string, file: string, overwrite = false) {
  let p = join(dir, file);
  if (overwrite) return p;
  const ext = extname(file);
  const stem = file.slice(0, file.length - ext.length);
  for (let i = 2; existsSync(p); i++) p = join(dir, `${stem}-${i}${ext}`);
  return p;
}

/** The "next action" steps: save, email, post to a webhook, notify, open. */
@Injectable()
export class ActionsService {
  private readonly logger = new Logger(ActionsService.name);

  async run(d: ActionData, input: ActionInput): Promise<ActionResult> {
    const t = (s?: string) => renderTemplate(s ?? '', input.ctx);
    switch (d.action) {
      case 'save':
        return this.save(d, input, t);
      case 'email':
        return d.via === 'smtp' ? this.smtp(d, input, t) : this.mailApp(d, input, t);
      case 'http':
        return this.http(d, input, t);
      case 'notify':
        return this.notify(t(d.title) || 'Agent Canvas', t(d.message) || input.text.slice(0, 200));
      case 'open':
        return this.open(input);
      default:
        throw new Error(`Unknown action ${(d as any).action}`);
    }
  }

  private save(d: ActionData, input: ActionInput, t: (s?: string) => string): ActionResult {
    const dir = expandHome(t(d.folder).trim());
    if (!dir) throw new Error('Choose a folder to save to');
    mkdirSync(dir, { recursive: true });
    const what = d.what ?? 'files';
    const saved: Array<Omit<OutputFile, 'id'>> = [];
    const rename = d.fileName?.trim() ? safeName(t(d.fileName)) : '';
    if (what !== 'text') {
      input.files.forEach((f, i) => {
        const name = rename ? `${rename}${input.files.length > 1 ? `-${i + 1}` : ''}${extname(f.name)}` : f.name;
        const dest = freePath(dir, name, d.overwrite);
        copyFileSync(f.path, dest);
        saved.push({ path: dest, name: basename(dest), format: f.format, bytes: statSync(dest).size });
      });
    }
    if (what !== 'files' || !input.files.length) {
      const dest = freePath(dir, `${rename || safeName(String((input.ctx.workflow as any)?.name ?? 'output'))}.md`, d.overwrite);
      writeFileSync(dest, input.text + '\n');
      saved.push({ path: dest, name: basename(dest), format: 'md', bytes: statSync(dest).size });
    }
    return { summary: `Saved ${saved.length} file${saved.length === 1 ? '' : 's'} to ${dir}`, files: saved, details: saved.map((s) => s.path) };
  }

  /** macOS Mail.app via AppleScript: uses your configured mail accounts, no passwords here. */
  private async mailApp(d: ActionData, input: ActionInput, t: (s?: string) => string): Promise<ActionResult> {
    if (process.platform !== 'darwin') throw new Error('Mail.app is only available on macOS. Use SMTP instead.');
    const to = splitAddrs(t(d.to));
    if (!to.length) throw new Error('Add at least one recipient');
    const cc = splitAddrs(t(d.cc));
    const subject = t(d.subject) || 'Agent Canvas result';
    const body = t(d.body) || input.text;
    const attachments = d.attach !== false ? input.files.map((f) => f.path) : [];
    // All values are passed as argv, never spliced into the script.
    const script = [
      'on run argv',
      '  set theSubject to item 1 of argv',
      '  set theBody to item 2 of argv',
      '  set sendNow to (item 3 of argv) is "1"',
      '  set toCount to (item 4 of argv) as integer',
      '  set ccCount to (item 5 of argv) as integer',
      '  tell application "Mail"',
      '    set msg to make new outgoing message with properties {subject:theSubject, content:theBody & return & return, visible:(not sendNow)}',
      '    tell msg',
      '      repeat with i from 1 to toCount',
      '        make new to recipient at end of to recipients with properties {address:(item (5 + i) of argv)}',
      '      end repeat',
      '      repeat with i from 1 to ccCount',
      '        make new cc recipient at end of cc recipients with properties {address:(item (5 + toCount + i) of argv)}',
      '      end repeat',
      '      repeat with i from (6 + toCount + ccCount) to (count of argv)',
      '        tell content to make new attachment with properties {file name:(POSIX file (item i of argv))} at after last paragraph',
      '      end repeat',
      '    end tell',
      '    if sendNow then',
      '      delay 1',
      '      send msg',
      '    else',
      '      activate',
      '    end if',
      '  end tell',
      'end run',
    ];
    const args = script.flatMap((l) => ['-e', l]);
    await run('osascript', [...args, subject, body, d.sendNow ? '1' : '0', String(to.length), String(cc.length), ...to, ...cc, ...attachments], { timeout: 60_000 });
    const verb = d.sendNow ? 'Sent' : 'Drafted (open in Mail, ready to send)';
    return { summary: `${verb}: "${subject}" to ${to.join(', ')}${attachments.length ? ` with ${attachments.length} attachment(s)` : ''}`, details: { to, cc, subject, attachments } };
  }

  private async smtp(d: ActionData, input: ActionInput, t: (s?: string) => string): Promise<ActionResult> {
    const cfg = loadSettings().smtp;
    if (!cfg?.host) throw new Error('Set up SMTP in Settings first');
    const to = splitAddrs(t(d.to));
    if (!to.length) throw new Error('Add at least one recipient');
    const nodemailer = require('nodemailer');
    const pass = cfg.user ? await getSecret('smtp') : null;
    const transport = nodemailer.createTransport({ host: cfg.host, port: cfg.port || 587, secure: !!cfg.secure, auth: cfg.user ? { user: cfg.user, pass: pass ?? '' } : undefined });
    const subject = t(d.subject) || 'Agent Canvas result';
    const info = await transport.sendMail({
      from: cfg.from || cfg.user,
      to,
      cc: splitAddrs(t(d.cc)),
      subject,
      text: t(d.body) || input.text,
      attachments: d.attach !== false ? input.files.map((f) => ({ filename: f.name, path: f.path })) : [],
    });
    return { summary: `Sent "${subject}" to ${to.join(', ')} via ${cfg.host}`, details: { messageId: info.messageId, accepted: info.accepted } };
  }

  private async http(d: ActionData, input: ActionInput, t: (s?: string) => string): Promise<ActionResult> {
    const url = t(d.url).trim();
    if (!/^https?:\/\//.test(url)) throw new Error('Enter an http(s) URL');
    const files = input.files.map((f) => ({ name: f.name, path: f.path, format: f.format, bytes: f.bytes }));
    const fileLine = files.length ? `\n\nFiles: ${files.map((f) => f.name).join(', ')}` : '';
    let body: string;
    switch (d.preset ?? 'json') {
      case 'slack':
      case 'teams':
        // A custom message decides for itself whether to mention {{files}}.
        body = JSON.stringify({ text: d.message?.trim() ? t(d.message).slice(0, 35_000) : input.text.slice(0, 35_000) + fileLine });
        break;
      case 'custom':
        body = t(d.bodyTemplate);
        break;
      default:
        body = JSON.stringify({ workflow: input.ctx.workflow, runId: input.ctx.runId, text: input.text, structured: input.structured, files });
    }
    let headers: Record<string, string> = { 'content-type': 'application/json' };
    if (d.headers?.trim()) {
      try {
        headers = { ...headers, ...JSON.parse(t(d.headers)) };
      } catch {
        throw new Error('Headers must be a JSON object, e.g. {"Authorization": "Bearer …"}');
      }
    }
    const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(30_000) });
    const reply = (await res.text()).slice(0, 2000);
    if (!res.ok) throw new Error(`${url} answered ${res.status}: ${reply}`);
    return { summary: `Posted to ${new URL(url).host} (${res.status})`, details: { status: res.status, reply } };
  }

  private async notify(title: string, message: string): Promise<ActionResult> {
    if (process.platform !== 'darwin') return { summary: `Notification (not shown outside macOS): ${title}` };
    await run('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"', '-e', 'end run', title, message.slice(0, 250)]);
    return { summary: `Notified: ${title}` };
  }

  private async open(input: ActionInput): Promise<ActionResult> {
    if (!input.files.length) throw new Error('Nothing to open: connect this after an Output node');
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    for (const f of input.files) await run(opener, [f.path]);
    return { summary: `Opened ${input.files.map((f) => f.name).join(', ')}` };
  }
}

const splitAddrs = (s: string) =>
  s
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter((x) => /^[^@\s]+@[^@\s]+$/.test(x));
