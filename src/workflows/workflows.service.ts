import { Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes, randomUUID } from 'crypto';
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Subject } from 'rxjs';
import { WORKFLOWS_DIR } from '../common/paths';
import { Workflow } from '../common/types';

export type WorkflowChange = { type: 'saved'; workflow: Workflow } | { type: 'deleted'; id: string };

/** Workflows are plain JSON files, one per workflow, so they are easy to diff and share. */
@Injectable()
export class WorkflowsService {
  readonly changes$ = new Subject<WorkflowChange>();

  private file(id: string) {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new NotFoundException('Invalid workflow id');
    return join(WORKFLOWS_DIR, `${id}.json`);
  }

  list(): Workflow[] {
    return readdirSync(WORKFLOWS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(WORKFLOWS_DIR, f), 'utf8')) as Workflow;
        } catch {
          return null;
        }
      })
      .filter((w): w is Workflow => !!w)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): Workflow {
    const path = this.file(id);
    if (!existsSync(path)) throw new NotFoundException(`Workflow ${id} not found`);
    return JSON.parse(readFileSync(path, 'utf8'));
  }

  create(input: Partial<Workflow>): Workflow {
    const now = new Date().toISOString();
    const wf: Workflow = {
      name: 'Untitled workflow',
      nodes: [],
      edges: [],
      ...input,
      // Imported workflows get a fresh identity and start disabled.
      id: randomUUID(),
      enabled: false,
      webhookToken: randomBytes(18).toString('base64url'),
      createdAt: now,
      updatedAt: now,
    };
    return this.write(wf);
  }

  update(id: string, patch: Partial<Workflow>): Workflow {
    const current = this.get(id);
    return this.write({
      ...current,
      ...patch,
      id,
      webhookToken: current.webhookToken,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    });
  }

  delete(id: string): void {
    const path = this.file(id);
    if (existsSync(path)) unlinkSync(path);
    this.changes$.next({ type: 'deleted', id });
  }

  private write(wf: Workflow): Workflow {
    writeFileSync(this.file(wf.id), JSON.stringify(wf, null, 2));
    this.changes$.next({ type: 'saved', workflow: wf });
    return wf;
  }
}
