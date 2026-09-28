import { Injectable } from '@nestjs/common';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DATA_DIR } from '../common/paths';
import { Subject } from 'rxjs';
import { BusEvent, UsageInfo } from '../common/types';

/** In-process pub/sub that feeds the SSE stream the canvas listens to. */
@Injectable()
export class EventBus {
  readonly events$ = new Subject<BusEvent>();
  /** Latest subscription usage reported by the CLI's rate_limit_event. */
  usage: UsageInfo | null = null;
  private readonly usageFile = join(DATA_DIR, 'usage.json');

  constructor() {
    // Last known usage survives restarts, so the dashboard isn't blank until the next run.
    try {
      if (existsSync(this.usageFile)) this.usage = JSON.parse(readFileSync(this.usageFile, 'utf8'));
    } catch {
      this.usage = null;
    }
  }

  emit(event: BusEvent) {
    if (event.type === 'usage') {
      this.usage = event.usage;
      try {
        writeFileSync(this.usageFile, JSON.stringify(event.usage));
      } catch {
        /* best effort */
      }
    }
    this.events$.next(event);
  }
}
