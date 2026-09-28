import { Body, Controller, Get, Header, Param, Post, Query } from '@nestjs/common';
import { HumanRequest, NotifyConfig } from '../common/types';
import { appBase, InboxService } from './inbox.service';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Minimal standalone page (light/dark, phone-friendly) so a notification link can be acted on without the canvas. */
function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Agent Canvas</title><style>
:root{--bg:#f7f6f3;--panel:#fff;--ink:#1b1f24;--muted:#5b6573;--line:#e3e1dc;--accent:#c4613f;--ok:#1a7f45;--bad:#c23b3b;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0b0f16;--panel:#111823;--ink:#e6ebf2;--muted:#8291a6;--line:#27334a;--accent:#d97757;--ok:#3fb97f;--bad:#ef5b5b;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px 16px}
main{max-width:640px;margin:0 auto;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:22px}
.kind{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--accent)}h1{font-size:20px;margin:4px 0 2px}
.meta{color:var(--muted);font-size:13px;margin-bottom:14px}.instr{color:var(--muted);margin:0 0 10px}
pre{white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:12px;font:13px/1.5 ui-monospace,Menlo,monospace;max-height:50vh;overflow:auto;margin:0 0 14px}
textarea{width:100%;min-height:90px;border:1px solid var(--line);border-radius:9px;padding:10px;font:inherit;background:var(--panel);color:var(--ink)}
.row{display:flex;gap:10px;justify-content:flex-end;margin-top:12px;flex-wrap:wrap}
button{font:inherit;font-weight:600;border-radius:9px;padding:10px 18px;border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer}
.primary{background:var(--accent);border-color:var(--accent);color:#fff}.danger{color:var(--bad)}
.done{font-size:17px}.ok{color:var(--ok)}a{color:var(--accent)}
</style></head><body><main>${body}</main></body></html>`;
}

function reviewForm(r: HumanRequest, token: string) {
  const review = r.kind === 'review';
  return page(
    r.title,
    `<div class="kind">${review ? 'Review' : 'Question'}</div>
<h1 dir="auto">${esc(review ? r.title : `${r.nodeName} asks`)}</h1>
<div class="meta">${esc(r.workflowName)}${r.round > 1 ? ` · round ${r.round}` : ''} · waiting since ${new Date(r.createdAt).toLocaleString()}</div>
${review && r.instructions ? `<p class="instr" dir="auto">${esc(r.instructions)}</p>` : ''}
<pre dir="auto">${esc(r.body)}</pre>
<form method="post" action="/r/${r.id}">
<input type="hidden" name="t" value="${esc(token)}">
<textarea name="text" dir="auto" placeholder="${review ? (r.reviseTo ? `Feedback for ${esc(r.reviseTo)} (used when you send it back)` : 'Comment (optional)') : 'Your answer'}" ${review ? '' : 'required'}></textarea>
<div class="row">${
      review
        ? `<button name="decision" value="reject" class="danger">${r.reviseTo ? `↩ Send back to ${esc(r.reviseTo)}` : 'Reject'}</button><button name="decision" value="approve" class="primary">Approve</button>`
        : `<button name="decision" value="answer" class="primary">Send answer</button>`
    }</div>
</form>
<p class="meta" style="margin-top:16px"><a href="${esc(appBase())}/?review=${r.id}">Open in Agent Canvas</a></p>`,
  );
}

const gone = () =>
  page('Already handled', `<h1>Nothing to do here</h1><p class="meta">This request was already answered, cancelled or has expired, or the link is not valid.</p><p><a href="${esc(appBase())}/">Open Agent Canvas</a></p>`);

@Controller()
export class ReviewPageController {
  constructor(private readonly inbox: InboxService) {}

  /** GET only shows the form, so link previews in mail/chat apps can't approve anything. */
  @Get('r/:id')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  show(@Param('id') id: string, @Query('t') token = '') {
    const r = this.inbox.byToken(id, token);
    return r ? reviewForm(r, token) : gone();
  }

  @Post('r/:id')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  submit(@Param('id') id: string, @Body() body: { t?: string; decision?: string; text?: string }) {
    const r = this.inbox.byToken(id, body?.t ?? '');
    if (!r) return gone();
    try {
      const text = body.text?.trim() || undefined;
      if (r.kind === 'review') this.inbox.respond(id, { decision: body.decision === 'approve' ? 'approve' : 'reject', text });
      else this.inbox.respond(id, { text });
    } catch (err: any) {
      return page('Could not send', `<h1>Could not send</h1><p class="meta">${esc(err.message)}</p>`);
    }
    const what = r.kind !== 'review' ? 'Answer sent. The agent is continuing.' : body.decision === 'approve' ? 'Approved. The workflow continues.' : r.reviseTo ? `Sent back to ${r.reviseTo}. You’ll get the revised version to review.` : 'Rejected.';
    return page('Done', `<p class="done ok">✓ ${esc(what)}</p><p class="meta">${esc(r.workflowName)}</p><p><a href="${esc(appBase())}/">Open Agent Canvas</a></p>`);
  }
}

/** "Send test" from the node settings: delivers a sample message on the chosen channels. */
@Controller('api/inbox')
export class NotifyTestController {
  constructor(private readonly inbox: InboxService) {}

  @Post('test-notify')
  async test(@Body() body: { notify?: NotifyConfig; kind?: 'review' | 'question' }) {
    const results: Array<{ text: string; ok: boolean }> = [];
    const sample: HumanRequest = {
      id: 'test',
      runId: 'test',
      workflowId: 'test',
      workflowName: 'Test workflow',
      nodeId: 'test',
      nodeName: 'test-agent',
      kind: body?.kind ?? 'review',
      title: 'Test notification',
      body: 'This is a test message from Agent Canvas. Real messages include the content to review and working links.',
      round: 1,
      status: 'pending',
      createdAt: Date.now(),
    };
    await this.inbox.deliver({ req: sample, token: 'test' }, { channels: body?.notify?.channels ?? [] }, false, (text, ok) => results.push({ text, ok }));
    return { results };
  }
}
