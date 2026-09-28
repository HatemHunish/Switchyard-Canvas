import { BadRequestException, Injectable } from '@nestjs/common';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { expandHome } from '../common/paths';
import { AgentData, Workflow } from '../common/types';

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'agent';

/** YAML scalar that survives colons, quotes and newlines. */
const yaml = (s: string) => JSON.stringify(s);

/** Renders an agent node as a Claude Code subagent file (.claude/agents/<name>.md). */
export function toAgentMarkdown(d: AgentData): string {
  const fm: string[] = [`name: ${slug(d.name)}`, `description: ${yaml(d.description?.trim() || d.name)}`];
  if (d.allowedTools?.length) fm.push(`tools: ${d.allowedTools.join(', ')}`);
  if (d.disallowedTools?.length) fm.push(`disallowedTools: ${d.disallowedTools.join(', ')}`);
  if (d.model) fm.push(`model: ${d.model}`);
  if (d.permissionMode && d.permissionMode !== 'bypassPermissions') fm.push(`permissionMode: ${d.permissionMode}`);
  if (d.effort) fm.push(`effort: ${d.effort}`);
  if (d.maxTurns) fm.push(`maxTurns: ${d.maxTurns}`);

  const body = [
    d.systemPrompt?.trim(),
    // The task prompt becomes standing instructions; template variables are meaningless outside the canvas.
    d.prompt?.trim() && `## Task\n${d.prompt.replace(/\{\{\s*[\w.-]+\s*\}\}/g, '(provided by the caller)').trim()}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  return `---\n${fm.join('\n')}\n---\n\n${body}\n`;
}

@Injectable()
export class ExportService {
  exportAgents(wf: Workflow, dir: string, nodeIds?: string[]) {
    const root = expandHome(dir.trim());
    if (!root || !existsSync(root)) throw new BadRequestException(`Directory does not exist: ${root}`);
    const target = join(root, '.claude', 'agents');
    mkdirSync(target, { recursive: true });
    const written: string[] = [];
    for (const n of wf.nodes) {
      if (n.kind !== 'agent' || (nodeIds && !nodeIds.includes(n.id))) continue;
      const file = join(target, `${slug(n.data.name)}.md`);
      writeFileSync(file, toAgentMarkdown(n.data as AgentData));
      written.push(file);
    }
    return { directory: target, files: written };
  }
}
