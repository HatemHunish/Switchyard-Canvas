import { Controller, Get, Header, NotFoundException, Param, Post, Query, Res } from '@nestjs/common';
import { execFile } from 'child_process';
import type { Response } from 'express';
import { existsSync, statSync } from 'fs';
import { extname } from 'path';
import { RunsStore } from '../engine/runs.store';
import { escapeHtml, PREVIEW_CSP, renderPreview, viewerFor } from './preview';

/** Types a browser would run scripts in if opened directly: always sandboxed. */
const ACTIVE = new Set(['.html', '.htm', '.svg', '.xml', '.xhtml']);

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
    const headers: Record<string, string> = { 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.name)}` };
    if (ACTIVE.has(extname(f.name).toLowerCase())) headers['Content-Security-Policy'] = PREVIEW_CSP;
    return res.sendFile(f.path, { headers });
  }

  /** What the viewer needs to know: how to show it, and where it came from. */
  @Get(':id/info')
  info(@Param('id') id: string) {
    const f = this.store.fileInfo(id);
    if (!f) throw new NotFoundException('File not found');
    const exists = existsSync(f.path);
    return { ...f, bytes: exists ? statSync(f.path).size : f.bytes, exists, viewer: exists ? viewerFor(f.name, f.path) : 'none' };
  }

  /** The file rendered as a sandboxed HTML page (Markdown, Word, Excel, PowerPoint, CSV, JSON, code, text…). */
  @Get(':id/view')
  @Header('Cache-Control', 'no-store')
  async view(@Param('id') id: string, @Res() res: Response) {
    const f = this.file(id);
    res.setHeader('Content-Security-Policy', PREVIEW_CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type('html');
    try {
      res.send(await renderPreview(f.path, f.name));
    } catch (err: any) {
      res.send(
        `<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;background:#0d131c;color:#e6ebf2;padding:24px"><p>Couldn’t preview ${escapeHtml(f.name)}: ${escapeHtml(String(err?.message ?? err))}</p><p style="color:#8291a6">Use Open to view it in its app.</p></body>`,
      );
    }
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
