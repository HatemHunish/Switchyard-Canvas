// Plain-language equivalents of the technical settings, for Simple mode.
// Each maps both ways so Simple and Advanced edit the same saved data.

// ---------- what an AI step may use ----------

export const CAPABILITIES = [
  { key: 'read', label: 'Read files', hint: 'Open and search files in its folder', tools: ['Read', 'Grep', 'Glob'] },
  { key: 'web', label: 'Search the web', hint: 'Look things up and read web pages', tools: ['WebSearch', 'WebFetch'] },
  { key: 'edit', label: 'Create and change files', hint: 'Write new files or edit existing ones in its folder', tools: ['Edit', 'Write'] },
  { key: 'run', label: 'Run commands', hint: 'Use the terminal. Powerful: only in folders you trust', tools: ['Bash'] },
] as const;
export type CapKey = (typeof CAPABILITIES)[number]['key'];

const CAP_TOOLS = new Set<string>(CAPABILITIES.flatMap((c) => [...c.tools]));

export function capsFromTools(tools: string[] = []): { caps: Set<CapKey>; other: string[] } {
  const caps = new Set<CapKey>();
  for (const c of CAPABILITIES) if (c.tools.some((t) => tools.includes(t))) caps.add(c.key);
  return { caps, other: tools.filter((t) => !CAP_TOOLS.has(t)) };
}

export function toolsFromCaps(caps: Set<CapKey>, other: string[] = []): string[] {
  return [...CAPABILITIES.filter((c) => caps.has(c.key)).flatMap((c) => [...c.tools]), ...other];
}

export const QUALITY = [
  { value: 'haiku', label: 'Fast', hint: 'Quick and light on your usage. Good for simple tasks.' },
  { value: 'sonnet', label: 'Balanced', hint: 'Good results for most work.' },
  { value: 'opus', label: 'Best', hint: 'Most careful. Slower and uses more of your plan.' },
];
export const qualityLabel = (model?: string) => QUALITY.find((q) => q.value === model)?.label ?? (model ? model : 'Balanced');

export function capsText(tools: string[] = []) {
  const { caps } = capsFromTools(tools);
  const words = CAPABILITIES.filter((c) => caps.has(c.key)).map((c) => c.label.toLowerCase());
  return words.length ? words.join(', ') : 'thinks and writes only';
}

// ---------- schedules ----------

export type ScheduleKind = 'minutes' | 'hours' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom';
export interface Schedule {
  kind: ScheduleKind;
  every: number;
  time: string; // HH:MM
  day: number; // weekday 0-6 (Sun=0) or day of month
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n: number) => String(n).padStart(2, '0');

export function parseSchedule(d: { mode?: string; everyMinutes?: number; cron?: string }): Schedule {
  const base = { every: 15, time: '09:00', day: 1 };
  if (d.mode !== 'cron') {
    const m = Number(d.everyMinutes) || 15;
    return m % 60 === 0 && m >= 60 ? { ...base, kind: 'hours', every: m / 60 } : { ...base, kind: 'minutes', every: m };
  }
  const c = (d.cron ?? '').trim().split(/\s+/);
  if (c.length === 5 && /^\d+$/.test(c[0]) && /^\d+$/.test(c[1]) && c[3] === '*') {
    const time = `${pad(Number(c[1]))}:${pad(Number(c[0]))}`;
    if (c[2] === '*' && c[4] === '*') return { ...base, kind: 'daily', time };
    if (c[2] === '*' && c[4] === '1-5') return { ...base, kind: 'weekdays', time };
    if (c[2] === '*' && /^[0-7]$/.test(c[4])) return { ...base, kind: 'weekly', time, day: Number(c[4]) % 7 };
    if (/^\d+$/.test(c[2]) && c[4] === '*') return { ...base, kind: 'monthly', time, day: Number(c[2]) };
  }
  return { ...base, kind: 'custom' };
}

export function scheduleData(s: Schedule): { mode: 'interval' | 'cron'; everyMinutes?: number; cron?: string } {
  const [h, m] = s.time.split(':').map((x) => Number(x) || 0);
  switch (s.kind) {
    case 'minutes':
      return { mode: 'interval', everyMinutes: Math.max(1, Math.round(s.every)) };
    case 'hours':
      return { mode: 'interval', everyMinutes: Math.max(1, Math.round(s.every)) * 60 };
    case 'daily':
      return { mode: 'cron', cron: `${m} ${h} * * *` };
    case 'weekdays':
      return { mode: 'cron', cron: `${m} ${h} * * 1-5` };
    case 'weekly':
      return { mode: 'cron', cron: `${m} ${h} * * ${s.day}` };
    case 'monthly':
      return { mode: 'cron', cron: `${m} ${h} ${Math.min(28, Math.max(1, s.day))} * *` };
    default:
      return { mode: 'cron' };
  }
}

export function scheduleText(d: { mode?: string; everyMinutes?: number; cron?: string }): string {
  const s = parseSchedule(d);
  switch (s.kind) {
    case 'minutes':
      return s.every === 1 ? 'Every minute' : `Every ${s.every} minutes`;
    case 'hours':
      return s.every === 1 ? 'Every hour' : `Every ${s.every} hours`;
    case 'daily':
      return `Every day at ${s.time}`;
    case 'weekdays':
      return `Every weekday at ${s.time}`;
    case 'weekly':
      return `Every ${WEEKDAYS[s.day]} at ${s.time}`;
    case 'monthly':
      return `On day ${s.day} of each month at ${s.time}`;
    default:
      return `Custom schedule (${d.cron || 'not set'})`;
  }
}

// ---------- "If" rules ----------

export interface Rule {
  field: string;
  op: string;
  value: string;
}

export interface RuleField {
  key: string;
  label: string;
  type: 'number' | 'percent' | 'text' | 'sentiment';
  /** JS producing the value from `output` / `input`. */
  expr: string;
}

const TEXT_FIELD: RuleField = { key: 'text', label: 'the result (text)', type: 'text', expr: 'String(input)' };

/** What can be tested depends on the step before the "If". */
export function ruleFields(upstream: Array<{ kind: string; config: Record<string, any> }>): RuleField[] {
  const kinds = upstream.map((u) => u.kind);
  const f: RuleField[] = [];
  if (kinds.includes('insight')) {
    f.push(
      { key: 'negativeShare', label: 'share of negative mentions', type: 'percent', expr: 'output.negativeShare' },
      { key: 'positiveShare', label: 'share of positive mentions', type: 'percent', expr: 'output.positiveShare' },
      { key: 'negative', label: 'number of negative mentions', type: 'number', expr: 'output.negative' },
      { key: 'avgSentiment', label: 'average mood', type: 'sentiment', expr: 'output.avgSentiment' },
      { key: 'count', label: 'number of new items labelled', type: 'number', expr: 'output.count' },
    );
  }
  if (kinds.includes('source')) f.push({ key: 'newCount', label: 'number of new items', type: 'number', expr: 'output.newCount' });
  if (kinds.includes('merge') || upstream.length > 1)
    f.push({ key: 'newAll', label: 'number of new items (all sources)', type: 'number', expr: '[].concat(output).reduce((a, o) => a + ((o && o.newCount) || 0), 0)' });
  f.push(TEXT_FIELD);
  return f;
}

export const NUMBER_OPS = [
  { value: '>', label: 'is more than' },
  { value: '>=', label: 'is at least' },
  { value: '<', label: 'is less than' },
  { value: '<=', label: 'is at most' },
  { value: '===', label: 'is exactly' },
];
export const TEXT_OPS = [
  { value: 'contains', label: 'contains' },
  { value: 'notContains', label: 'doesn’t contain' },
  { value: 'empty', label: 'is empty' },
  { value: 'notEmpty', label: 'is not empty' },
];

export function ruleExpression(rule: Rule, fields: RuleField[]): string {
  const f = fields.find((x) => x.key === rule.field) ?? TEXT_FIELD;
  if (f.type === 'text') {
    const v = JSON.stringify(rule.value.toLowerCase());
    if (rule.op === 'empty') return '!String(input).trim()';
    if (rule.op === 'notEmpty') return '!!String(input).trim()';
    return `${rule.op === 'notContains' ? '!' : ''}String(input).toLowerCase().includes(${v})`;
  }
  const n = Number(rule.value) || 0;
  const value = f.type === 'percent' ? n / 100 : n;
  const op = NUMBER_OPS.some((o) => o.value === rule.op) ? rule.op : '>';
  return `(${f.expr} ?? 0) ${op} ${value}`;
}

export function ruleText(rule: Rule, fields?: RuleField[]): string {
  const f = (fields ?? []).find((x) => x.key === rule.field);
  const label = f?.label ?? (rule.field === 'text' ? 'the result' : rule.field);
  const op = [...NUMBER_OPS, ...TEXT_OPS].find((o) => o.value === rule.op)?.label ?? rule.op;
  if (rule.op === 'empty' || rule.op === 'notEmpty') return `If ${label} ${op}`;
  return `If ${label} ${op} ${f?.type === 'percent' ? `${rule.value}%` : f?.type === 'text' ? `“${rule.value}”` : rule.value}`;
}

// ---------- errors people can act on ----------

export type Fix = 'plugins' | 'settings' | 'login' | 'folder' | 'retry' | null;

export function friendly(raw?: string | null): { text: string; fix: Fix } | null {
  if (!raw) return null;
  const r = String(raw);
  const host = /from ([a-z0-9.-]+\.[a-z]{2,})/i.exec(r)?.[1]?.replace(/^(www|api|oauth)\./, '');
  const who = host ? host.replace(/\.(com|org|net|io)$/, '') : 'The service';
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const rules: Array<[RegExp, string, Fix]> = [
    [/not logged in|please run \/login|invalid api key|authentication_error|OAuth token has expired/i, 'Claude isn’t connected. Log in to your Claude plan again.', 'login'],
    [/Could not find the Claude Code CLI|claude.*not found on PATH|ENOENT.*claude/i, 'Claude Code isn’t installed on this Mac.', 'login'],
    [/usage limit|rate[_ ]limit.*(claude|anthropic)|5-hour limit|limit reached|resets at/i, 'You’ve reached your Claude usage limit for now. Runs can continue after it resets.', 'retry'],
    [/\b429\b|Too Many Requests|rate.?limited/i, `${cap(who)} is getting too many requests right now. It will work again in a few minutes.`, 'retry'],
    [/\b(401|403)\b|Unauthorized|Forbidden|invalid.*(token|key)|key.*(invalid|rejected)/i, `${cap(who)} didn’t accept the key. Check it under Plugins.`, 'plugins'],
    [/needs ".*"\. Add it under Plugins|is turned off\. Enable it under Plugins/i, r.replace(/\s*\(continuing without this source\)/, ''), 'plugins'],
    [/Working directory does not exist|no longer exists|ENOENT.*(cwd|chdir)/i, 'The folder this step uses was moved or deleted. Choose the folder again.', 'folder'],
    [/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network|getaddrinfo|timed? ?out|aborted due to timeout/i, `Couldn’t reach ${host ?? 'the internet'}. Check your connection; it will try again next time.`, 'retry'],
    [/\b404\b|Not Found/i, `${cap(who)} couldn’t find that. Check the name, link or ID in this step.`, null],
    [/Chrome did not produce a PDF|No Chrome|Chrome.*not found/i, 'Making the PDF needs Google Chrome (or Edge/Brave). Install it, or pick another file type.', 'settings'],
    [/Not authorized to send Apple events|osascript.*-1743|Mail.*not allowed/i, 'macOS blocked sending through the Mail app. Allow it in System Settings → Privacy & Security → Automation.', null],
    [/SMTP|EAUTH|Invalid login/i, 'The email server rejected the sign-in. Check the email settings.', 'settings'],
    [/needs a recipient|needs an http|needs a folder|needs a prompt|needs a working directory|is required/i, r, null],
  ];
  for (const [re, text, fix] of rules) if (re.test(r)) return { text, fix };
  return { text: r.length > 220 ? `${r.slice(0, 220)}…` : r, fix: null };
}
