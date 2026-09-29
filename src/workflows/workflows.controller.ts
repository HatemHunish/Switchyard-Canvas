import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Post, Put } from '@nestjs/common';
import { Workflow } from '../common/types';
import { ExecutorService } from '../engine/executor.service';
import { RunsStore } from '../engine/runs.store';
import { ExportService } from '../export/export.service';
import { MemoryService, storeIdFor } from '../memory/memory.service';
import { PluginsService } from '../plugins/plugins.service';
import { TEMPLATES } from '../templates/templates';
import { TriggersService } from '../triggers/triggers.service';
import { validateWorkflow } from './validate';
import { WorkflowsService } from './workflows.service';

/** Only these fields are client-editable; ids, tokens and timestamps are server-owned. */
function editable(body: any): Partial<Workflow> {
  const out: Partial<Workflow> = {};
  if (body?.name !== undefined) out.name = String(body.name).slice(0, 200) || 'Untitled workflow';
  if (body?.description !== undefined) out.description = String(body.description).slice(0, 2000);
  if (body?.enabled !== undefined) out.enabled = !!body.enabled;
  if (body?.nodes !== undefined) {
    if (!Array.isArray(body.nodes)) throw new BadRequestException('nodes must be an array');
    out.nodes = body.nodes;
  }
  if (body?.edges !== undefined) {
    if (!Array.isArray(body.edges)) throw new BadRequestException('edges must be an array');
    out.edges = body.edges;
  }
  return out;
}

@Controller('api')
export class WorkflowsController {
  constructor(
    private readonly workflows: WorkflowsService,
    private readonly executor: ExecutorService,
    private readonly triggers: TriggersService,
    private readonly store: RunsStore,
    private readonly exporter: ExportService,
    private readonly memory: MemoryService,
    private readonly plugins: PluginsService,
  ) {}

  private view(wf: Workflow) {
    return { ...wf, issues: validateWorkflow(wf), triggers: this.triggers.status(wf.id) };
  }

  @Get('workflows')
  list() {
    return this.workflows.list().map((wf) => this.view(wf));
  }

  @Get('workflows/:id')
  get(@Param('id') id: string) {
    return this.view(this.workflows.get(id));
  }

  /** Create a blank workflow, or import one (body = exported workflow JSON). */
  @Post('workflows')
  create(@Body() body: any) {
    return this.view(this.workflows.create(editable({ ...body, enabled: undefined })));
  }

  @Put('workflows/:id')
  update(@Param('id') id: string, @Body() body: any) {
    const patch = editable(body);
    if (patch.enabled) {
      const issues = validateWorkflow({ ...this.workflows.get(id), ...patch });
      if (issues.length) throw new BadRequestException({ message: 'Fix these issues before enabling', issues });
    }
    return this.view(this.workflows.update(id, patch));
  }

  @Delete('workflows/:id')
  remove(@Param('id') id: string) {
    const wf = this.workflows.get(id);
    // Private memory goes with the workflow; shared stores outlive it.
    for (const n of wf.nodes) if (n.kind === 'memory' && n.data?.scope !== 'shared') this.memory.clear(storeIdFor(wf.id, n));
    this.workflows.delete(id);
    this.store.deleteRunsForWorkflow(id);
    return { deleted: true };
  }

  /** "Run now": fire a trigger by hand. Defaults to the first manual trigger, else the first trigger. */
  @Post('workflows/:id/run')
  run(@Param('id') id: string, @Body() body: { triggerNodeId?: string; payload?: unknown }) {
    const wf = this.workflows.get(id);
    const triggers = wf.nodes.filter((n) => n.kind.startsWith('trigger.'));
    const trigger = body?.triggerNodeId
      ? triggers.find((n) => n.id === body.triggerNodeId)
      : triggers.find((n) => n.kind === 'trigger.manual') ?? triggers[0];
    if (!trigger) throw new BadRequestException('This workflow has no trigger');
    const run = this.triggers.fire(id, trigger.id, body?.payload ?? { manual: true, at: new Date().toISOString() }, { allowOverlap: true });
    return run;
  }

  @Post('workflows/:id/export')
  export(@Param('id') id: string, @Body() body: { dir?: string; nodeIds?: string[] }) {
    if (!body?.dir) throw new BadRequestException('dir is required');
    return this.exporter.exportAgents(this.workflows.get(id), body.dir, body.nodeIds);
  }

  /** Built-in templates plus those shipped by enabled folder plugins. */
  private allTemplates() {
    return [...TEMPLATES, ...this.plugins.templates().map((t) => ({ ...t, pattern: 'plugin' as const }))];
  }

  @Get('templates')
  templates() {
    return this.allTemplates().map(({ key, name, description, pattern, nodes }) => ({ key, name, description, pattern, nodeCount: nodes.length }));
  }

  @Post('templates/:key')
  fromTemplate(@Param('key') key: string) {
    const t = this.allTemplates().find((x) => x.key === key);
    if (!t) throw new NotFoundException('Unknown template');
    return this.view(this.workflows.create({ name: t.name, description: t.description, nodes: structuredClone(t.nodes), edges: structuredClone(t.edges) }));
  }
}
