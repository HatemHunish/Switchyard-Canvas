import { Controller, Get, NotFoundException, Param, Post, Query, Res } from '@nestjs/common';
import { execFile } from 'child_process';
import type { Response } from 'express';
import { existsSync } from 'fs';
import { RunsStore } from '../engine/runs.store';

/** Serves only files the app produced (looked up by id), never arbitrary paths. */
@Controller('api/files')
export class FilesController {
  constructor(private readonly store: RunsStore) {}

  private file(id: string) {
    const f = this.store.getFile(id);
    if (!f || !existsSync(f.path)) throw new NotFoundException('File not found (it may have been moved or deleted)');
    return f;
  }

  @Get(':id')
  download(@Param('id') id: string, @Query('download') download: string | undefined, @Res() res: Response) {
    const f = this.file(id);
    if (download) return res.download(f.path, f.name);
    return res.sendFile(f.path, { headers: { 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.name)}` } });
  }

  /** Open with the default app, or reveal in Finder. Local-only conveniences. */
  @Post(':id/:how')
  open(@Param('id') id: string, @Param('how') how: string) {
    const f = this.file(id);
    const args = process.platform === 'darwin' ? (how === 'reveal' ? ['-R', f.path] : [f.path]) : [f.path];
    execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', args);
    return { ok: true };
  }
}
