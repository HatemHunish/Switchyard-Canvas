import { AgentData, WfEdge, WfNode } from '../common/types';

export interface WorkflowTemplate {
  key: string;
  name: string;
  description: string;
  pattern: 'monitor' | 'triggered' | 'pipeline' | 'human' | 'memory' | 'orchestrator' | 'output';
  nodes: WfNode[];
  edges: WfEdge[];
}

const agent = (over: Partial<AgentData> & Pick<AgentData, 'name' | 'prompt'>): AgentData => ({
  model: 'sonnet',
  effort: '',
  allowedTools: ['Read', 'Grep', 'Glob'],
  disallowedTools: [],
  permissionMode: 'dontAsk',
  cwd: '~',
  ...over,
});

const at = (col: number, row = 0) => ({ x: col * 300, y: row * 170 });
const edge = (source: string, target: string, sourceHandle?: string): WfEdge => ({
  id: `${source}-${sourceHandle ?? 'out'}-${target}`,
  source,
  target,
  sourceHandle: sourceHandle ?? null,
});

export const TEMPLATES: WorkflowTemplate[] = [
  {
    key: 'report-pdf-email',
    name: 'Weekly report → PDF + email',
    description: 'Every Monday 9:00 an agent writes a report; you approve it; it becomes a PDF and a PowerPoint, is saved to Documents and drafted as an email.',
    pattern: 'output',
    nodes: [
      { id: 'monday', kind: 'trigger.schedule', position: at(0), data: { mode: 'cron', cron: '0 9 * * 1', everyMinutes: 60 } },
      {
        id: 'writer',
        kind: 'agent',
        position: at(1),
        data: agent({
          name: 'report-writer',
          description: 'Writes the weekly report in Markdown.',
          prompt:
            'Write this week’s report in Markdown: a # title, a short summary, a ## Numbers section with a table, and a ## Next week section with bullets. Use the files in this folder as the source.',
          allowedTools: ['Read', 'Grep', 'Glob'],
        }),
      },
      { id: 'check', kind: 'human', position: at(2), data: { title: 'Approve weekly report', onReject: 'branch', maxRounds: 3 } },
      { id: 'pdf', kind: 'output', position: at(3), data: { format: 'pdf', fileName: 'weekly-report-{{today}}', mode: 'quick' } },
      { id: 'deck', kind: 'output', position: at(4), data: { format: 'pptx', fileName: 'weekly-report-{{today}}', mode: 'quick' } },
      { id: 'save', kind: 'action', position: at(5), data: { action: 'save', folder: '~/Documents/Weekly reports', what: 'files', overwrite: false } },
      {
        id: 'mail',
        kind: 'action',
        position: at(6),
        data: { action: 'email', via: 'mail', to: '', cc: '', subject: 'Weekly report: {{today}}', body: 'Hi team,\n\nThis week’s report is attached ({{files}}).', attach: true, sendNow: false },
      },
    ],
    edges: [edge('monday', 'writer'), edge('writer', 'check'), edge('check', 'pdf', 'true'), edge('pdf', 'deck'), edge('deck', 'save'), edge('save', 'mail'), edge('check', 'writer', 'revise')],
  },
  {
    key: 'orchestrated-team',
    name: 'Research team (orchestrator)',
    description: 'Give a task to an orchestrator; it decides which team members to use (researcher, analyst, writer), in what order or in parallel, and combines their work.',
    pattern: 'orchestrator',
    nodes: [
      { id: 'start', kind: 'trigger.manual', position: at(0), data: {} },
      {
        id: 'lead',
        kind: 'orchestrator',
        position: at(1),
        data: {
          ...agent({
            name: 'team-lead',
            description: 'Plans the work and delegates to the team.',
            prompt: 'Compare the three most popular open-source employee shift-scheduling tools and recommend one for a 20-person support team. Include a short comparison table.',
            allowedTools: [],
            model: 'sonnet',
            canAsk: true,
          }),
          parallel: true,
        },
      },
      { id: 'review', kind: 'human', position: at(2), data: { title: 'Approve recommendation', onReject: 'branch', maxRounds: 2 } },
      {
        id: 'researcher',
        kind: 'agent',
        position: { x: 0, y: 220 },
        data: agent({
          name: 'researcher',
          description: 'Finds current facts on the web and cites sources. Use for anything that needs up-to-date information.',
          prompt: 'Research the brief thoroughly with web search. Return concise findings with source URLs.',
          allowedTools: ['WebSearch', 'WebFetch'],
        }),
      },
      {
        id: 'analyst',
        kind: 'agent',
        position: { x: 300, y: 220 },
        data: agent({
          name: 'analyst',
          description: 'Compares options against requirements and scores trade-offs. Use once facts are gathered.',
          prompt: 'Analyse the provided information against the requirements. Be explicit about trade-offs and give a clear ranking.',
          allowedTools: [],
        }),
      },
      {
        id: 'writer',
        kind: 'agent',
        position: { x: 600, y: 220 },
        data: agent({
          name: 'writer',
          description: 'Turns findings and analysis into a clear, well-structured final write-up.',
          prompt: 'Write a clear, skimmable recommendation from the material provided. Use headings and a comparison table.',
          allowedTools: [],
          model: 'haiku',
        }),
      },
    ],
    edges: [
      edge('start', 'lead'),
      edge('lead', 'review'),
      edge('lead', 'researcher', 'team'),
      edge('lead', 'analyst', 'team'),
      edge('lead', 'writer', 'team'),
      edge('review', 'lead', 'revise'),
    ],
  },
  {
    key: 'reply-with-approval',
    name: 'Reply drafter with approval',
    description: 'An agent drafts a customer reply, asking you for missing details (remembered in memory for next time); you approve or send feedback, then it is finalized.',
    pattern: 'human',
    nodes: [
      {
        id: 'notes',
        kind: 'memory',
        position: { x: 300, y: -190 },
        data: { name: 'Customer notes', scope: 'workflow', sources: [], allowWrite: true, rememberAnswers: true, injectNotes: true, autoRetrieve: 0, reindexBeforeRun: false },
      },
      { id: 'start', kind: 'trigger.manual', position: at(0), data: {} },
      {
        id: 'draft',
        kind: 'agent',
        position: at(1),
        data: agent({
          name: 'reply-drafter',
          description: 'Drafts short, friendly support replies.',
          prompt:
            'Draft a short, friendly reply to a customer whose report export keeps failing. You need the customer’s first name and the export format they use before you can write it; ask for anything you don’t know.',
          allowedTools: [],
          canAsk: true,
          maxQuestions: 2,
        }),
      },
      {
        id: 'review',
        kind: 'human',
        position: at(2),
        data: { title: 'Approve customer reply', instructions: 'Check tone and accuracy. Reject with feedback to get a revised draft.', onReject: 'branch', maxRounds: 3 },
      },
      {
        id: 'final',
        kind: 'agent',
        position: at(3),
        data: agent({
          name: 'email-finalizer',
          description: 'Turns an approved draft into a ready-to-send email.',
          prompt: 'Turn this approved reply into a ready-to-send email with a subject line. Apply any reviewer note. Output only the email.',
          allowedTools: [],
          model: 'haiku',
        }),
      },
    ],
    edges: [edge('start', 'draft'), edge('notes', 'draft'), edge('draft', 'review'), edge('review', 'final', 'true'), edge('review', 'draft', 'revise')],
  },
  {
    key: 'docs-assistant',
    name: 'Docs Q&A with memory',
    description: 'Point a Memory node at your docs (RAG). An agent answers a question from them, citing sources, and saves what it learned.',
    pattern: 'memory',
    nodes: [
      {
        id: 'docs',
        kind: 'memory',
        position: { x: 300, y: -190 },
        data: { name: 'Project docs', scope: 'shared', sources: ['~/Desktop/Dev'], allowWrite: true, rememberAnswers: true, injectNotes: true, autoRetrieve: 4, reindexBeforeRun: true },
      },
      { id: 'ask', kind: 'trigger.webhook', position: at(0), data: {} },
      {
        id: 'answer',
        kind: 'agent',
        position: at(1),
        data: agent({
          name: 'docs-answerer',
          description: 'Answers questions from indexed project docs.',
          prompt: 'Answer this question using the memory (search it as needed) and cite the file paths you used: {{trigger.payload.question}}',
          allowedTools: ['Read'],
          canAsk: true,
        }),
      },
    ],
    edges: [edge('ask', 'answer'), edge('docs', 'answer')],
  },
  {
    key: 'log-monitor',
    name: 'Log monitor',
    description: 'Every 15 minutes, scan a log folder. If something serious shows up, draft an incident note.',
    pattern: 'monitor',
    nodes: [
      { id: 'every15', kind: 'trigger.schedule', position: at(0), data: { mode: 'interval', everyMinutes: 15, cron: '*/15 * * * *' } },
      {
        id: 'scan',
        kind: 'agent',
        position: at(1),
        data: agent({
          name: 'log-scanner',
          description: 'Scans recent application logs for errors and anomalies.',
          prompt:
            'Look at the log files in this directory that changed in the last 15 minutes. Identify errors, stack traces, timeouts and unusual spikes. Classify overall severity as none, low or high.',
          allowedTools: ['Read', 'Grep', 'Glob', 'Bash(tail *)', 'Bash(find *)'],
          model: 'haiku',
          outputSchema: JSON.stringify(
            {
              type: 'object',
              properties: {
                severity: { type: 'string', enum: ['none', 'low', 'high'] },
                summary: { type: 'string' },
                findings: { type: 'array', items: { type: 'string' } },
              },
              required: ['severity', 'summary', 'findings'],
            },
            null,
            2,
          ),
        }),
      },
      { id: 'isHigh', kind: 'condition', position: at(2), data: { mode: 'expression', expression: "output.severity === 'high'" } },
      {
        id: 'incident',
        kind: 'agent',
        position: at(3),
        data: agent({
          name: 'incident-writer',
          description: 'Turns log findings into a short incident note.',
          prompt:
            'Write a short incident note (impact, evidence, likely cause, next steps) for these findings and save it as incident-{{date}}.md in this directory.\n\n{{input}}',
          allowedTools: ['Read', 'Grep', 'Write'],
          permissionMode: 'acceptEdits',
        }),
      },
    ],
    edges: [edge('every15', 'scan'), edge('scan', 'isHigh'), edge('isHigh', 'incident', 'true')],
  },
  {
    key: 'review-pipeline',
    name: 'Code review pipeline',
    description: 'Read the current git diff, review it for bugs and style in parallel, then merge into one summary.',
    pattern: 'pipeline',
    nodes: [
      { id: 'start', kind: 'trigger.manual', position: at(0, 1), data: {} },
      {
        id: 'diff',
        kind: 'agent',
        position: at(1, 1),
        data: agent({
          name: 'diff-reader',
          description: 'Collects and explains the pending change.',
          prompt: 'Run git diff (staged and unstaged) and describe what changed, file by file, including the relevant code.',
          allowedTools: ['Read', 'Bash(git diff *)', 'Bash(git status *)'],
          model: 'haiku',
        }),
      },
      {
        id: 'bugs',
        kind: 'agent',
        position: at(2, 0),
        data: agent({
          name: 'bug-hunter',
          description: 'Looks for correctness bugs in a change.',
          prompt: 'Review this change for correctness bugs only. For each, give file, line and a concrete failure scenario.',
        }),
      },
      {
        id: 'style',
        kind: 'agent',
        position: at(2, 2),
        data: agent({
          name: 'style-reviewer',
          description: 'Checks a change against the surrounding code style.',
          prompt: 'Review this change for readability, naming and consistency with the surrounding code. Keep it short.',
          model: 'haiku',
        }),
      },
      { id: 'join', kind: 'merge', position: at(3, 1), data: { mode: 'all' } },
      {
        id: 'summary',
        kind: 'agent',
        position: at(4, 1),
        data: agent({
          name: 'review-summary',
          description: 'Merges review notes into one prioritized list.',
          prompt: 'Combine these reviews into one prioritized list (must-fix first). Drop duplicates.',
          allowedTools: [],
        }),
      },
    ],
    edges: [edge('start', 'diff'), edge('diff', 'bugs'), edge('diff', 'style'), edge('bugs', 'join'), edge('style', 'join'), edge('join', 'summary')],
  },
  {
    key: 'inbox-processor',
    name: 'Inbox processor',
    description: 'When a file lands in a folder, summarize it; if it needs action, extract tasks.',
    pattern: 'triggered',
    nodes: [
      { id: 'drop', kind: 'trigger.file', position: at(0), data: { path: '~/Desktop/inbox', events: ['add'], debounceMs: 1500 } },
      {
        id: 'summarize',
        kind: 'agent',
        position: at(1),
        data: agent({
          name: 'summarizer',
          description: 'Summarizes a document.',
          prompt: 'Read the file at {{trigger.payload.path}} and summarize it in 5 bullet points.',
          model: 'haiku',
          cwd: '~/Desktop/inbox',
        }),
      },
      { id: 'needsAction', kind: 'condition', position: at(2), data: { mode: 'llm', question: 'Does this document ask someone to do something?', model: 'haiku' } },
      {
        id: 'tasks',
        kind: 'agent',
        position: at(3),
        data: agent({
          name: 'task-extractor',
          description: 'Extracts action items with owners and dates.',
          prompt: 'List every action item in this summary with owner and due date (if stated) as a markdown checklist.',
          allowedTools: [],
          model: 'haiku',
        }),
      },
    ],
    edges: [edge('drop', 'summarize'), edge('summarize', 'needsAction'), edge('needsAction', 'tasks', 'true')],
  },
];
