import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { applyAnswers } from '../workflows/answers';
import { validateWorkflow } from '../workflows/validate';
import { WorkflowsService } from '../workflows/workflows.service';
import { AssistantService, Draft } from './assistant.service';

@Controller('api/assistant')
export class AssistantController {
  constructor(
    private readonly assistant: AssistantService,
    private readonly workflows: WorkflowsService,
  ) {}

  /** A workflow drafted from plain words (not saved yet). */
  @Post('draft')
  draft(@Body() body: { description?: string; previous?: Draft; change?: string }) {
    return this.assistant.draft({ description: String(body?.description ?? ''), previous: body?.previous, change: body?.change });
  }

  /** Saves a reviewed draft with the user's answers filled in. */
  @Post('create')
  create(@Body() body: { draft?: Draft; answers?: Record<string, string> }) {
    const d = body?.draft;
    if (!d || !Array.isArray(d.nodes) || !Array.isArray(d.edges)) throw new BadRequestException('draft is required');
    // Re-normalise: the draft came back from the browser.
    const clean = this.assistant.normalize(d);
    const answers = body.answers ?? {};
    for (const q of clean.questions) if (q.required && !String(answers[q.id] ?? '').trim()) throw new BadRequestException(`Please answer: ${q.label}`);
    // An unanswered email question must never leave its placeholder address in place.
    for (const q of clean.questions.filter((x) => x.type === 'email' && !String(answers[x.id] ?? '').trim()))
      for (const t of q.targets) {
        const n = clean.nodes.find((x) => x.id === t.node);
        if (n && t.path === 'to') n.data.to = '';
      }
    const nodes = applyAnswers(clean.nodes, clean.questions, answers);
    const wf = this.workflows.create({ name: clean.name, description: clean.description, nodes, edges: clean.edges });
    return { ...wf, issues: validateWorkflow(wf), triggers: [] };
  }
}
