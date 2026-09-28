import { Body, ConflictException, Controller, Headers, HttpCode, NotFoundException, Param, Post, Query, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { WorkflowsService } from '../workflows/workflows.service';
import { TriggersService } from './triggers.service';

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Inbound webhooks: POST /api/hooks/:workflowId/:nodeId?token=... with any JSON body. */
@Controller('api/hooks')
export class HooksController {
  constructor(
    private readonly workflows: WorkflowsService,
    private readonly triggers: TriggersService,
  ) {}

  @Post(':workflowId/:nodeId')
  @HttpCode(202)
  receive(
    @Param('workflowId') workflowId: string,
    @Param('nodeId') nodeId: string,
    @Query('token') queryToken: string | undefined,
    @Headers('x-agent-canvas-token') headerToken: string | undefined,
    @Body() body: unknown,
  ) {
    const wf = this.workflows.get(workflowId);
    const token = headerToken || queryToken || '';
    if (!safeEqual(token, wf.webhookToken)) throw new UnauthorizedException('Bad token');
    const node = wf.nodes.find((n) => n.id === nodeId && n.kind === 'trigger.webhook');
    if (!node) throw new NotFoundException('No webhook trigger with that id');
    if (!wf.enabled) throw new ConflictException('Workflow is disabled');
    const run = this.triggers.fire(workflowId, nodeId, body ?? null, { allowOverlap: true });
    return { runId: run?.id };
  }
}
