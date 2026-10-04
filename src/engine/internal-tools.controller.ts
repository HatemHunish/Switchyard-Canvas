import { Body, Controller, ForbiddenException, Headers, Post } from '@nestjs/common';
import { isInternal } from '../common/runtime';
import { AppToolScope } from './app-tools';
import { AppToolsService } from './app-tools.service';

/** Called by the stdio tool server inside a Codex agent's process (Claude agents call AppToolsService in process). */
@Controller('api')
export class InternalToolsController {
  constructor(private readonly tools: AppToolsService) {}

  @Post('internal/tools/call')
  call(@Headers('x-internal-token') token: string, @Body() body: { tool?: string; args?: Record<string, any>; scope?: AppToolScope }) {
    if (!isInternal(token)) throw new ForbiddenException();
    return this.tools.call(String(body?.tool ?? ''), body?.args, body?.scope ?? {});
  }
}
