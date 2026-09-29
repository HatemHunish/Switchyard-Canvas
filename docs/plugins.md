# Writing a plugin

A plugin brings outside data and abilities into Agent Canvas:

- **Sources**: canvas nodes that collect items (posts, comments, articles, reviews, trends, anything with an id) on a schedule. They don't use your Claude subscription. The app de-duplicates what they return, stores it in a dataset and charts it in **Insights**.
- **Tools**: functions agents can call while they run (through the app's bundled MCP server), e.g. a live lookup.
- **Insights panels**: extra "top N" or time-series panels, declared in JSON (plugins ship no UI code).
- **Templates**: ready-made workflows that appear in the sidebar.

The built-in connectors (RSS & News, Google Trends, Reddit, Hacker News, YouTube, Instagram & Facebook, TikTok, X, Web page watch, HTTP JSON, Apify) use the same contract; see `src/plugins/builtin/`. A complete folder example is in `examples/plugins/github-releases/`.

## Install

1. Put the plugin folder in `~/.agent-canvas/plugins/<id>/`, with a `plugin.json` and an `index.js` (CommonJS).
2. Open **Plugins → Reload**.
3. Turn it on. Folder plugins start **off**, because they run code on your Mac with your permissions; only enable plugins you trust.
4. Its sources appear in the palette under **Sources**, and its tools in each Agent's **Plugin tools** list.

After editing a plugin, click **Reload**; the app re-reads the folder without a restart.

## plugin.json

```json
{
  "id": "github-releases",
  "name": "GitHub releases",
  "version": "1.0.0",
  "icon": "🐙",
  "description": "New releases of repositories you follow.",
  "notice": "Limits, terms or requirements shown on the plugin card.",
  "homepage": "https://…",
  "credentials": [{ "key": "token", "label": "GitHub token", "optional": true, "help": "https://… or a short hint" }],
  "sources": [
    {
      "id": "releases",
      "title": "Repository releases",
      "hint": "New releases with their notes",
      "kind": "article",
      "needs": [],
      "fields": [
        { "key": "repos", "label": "Repositories", "type": "list", "required": true, "placeholder": "owner/repo" },
        { "key": "prereleases", "label": "Include pre-releases", "type": "boolean", "default": false }
      ]
    }
  ],
  "tools": [{ "name": "github_latest_release", "description": "…", "inputSchema": { "type": "object", "properties": { "repo": { "type": "string" } }, "required": ["repo"] } }],
  "insights": [{ "title": "Releases per repository", "panel": "top", "by": "extra.repo" }],
  "templates": ["templates/release-digest.json"]
}
```

| Field | Notes |
|---|---|
| `id` | 2–41 lowercase letters, digits or dashes. It is the item `source` in datasets, so keep it stable. |
| `credentials` | Entered on the Plugins page and stored in the macOS Keychain (elsewhere a user-only file), never in workflows. Read them with `ctx.secret(key)`. |
| `sources[].fields` | Types: `text`, `textarea`, `number`, `select` (with `options`), `list` (one value per line → string array), `boolean`. Each has `key`, `label`, plus optional `required`, `default`, `placeholder`, `help`. String values support `{{templates}}` (`{{trigger.payload.query}}`, `{{today}}`…). |
| `sources[].needs` | Credential keys the source can't run without; the node then shows a clear "needs …" message. |
| `tools[].name` | Unique across all plugins: lowercase letters, digits and `_`. |
| `insights` | `{"panel": "top", "by": "author" \| "feed" \| "kind" \| "extra.<path>" \| "enrich.<path>"}` or `{"panel": "timeseries", "series": "<prefix>"}`. |
| `templates` | Workflow JSON files (`name`, `description`, `nodes`, `edges`) relative to the plugin folder. |

## index.js

```js
module.exports = {
  sources: {
    // One function per source id. config = the node's field values (defaults applied, templates filled).
    async releases(config, ctx) {
      const list = await ctx.json(`https://api.github.com/repos/${config.repos[0]}/releases`);
      return {
        items: list.map((r) => ({ id: String(r.id), kind: 'article', title: r.name, text: r.body, url: r.html_url, author: r.author?.login, publishedAt: r.published_at })),
        points: [], // optional: [{ series: 'github:stars:owner/repo', t: Date.now(), value: 1234 }]
        note: 'optional line for the run log',
      };
    },
  },
  tools: {
    // Returns a string (or anything JSON-serialisable) that the agent reads.
    async github_latest_release(args, ctx) {
      return ctx.json(`https://api.github.com/repos/${args.repo}/releases/latest`);
    },
  },
  // Optional: the "Test connection" button. Return a short success text or throw.
  async test(ctx) {
    return 'Connected';
  },
};
```

### Items

| Field | Type | |
|---|---|---|
| `id` | string, **required** | Stable within your plugin (post id, URL…). Items are de-duplicated on `(plugin id, id)`: the first time an id is seen it counts as new; later runs refresh its metrics. |
| `kind` | `post` `comment` `video` `article` `trend` `review` `page` `other` | |
| `title`, `text`, `url`, `author` | strings | `text` is clipped at 8,000 characters. HTML is kept as given; strip it if it's markup. |
| `publishedAt` | epoch ms, epoch s or ISO date | Charts use it (else the time the item was first seen). |
| `metrics` | `{ likes, comments, shares, views, score, … }` numbers | Feed the Engagement score: likes + 2×comments + 3×shares + score + views/100. |
| `tags` | string[] | |
| `media` | `[{ type: 'image' \| 'video', url }]` | |
| `extra` | object | Anything else; usable in Insights panels (`extra.<path>`). |

**Points** are numbers over time, such as followers, subscribers, search interest or ratings. Name series `platform:entity:metric` (e.g. `youtube:@acme:subscribers`) and Insights groups the lines of one metric into one chart. Returning a point for the same series and time again overwrites it.

### ctx

| | |
|---|---|
| `ctx.fetch(url, init)` | `fetch` with a 30 s timeout (`init.timeoutMs` to change), the run's cancel signal, a polite 1 s gap per host, one retry after a 429 (honouring `Retry-After`), and an error on non-2xx that includes the start of the body. |
| `ctx.json(url, init)` / `ctx.text(url, init)` | The same, parsed. |
| `ctx.xml(text)` | Parses RSS/Atom/XML into plain objects (attributes as `@name`, text as `#text`). |
| `ctx.secret(key)` | One of this plugin's saved credentials, or `null`. |
| `ctx.log(text)` | A line in the step's activity log (and in Preview). |
| `ctx.state` | A small object saved per node between runs, for cursors (`since_id`, last hash…). Mutate it; it's saved after the run. Previews get a copy, so they never move the cursor. |
| `ctx.signal` | The run's `AbortSignal`, for your own long work. |

Throwing fails the step with your message (unless the node has **Keep going if this source fails**). For several independent requests (e.g. one per feed), catch each error and `ctx.log` it, so one bad URL doesn't lose the rest.

## What happens at run time

1. The Source node renders its field values with the run's templates and calls your source.
2. Items are cleaned (bounded lengths, valid URLs, numeric metrics) and upserted into the node's **dataset** (by name; several sources and workflows can share one).
3. The step's output is a Markdown digest of the **new** items (or all of them, if *Pass on only new items* is off) for the next step, plus `output.newCount`, `output.total`, `output.items` for Conditions. With *Stop if nothing new*, the following steps are skipped when nothing new came in.
4. An **Insight** step after it labels unlabelled items (sentiment, topics, relevance, entities, custom fields) with Claude in batches of 25, and a **Dataset** node gives agents the `dataset_stats`, `dataset_search` and `dataset_top` tools.

Data lives in `~/.agent-canvas/datasets.db`.
