import { Body, Controller, Get, MessageEvent, NotFoundException, Param, Post, Query, Sse } from '@nestjs/common';
import { filter, interval, map, merge, Observable } from 'rxjs';
import { HumanResponse } from '../common/types';
import { EventBus } from './event-bus';
import { ExecutorService } from './executor.service';
import { InboxService } from './inbox.service';
import { RunsStore } from './runs.store';

@Controller('api')
export class RunsController {
  constructor(
    private readonly store: RunsStore,
    private readonly executor: ExecutorService,
    private readonly bus: EventBus,
    private readonly inbox: InboxService,
  ) {}

  @Get('runs')
  list(@Query('workflowId') workflowId?: string, @Query('limit') limit?: string) {
    return this.store.listRuns(workflowId, Math.min(Number(limit) || 50, 500));
  }

  @Get('runs/:id')
  get(@Param('id') id: string) {
    const r = this.store.getRun(id);
    if (!r) throw new NotFoundException('Run not found');
    return { ...r, requests: this.store.requestsForRun(id) };
  }

  /** Everything currently waiting on a person, across all workflows. */
  @Get('inbox')
  pending() {
    return this.inbox.list();
  }

  @Post('inbox/:id/respond')
  respond(@Param('id') id: string, @Body() body: HumanResponse) {
    return this.inbox.respond(id, { decision: body?.decision, text: body?.text });
  }

  @Post('runs/:id/cancel')
  cancel(@Param('id') id: string) {
    return { cancelled: this.executor.cancel(id) };
  }

  /** Live stream for the canvas. Optionally scoped to one workflow. */
  @Sse('events')
  events(@Query('workflowId') workflowId?: string): Observable<MessageEvent> {
    const events = this.bus.events$.pipe(
      filter((e) => {
        if (!workflowId || e.type === 'usage' || e.type === 'dataset') return true;
        if (e.type === 'run') return e.run.workflowId === workflowId;
        if (e.type === 'inbox') return e.request.workflowId === workflowId;
        return e.workflowId === workflowId;
      }),
      map((e) => ({ data: e }) as MessageEvent),
    );
    // Heartbeat keeps proxies and the browser from dropping an idle stream.
    const heartbeat = interval(25_000).pipe(map(() => ({ type: 'ping', data: {} }) as MessageEvent));
    return merge(events, heartbeat);
  }
}
