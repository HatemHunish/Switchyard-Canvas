import { AgentData, InsightData, SetupQuestion, SourceData, WfEdge, WfNode } from '../common/types';

// Media monitoring and insight workflows built on the plugin sources.

const agent = (over: Partial<AgentData> & Pick<AgentData, 'name' | 'prompt'>): AgentData => ({
  model: 'sonnet',
  effort: '',
  allowedTools: [],
  disallowedTools: [],
  permissionMode: 'dontAsk',
  cwd: '~',
  ...over,
});

const src = (plugin: string, source: string, dataset: string, config: Record<string, unknown>, over: Partial<SourceData> = {}): SourceData => ({
  plugin,
  source,
  config,
  dataset,
  onlyNew: true,
  stopIfEmpty: false,
  continueOnError: true,
  limit: 100,
  ...over,
});

const insight = (over: Partial<InsightData> = {}): InsightData => ({ fields: ['sentiment', 'topics', 'summary'], model: 'haiku', maxItems: 150, stopIfEmpty: true, ...over });

const at = (col: number, row = 0) => ({ x: col * 300, y: row * 170 });
const edge = (source: string, target: string, sourceHandle?: string): WfEdge => ({ id: `${source}-${sourceHandle ?? 'out'}-${target}`, source, target, sourceHandle: sourceHandle ?? null });

export const INSIGHT_TEMPLATES: Array<{ key: string; name: string; description: string; pattern: 'insights'; setup?: SetupQuestion[]; nodes: WfNode[]; edges: WfEdge[] }> = [
  {
    key: 'brand-monitor',
    name: 'Brand mention monitor',
    description: 'Every hour: new mentions from Reddit, Hacker News and Google News go into a “Brand” dataset, get sentiment and topics, and you are alerted when negative mentions spike. Change “Acme” to your brand.',
    pattern: 'insights',
    setup: [
      { id: 'brand', label: 'Your brand, product or company name', type: 'text', placeholder: 'Acme', required: true, targets: [{ node: 'reddit', path: 'config.query', replace: 'Acme' }, { node: 'hn', path: 'config.query', replace: 'Acme' }, { node: 'news', path: 'config.query', replace: 'Acme' }, { node: 'label', path: 'brief', replace: 'Acme' }] },
    ],
    nodes: [
      { id: 'hourly', kind: 'trigger.schedule', position: at(0, 1), data: { mode: 'interval', everyMinutes: 60 } },
      { id: 'reddit', kind: 'source', label: 'Reddit mentions', position: at(1, 0), data: src('reddit', 'search', 'Brand', { query: '"Acme"', sort: 'new', time: 'day' }) },
      { id: 'hn', kind: 'source', label: 'Hacker News mentions', position: at(1, 1), data: src('hackernews', 'search', 'Brand', { query: 'Acme', tags: 'all', minPoints: 0 }) },
      { id: 'news', kind: 'source', label: 'News mentions', position: at(1, 2), data: src('rss', 'google-news', 'Brand', { query: '"Acme" when:1d', language: 'en-US', country: 'US' }) },
      { id: 'all', kind: 'merge', position: at(2, 1), data: { mode: 'all' } },
      { id: 'label', kind: 'insight', position: at(3, 1), data: insight({ dataset: 'Brand', brief: 'Mentions of Acme, its products and support. Sentiment is toward Acme.', fields: ['sentiment', 'topics', 'relevance', 'summary'] }) },
      { id: 'spike', kind: 'condition', label: 'Negative mentions spike (30% or more of at least 3 new ones)', position: at(4, 1), data: { mode: 'expression', expression: 'output.count >= 3 && output.negativeShare >= 0.3' } },
      { id: 'alert', kind: 'action', position: at(5, 1), data: { action: 'notify', title: 'Negative mentions: {{nodes.label.output.negative}} of {{nodes.label.output.count}}', message: 'Open Insights → Brand to see what people are saying.' } },
    ],
    edges: [edge('hourly', 'reddit'), edge('hourly', 'hn'), edge('hourly', 'news'), edge('reddit', 'all'), edge('hn', 'all'), edge('news', 'all'), edge('all', 'label'), edge('label', 'spike'), edge('spike', 'alert', 'true')],
  },
  {
    key: 'trend-radar',
    name: 'Trend radar → content ideas',
    description: 'Every morning: today’s Google trending searches plus search interest for your keywords go into a “Trends” dataset; an agent suggests content ideas, you approve or send feedback, and the plan is saved.',
    pattern: 'insights',
    setup: [
      { id: 'business', label: 'What does your business do?', type: 'text', placeholder: 'a coffee brand', targets: [{ node: 'ideas', path: 'prompt', replace: 'a coffee brand' }] },
      { id: 'keywords', label: 'Keywords to track (up to 5)', type: 'list', placeholder: 'cold brew\ncoffee subscription', targets: [{ node: 'interest', path: 'config.keywords' }] },
      { id: 'country', label: 'Country code', type: 'text', default: 'US', placeholder: 'US, SA, AE, GB…', targets: [{ node: 'daily', path: 'config.geo' }, { node: 'interest', path: 'config.geo' }] },
      { id: 'time', label: 'What time each morning?', type: 'time', default: '08:00', targets: [{ node: 'morning', path: '@time' }] },
    ],
    nodes: [
      { id: 'morning', kind: 'trigger.schedule', position: at(0, 0.5), data: { mode: 'cron', cron: '0 8 * * *', everyMinutes: 60 } },
      { id: 'daily', kind: 'source', label: 'Trending searches', position: at(1, 0), data: src('gtrends', 'daily', 'Trends', { geo: 'US' }, { onlyNew: false }) },
      { id: 'interest', kind: 'source', label: 'Our keywords', position: at(1, 1), data: src('gtrends', 'interest', 'Trends', { keywords: ['coffee subscription', 'cold brew'], geo: 'US', time: 'today 3-m' }, { onlyNew: false }) },
      { id: 'both', kind: 'merge', position: at(2, 0.5), data: { mode: 'all' } },
      { id: 'trends', kind: 'dataset', position: { x: 900, y: -190 }, data: { name: 'Trends' } },
      {
        id: 'ideas',
        kind: 'agent',
        position: at(3, 0.5),
        data: agent({
          name: 'content-strategist',
          description: 'Turns search trends into timely content ideas.',
          prompt:
            'You plan content for a coffee brand. From today’s trending searches and the interest in our keywords (use dataset_stats and dataset_search for history), propose 5 timely content ideas. For each: the hook, the format (post, reel, blog, email), why now (cite the trend and numbers) and a first line. Skip trends that don’t fit the brand. Write in Markdown.',
        }),
      },
      { id: 'approve', kind: 'human', position: at(4, 0.5), data: { title: 'Approve content ideas', instructions: 'Send back with feedback to get a revised list.', onReject: 'revise', maxRounds: 3 } },
      { id: 'save', kind: 'action', position: at(5, 0.5), data: { action: 'save', folder: '~/Documents/Trend radar', fileName: 'ideas-{{today}}', what: 'text', overwrite: true } },
    ],
    edges: [edge('morning', 'daily'), edge('morning', 'interest'), edge('daily', 'both'), edge('interest', 'both'), edge('both', 'ideas'), edge('trends', 'ideas'), edge('ideas', 'approve'), edge('approve', 'save', 'true'), edge('approve', 'ideas', 'revise')],
  },
  {
    key: 'social-report',
    name: 'Weekly social media report',
    description: 'Every Monday: your YouTube channel, Instagram and Facebook Page stats and posts go into a “Social” dataset; an analyst writes the week’s report (growth, best posts, what to do next) as a PDF and drafts an email. Needs keys under Plugins.',
    pattern: 'insights',
    setup: [
      { id: 'yt', label: 'Your YouTube channel', type: 'text', placeholder: '@yourchannel', help: 'Leave empty if you don’t use YouTube.', targets: [{ node: 'yt', path: 'config.channel' }] },
      { id: 'ig', label: 'Your Instagram account ID', type: 'text', help: 'Needs the Instagram & Facebook plugin key. Leave empty to skip.', targets: [{ node: 'ig', path: 'config.igUserId' }] },
      { id: 'fb', label: 'Your Facebook Page ID', type: 'text', help: 'Leave empty to skip.', targets: [{ node: 'fb', path: 'config.pageId' }] },
      { id: 'email', label: 'Who should get the report?', type: 'email', targets: [{ node: 'mail', path: 'to' }] },
    ],
    nodes: [
      { id: 'monday', kind: 'trigger.schedule', position: at(0, 1), data: { mode: 'cron', cron: '0 9 * * 1', everyMinutes: 60 } },
      { id: 'yt', kind: 'source', label: 'YouTube channel', position: at(1, 0), data: src('youtube', 'channel', 'Social', { channel: '@yourchannel' }, { onlyNew: false }) },
      { id: 'ig', kind: 'source', label: 'Instagram posts', position: at(1, 1), data: src('meta', 'ig-media', 'Social', { igUserId: '' }, { onlyNew: false }) },
      { id: 'fb', kind: 'source', label: 'Facebook Page', position: at(1, 2), data: src('meta', 'fb-page', 'Social', { pageId: '' }, { onlyNew: false }) },
      { id: 'all', kind: 'merge', position: at(2, 1), data: { mode: 'all' } },
      { id: 'social', kind: 'dataset', position: { x: 900, y: -20 }, data: { name: 'Social' } },
      {
        id: 'analyst',
        kind: 'agent',
        position: at(3, 1),
        data: agent({
          name: 'social-analyst',
          description: 'Writes the weekly social media performance report.',
          prompt:
            'Write this week’s social media report in Markdown. Use dataset_stats (range 7d and 30d) and dataset_top for the numbers. Sections: # Weekly social report ({{today}}), ## Summary (3 bullets), ## Growth (followers/subscribers per platform, with change), ## Best posts (table: platform, post, engagement, link), ## What worked and what didn’t, ## Next week (3 concrete actions).',
        }),
      },
      { id: 'pdf', kind: 'output', position: at(4, 1), data: { format: 'pdf', fileName: 'social-report-{{today}}', mode: 'quick' } },
      { id: 'mail', kind: 'action', position: at(5, 1), data: { action: 'email', via: 'mail', to: '', subject: 'Social media report: {{today}}', body: 'Hi team,\n\nThis week’s social media report is attached.', attach: true, sendNow: false } },
    ],
    edges: [edge('monday', 'yt'), edge('monday', 'ig'), edge('monday', 'fb'), edge('yt', 'all'), edge('ig', 'all'), edge('fb', 'all'), edge('all', 'analyst'), edge('social', 'analyst'), edge('analyst', 'pdf'), edge('pdf', 'mail')],
  },
  {
    key: 'competitor-watch',
    name: 'Competitor watch',
    description: 'Every 6 hours: watches competitors’ pricing pages for changes and the news for their names; when something changed, an analyst explains what and why it matters and drafts an email.',
    pattern: 'insights',
    setup: [
      { id: 'competitor', label: 'Competitor name', type: 'text', placeholder: 'Competitor Inc', required: true, targets: [{ node: 'news', path: 'config.query', replace: 'Competitor Inc' }] },
      { id: 'pages', label: 'Their pages to watch (one per line)', type: 'list', placeholder: 'https://competitor.com/pricing', required: true, targets: [{ node: 'pages', path: 'config.urls' }] },
      { id: 'email', label: 'Who should get the updates?', type: 'email', targets: [{ node: 'mail', path: 'to' }] },
    ],
    nodes: [
      { id: 'sixh', kind: 'trigger.schedule', position: at(0, 0.5), data: { mode: 'interval', everyMinutes: 360 } },
      { id: 'pages', kind: 'source', label: 'Competitor pages', position: at(1, 0), data: src('webwatch', 'page', 'Competitors', { urls: ['https://example.com/pricing'], start: '', end: '', ignore: [] }) },
      { id: 'news', kind: 'source', label: 'Competitor news', position: at(1, 1), data: src('rss', 'google-news', 'Competitors', { query: '"Competitor Inc" when:1d', language: 'en-US', country: 'US' }) },
      { id: 'both', kind: 'merge', position: at(2, 0.5), data: { mode: 'all' } },
      { id: 'changed', kind: 'condition', label: 'Something changed or there’s news', position: at(3, 0.5), data: { mode: 'expression', rule: { field: 'newAll', op: '>', value: '0' }, expression: '([].concat(output).reduce((a, o) => a + ((o && o.newCount) || 0), 0) ?? 0) > 0' } },
      {
        id: 'analyst',
        kind: 'agent',
        position: at(4, 0.5),
        data: agent({
          name: 'competitor-analyst',
          description: 'Explains competitor changes and news, and what they mean for us.',
          prompt: 'Below are new competitor page changes and news. For each: what changed, the likely reason, and what it means for us (threat, opportunity or nothing). End with recommended responses, if any. Be brief; skip noise and first snapshots.',
          allowedTools: ['WebFetch'],
        }),
      },
      { id: 'mail', kind: 'action', position: at(5, 0.5), data: { action: 'email', via: 'mail', to: '', subject: 'Competitor update: {{today}}', body: '{{input}}', attach: false, sendNow: false } },
    ],
    edges: [edge('sixh', 'pages'), edge('sixh', 'news'), edge('pages', 'both'), edge('news', 'both'), edge('both', 'changed'), edge('changed', 'analyst', 'true'), edge('analyst', 'mail')],
  },
  {
    key: 'app-review-digest',
    name: 'App review digest',
    description: 'Every day: new App Store reviews are labelled (sentiment, topics, bug or feature request); an agent writes a digest of themes, bugs and praise, and saves it. Set your app ID.',
    pattern: 'insights',
    setup: [
      { id: 'app', label: 'Your app’s App Store link or ID', type: 'text', placeholder: 'https://apps.apple.com/us/app/…/id284882215', required: true, targets: [{ node: 'reviews', path: 'config.appId' }] },
      { id: 'country', label: 'Store country', type: 'text', default: 'us', targets: [{ node: 'reviews', path: 'config.country' }] },
    ],
    nodes: [
      { id: 'daily', kind: 'trigger.schedule', position: at(0), data: { mode: 'cron', cron: '0 9 * * *', everyMinutes: 60 } },
      { id: 'reviews', kind: 'source', label: 'App Store reviews', position: at(1), data: src('rss', 'app-reviews', 'App reviews', { appId: '284882215', country: 'us' }, { continueOnError: false }) },
      {
        id: 'label',
        kind: 'insight',
        position: at(2),
        data: insight({ dataset: 'App reviews', fields: ['sentiment', 'topics', 'summary'], custom: 'type: one of bug, feature request, praise, complaint, question\nfeature: the app feature it is about', brief: 'Customer reviews of our app.' }),
      },
      { id: 'reviewsDs', kind: 'dataset', position: { x: 900, y: -190 }, data: { name: 'App reviews' } },
      {
        id: 'digest',
        kind: 'agent',
        position: at(3),
        data: agent({
          name: 'review-digest',
          description: 'Writes a daily digest of app reviews for the product team.',
          prompt: 'Write today’s app review digest for the product team in Markdown: overall mood (with numbers), top themes, bugs to fix (quote short snippets), feature requests, and praise. Use dataset_stats (7d) for the trend and dataset_search for details.',
          model: 'haiku',
        }),
      },
      { id: 'save', kind: 'action', position: at(4), data: { action: 'save', folder: '~/Documents/App review digests', fileName: 'digest-{{today}}', what: 'text', overwrite: true } },
      { id: 'ping', kind: 'action', position: at(5), data: { action: 'notify', title: 'App review digest ready', message: '{{nodes.label.output.count}} new reviews, {{nodes.label.output.negative}} negative' } },
    ],
    edges: [edge('daily', 'reviews'), edge('reviews', 'label'), edge('label', 'digest'), edge('reviewsDs', 'digest'), edge('digest', 'save'), edge('save', 'ping')],
  },
];
