import { Injectable } from '@nestjs/common';
import { loadSettings } from '../common/paths';

/**
 * Global semaphore for `claude` processes. Every run shares the user's
 * subscription limits, so we cap how many agents run at the same time.
 */
@Injectable()
export class ProcessQueue {
  private active = 0;
  private waiting: Array<() => void> = [];
  limit = loadSettings().concurrency;

  get stats() {
    return { active: this.active, waiting: this.waiting.length, limit: this.limit };
  }

  setLimit(limit: number) {
    this.limit = Math.max(1, Math.floor(limit));
    this.drain();
  }

  async run<T>(task: () => Promise<T>, onQueued?: () => void): Promise<T> {
    if (this.active >= this.limit) {
      onQueued?.();
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await task();
    } finally {
      this.active--;
      this.drain();
    }
  }

  private drain() {
    while (this.active < this.limit && this.waiting.length) {
      this.active++;
      this.waiting.shift()!();
    }
  }
}
