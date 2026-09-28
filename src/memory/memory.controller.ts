import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Headers, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { runtime } from '../common/runtime';
import { MemoryData } from '../common/types';
import { WorkflowsService } from '../workflows/workflows.service';
import { MemoryService, storeIdFor } from './memory.service';

@Controller('api')
export class MemoryController {
  constructor(
    private readonly memory: MemoryService,
    private readonly workflows: WorkflowsService,
  ) {}

  /** Resolves a memory node of a saved workflow to its store. */
  private store(workflowId: string, nodeId: string) {
    const wf = this.workflows.get(workflowId);
    const node = wf.nodes.find((n) => n.id === nodeId && n.kind === 'memory');
    if (!node) throw new NotFoundException('No memory node with that id. Save the workflow first.');
    return { id: storeIdFor(wf.id, node), data: node.data as MemoryData };
  }

  @Get('workflows/:wf/memory/:node')
  overview(@Param('wf') wf: string, @Param('node') node: string, @Query('q') q?: string) {
    const s = this.store(wf, node);
    return { stats: this.memory.stats(s.id), items: this.memory.list(s.id, q, 100) };
  }

  @Post('workflows/:wf/memory/:node/notes')
  addNote(@Param('wf') wf: string, @Param('node') node: string, @Body() body: { key?: string; content?: string }) {
    return this.memory.saveNote(this.store(wf, node).id, String(body?.key ?? ''), String(body?.content ?? ''), 'manual');
  }

  @Delete('workflows/:wf/memory/:node/items/:id')
  deleteItem(@Param('wf') wf: string, @Param('node') node: string, @Param('id') id: string) {
    this.memory.deleteItem(this.store(wf, node).id, Number(id));
    return { deleted: true };
  }

  @Post('workflows/:wf/memory/:node/clear')
  clear(@Param('wf') wf: string, @Param('node') node: string, @Body() body: { kind?: 'note' | 'chunk' }) {
    this.memory.clear(this.store(wf, node).id, body?.kind === 'note' || body?.kind === 'chunk' ? body.kind : undefined);
    return { cleared: true };
  }

  @Post('workflows/:wf/memory/:node/index')
  index(@Param('wf') wf: string, @Param('node') node: string) {
    const s = this.store(wf, node);
    if (!s.data.sources?.length) throw new BadRequestException('Add at least one file or folder to index.');
    return { ...this.memory.index(s.id, s.data.sources), stats: this.memory.stats(s.id) };
  }

  // ---- Called by the bundled MCP tool server running inside an agent's CLI process ----

  private checkInternal(token?: string) {
    const a = Buffer.from(token ?? '');
    const b = Buffer.from(runtime.internalToken);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ForbiddenException();
  }

  @Post('internal/memory/search')
  internalSearch(@Headers('x-internal-token') token: string, @Body() body: { stores: string[]; query: string; limit?: number }) {
    this.checkInternal(token);
    const hits = this.memory.search(body.stores ?? [], String(body.query ?? ''), Math.min(Number(body.limit) || 6, 20));
    return hits.map((h) => ({ kind: h.kind, key: h.key, content: h.content.slice(0, 2000), source: h.source }));
  }

  @Post('internal/memory/save')
  internalSave(@Headers('x-internal-token') token: string, @Body() body: { store: string; key: string; content: string; runId?: string }) {
    this.checkInternal(token);
    return this.memory.saveNote(String(body.store), String(body.key ?? ''), String(body.content ?? ''), 'agent', body.runId);
  }
}
