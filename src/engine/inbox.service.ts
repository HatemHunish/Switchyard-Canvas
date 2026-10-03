import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { execFile } from 'child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { loadSettings } from '../common/paths';
import { runtime } from '../common/runtime';
import { HumanRequest, HumanResponse, NotifyChannel, NotifyConfig } from '../common/types';
import { ActionsService } from '../actions/actions.service';
import { EventBus } from './event-bus';
import { RunsStore } from './runs.store';

export class RequestClosedError extends Error {}

interface Pending {
  req: HumanRequest;
  resolve: (r: HumanResponse) => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
  reminder?: NodeJS.Timeout;
  /** Secret for the "Review now" link; never sent to the UI or the event stream. */
  token: string;
}

export interface AskOptions {
  signal: AbortSignal;
  timeoutMinutes?: number;
  notify?: NotifyConfig;
  /** Delivery results, shown in the step's activity. */
  onNotify?: (text: string, ok: boolean) => void;
}

/** Base for links in notifications: Settings → public URL, else this machine. */
export const appBase = () => (loadSettings().publicUrl?.trim() || runtime.apiBase).replace(/\/+$/, '');

/**
 * Requests for a human: reviews/approvals and questions from agents.
 * A run waiting here holds no agent process and no queue slot. Waiting is
 * in memory, so restarting the app cancels runs that are waiting.
 */
@Injectable()
export class InboxService {
  private readonly logger = new Logger(InboxService.name);
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly store: RunsStore,
    private readonly bus: EventBus,
    private readonly actions: ActionsService,
  ) {}

  list(): HumanRequest[] {
    return [...this.pending.values()].map((p) => p.req).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Resolves with the person's response; rejects if the run is cancelled or the request expires. */
  ask(
    input: Omit<HumanRequest, 'id' | 'status' | 'createdAt' | 'expiresAt'>,
    opts: AskOptions,
  ): Promise<HumanResponse> {
    const now = Date.now();
    const timeoutMs = opts.timeoutMinutes && opts.timeoutMinutes > 0 ? opts.timeoutMinutes * 60_000 : undefined;
    const req: HumanRequest = { ...input, id: randomUUID(), status: 'pending', createdAt: now, expiresAt: timeoutMs ? now + timeoutMs : undefined };

    return new Promise<HumanResponse>((resolve, reject) => {
      const p: Pending = { req, resolve, reject, token: randomBytes(18).toString('base64url') };
      const close = (status: HumanRequest['status']) => {
        clearTimeout(p.timer);
        clearInterval(p.reminder);
        opts.signal.removeEventListener('abort', onAbort);
        this.pending.delete(req.id);
        req.status = status;
        this.save(req);
      };
      const onAbort = () => {
        close('cancelled');
        reject(new RequestClosedError('Run cancelled while waiting for a response'));
      };
      if (opts.signal.aborted) return onAbort();
      opts.signal.addEventListener('abort', onAbort, { once: true });
      if (timeoutMs) {
        p.timer = setTimeout(() => {
          close('expired');
          resolve({ decision: 'reject', text: `No response within ${opts.timeoutMinutes} minutes.`, timedOut: true });
        }, timeoutMs);
      }
      p.resolve = (r) => {
        close('answered');
        resolve(r);
      };
      this.pending.set(req.id, p);
      this.save(req);
      this.notify(req);
      if (opts.notify?.channels?.length) {
        void this.deliver(p, opts.notify, false, opts.onNotify);
        const every = Number(opts.notify.remindEveryMinutes) || 0;
        const times = Math.max(0, Number(opts.notify.remindTimes) || 0);
        if (every > 0 && times > 0) {
          let sent = 0;
          p.reminder = setInterval(() => {
            if (!this.pending.has(req.id) || ++sent > times) return clearInterval(p.reminder);
            void this.deliver(p, opts.notify!, true, opts.onNotify);
          }, every * 60_000);
        }
      }
    });
  }

  respond(id: string, response: HumanResponse): HumanRequest {
    const p = this.pending.get(id);
    if (!p) throw new NotFoundException('This request is no longer waiting (answered, cancelled or expired).');
    const text = typeof response?.text === 'string' ? response.text.slice(0, 20_000) : undefined;
    if (p.req.kind === 'review') {
      if (response?.decision !== 'approve' && response?.decision !== 'reject') throw new BadRequestException('decision must be approve or reject');
    } else if (!text?.trim()) {
      throw new BadRequestException('An answer is required');
    }
    p.req.answeredAt = Date.now();
    p.req.response = { decision: response.decision, text };
    p.resolve(p.req.response);
    return p.req;
  }

  /** The pending request behind a "Review now" link, if the link's secret matches. */
  byToken(id: string, token: string): HumanRequest | null {
    const p = this.pending.get(id);
    if (!p || !token) return null;
    const a = Buffer.from(token);
    const b = Buffer.from(p.token);
    return a.length === b.length && timingSafeEqual(a, b) ? p.req : null;
  }

  /** Sends the "waiting for you" message on every configured channel; failures are reported, never fatal. */
  async deliver(p: Pending | { req: HumanRequest; token: string }, cfg: NotifyConfig, reminder: boolean, onNotify?: (text: string, ok: boolean) => void) {
    const { req, token } = p;
    const base = appBase();
    const openUrl = `${base}/?review=${req.id}`;
    const quickUrl = `${base}/r/${req.id}?t=${token}`;
    const what = req.kind === 'review' ? `Review needed: ${req.title}` : `${req.nodeName} has a question`;
    const subject = `${reminder ? 'Reminder: ' : ''}${what} (${req.workflowName})`;
    const preview = req.body.length > 1500 ? `${req.body.slice(0, 1500)}…` : req.body;
    const lines = [
      `${reminder ? 'Still waiting: ' : ''}${what}`,
      `Workflow: ${req.workflowName}${req.round > 1 ? ` · round ${req.round}` : ''}`,
      req.instructions ? `\n${req.instructions}` : '',
      `\n${req.kind === 'review' ? 'To review' : 'Question'}:\n${preview}`,
      `\nReview now: ${quickUrl}`,
      `Open in Agent Canvas: ${openUrl}`,
    ].filter(Boolean);
    const text = lines.join('\n');
    const input = { text, files: [], ctx: {}, onEvent: () => undefined };
    for (const ch of cfg.channels) {
      const label = channelLabel(ch);
      try {
        if (ch.type === 'desktop') await this.actions.run({ action: 'notify', title: subject, message: req.kind === 'review' ? req.workflowName : req.body.slice(0, 200) }, input);
        else if (ch.type === 'email') await this.actions.run({ action: 'email', via: ch.via ?? 'mail', to: ch.to, subject, body: text, sendNow: true, attach: false }, input);
        else {
          const chatText = `*${reminder ? 'Reminder: ' : ''}${what}*\n${req.workflowName}${req.round > 1 ? ` · round ${req.round}` : ''}\n\n${preview.slice(0, 600)}\n\n<${quickUrl}|Review now> · <${openUrl}|Open in Agent Canvas>`;
          const message = ch.type === 'slack' ? chatText : ch.type === 'teams' ? `**${what}** (${req.workflowName})\n\n${preview.slice(0, 600)}\n\n[Review now](${quickUrl}) · [Open in Agent Canvas](${openUrl})` : undefined;
          await this.actions.run(
            ch.type === 'webhook'
              ? { action: 'http', preset: 'custom', url: ch.url, bodyTemplate: JSON.stringify({ event: reminder ? 'reminder' : 'waiting', request: { ...req }, reviewUrl: quickUrl, openUrl }) }
              : { action: 'http', preset: ch.type, url: ch.url, message },
            input,
          );
        }
        onNotify?.(`${reminder ? 'Reminder sent' : 'Notified'} via ${label}`, true);
      } catch (err: any) {
        this.logger.warn(`Notify via ${label} failed: ${err.message}`);
        onNotify?.(`Could not notify via ${label}: ${err.message}`, false);
      }
    }
  }

  private save(req: HumanRequest) {
    this.store.upsertRequest(req);
    this.bus.emit({ type: 'inbox', request: { ...req } });
  }

  /** Desktop notification (macOS) so a waiting run isn't missed when the tab is in the background. */
  private notify(req: HumanRequest) {
    if (process.platform !== 'darwin' || !loadSettings().desktopNotifications) return;
    const title = req.kind === 'review' ? `Review needed: ${req.title}` : `${req.nodeName} has a question`;
    const body = req.kind === 'review' ? req.workflowName : req.body.slice(0, 200);
    // Values go in as argv, never interpolated into the script.
    execFile(
      'osascript',
      ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"', '-e', 'end run', title, body],
      (err) => err && this.logger.debug(`Notification failed: ${err.message}`),
    );
  }
}

function channelLabel(ch: NotifyChannel) {
  if (ch.type === 'email') return `email to ${ch.to || '(no recipient)'}`;
  if (ch.type === 'desktop') return 'desktop notification';
  try {
    return `${ch.type} (${new URL(ch.url ?? '').host})`;
  } catch {
    return ch.type;
  }
}
