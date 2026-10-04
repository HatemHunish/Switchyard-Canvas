import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
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
}
