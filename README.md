# Agent Canvas

Build Claude agents visually and run them on your **Claude subscription**: monitors on a schedule, agents triggered by files or webhooks, and multi-step pipelines.

Every agent step runs through the **Claude Code CLI installed on your machine** (`claude -p`), using the account you logged into yourself. The app never asks for, stores or sees credentials, and it doesn't need an API key.

## Requirements

- Node 20+
- Claude Code CLI on your `PATH`, logged in: run `claude` once and use `/login`. The badge in the top-right shows the login state.

## Run

```bash
npm install        # also installs client/
npm run build
npm start          # http://127.0.0.1:3002
```

Dev mode: `npm run dev` (Nest on :3002 plus Vite on :5173 with hot reload).

Environment variables: `PORT` (default 3002), `HOST` (default `127.0.0.1`), `AGENT_CANVAS_HOME` (data folder, default `~/.agent-canvas`), `CLAUDE_BIN`.

## Dashboard

The app opens on the **Dashboard**; the canvas is under **Workflows**.

- **Needs attention** (only shown when something does): items waiting for you, failures in the last 24h (with the failing step's real error), skipped schedule ticks, triggers that failed to arm, CLI logged out, usage above 80%. Each item links to its cause.
- **Tiles:** running now, waiting for you, runs today (7-day sparkline), 7-day success rate vs the week before, next scheduled run, 5h/7d subscription usage with reset time. Click a tile to filter the history below.
- **Live runs:** each run's steps as progress dots, the current step, orchestrator team members, elapsed time, Stop.
- **Needs you:** approve, send back or answer right on the dashboard.
- **Upcoming:** a 24h timeline of schedule ticks, plus the file watches and webhooks currently listening. Pause/resume per workflow, Run now, **Pause all** (an emergency stop that also cancels running runs) and **Resume**.
- **Latest files:** open, show in Finder.
- **History** (one filter row: time range, workflow, status, trigger, search): recent runs table, workflow health (last 20 outcomes, success %, next run, on/off), and activity (runs per day, usage by workflow, top errors, and a table view of the chart).

Everything updates live. Charts follow the bundled dataviz guidance. Completed runs are blue and failed runs red because green/red failed the colour-blind separation check on this surface; status is always shown with an icon, not colour alone.

## Concepts

| Node | What it does |
|---|---|
| **Manual** | Starts from the **Run** button |
| **Schedule** | Every N minutes, or on a cron schedule. Use it for monitors. A tick is skipped if the previous run is still going |
| **File watch** | Starts when files are added, changed or deleted (path or glob, debounced) |
| **Webhook** | `POST /api/hooks/<workflow>/<node>` with a token; the JSON body becomes `{{trigger.payload}}` |
| **Agent** | One `claude -p` run with its own prompt, persona, model, tools, permission mode and working directory. It can be forced to return JSON (JSON Schema) |
| **Orchestrator** | An agent that coordinates a **team**. Drag from its green *team* handle to agents to make them team members. Given a task, it decides which members to use, briefs them, runs independent sub-tasks in parallel, checks their work and combines the results. Members run as Claude Code subagents inside the orchestrator's session (one process, one queue slot); each member's node lights up with its own activity and result |
| **Output file** | Turns the result into **PDF, PowerPoint, Word, Excel, HTML, Markdown, CSV, JSON or text**. *Quick convert* builds it locally from the Markdown in under a second, at no usage cost, with right-to-left support. *Designed by Claude* lets an agent build it with its own tools and skills (charts, themes); it's slower and uses your Claude usage. Files go to `~/.agent-canvas/outputs/<workflow>/` by default and flow on to later steps |
| **Actions** | *Save to folder*, *Send email* (macOS Mail app, as a draft or sent, or SMTP), *Slack / Teams / Webhook* (POST), *Notify me*, *Open file*. Actions receive the files from earlier Output nodes (e.g. email attachments) and pass the result on, so they can be chained |
| **Condition** | Branches **yes/no**, either with a JS rule (`output.severity === 'high'`) or by asking Claude a yes/no question |
| **Merge** | Joins parallel branches: wait for all of them, or continue on the first one |
| **Memory** | A context store, not a step. Connect it to agents (from its bottom handle to an agent's top handle). It holds **notes** (facts agents save, answers you gave) and **documents** indexed from files and folders (RAG). Agents get `memory_search` / `memory_save` tools, and notes can be put into their context up front. Scope it to one workflow, or share it across workflows by name |
| **Human review** | Pauses the run for your **Approve / Reject** (with an optional comment). Approve → green "yes" output. To revise on reject, drag the orange **↩ revise** handle back to any earlier agent: it gets your feedback in its own session (and can ask you questions), every step between it and the review runs again, and you review the new result, up to N rounds. Otherwise reject takes the red "no" path. An optional time limit counts as a rejection |

Each step receives the previous step's output as `{{input}}`. If the prompt doesn't place `{{input}}` itself, the input is appended automatically. Other variables: `{{trigger.payload.*}}`, `{{nodes.<name>.output}}`, `{{date}}`.

Schedule, file and webhook triggers only fire while the workflow is **Enabled** and the app is running.

## Human in the loop

- **Agents can ask you questions.** Turn on *Can ask me questions* on an agent. It gets an `ask_user` tool from a small MCP server bundled with the app (`src/mcp/ask-server.ts`). When it calls the tool, its turn ends, the run pauses, and your answer resumes **the same Claude session** (`--resume`), so it keeps all its context.
- **Reviews** come from the Human review node (see above).
- Anything waiting shows in the **Inbox** (top bar), on the canvas (pulsing node plus a "Waiting for you" banner), in the tab title, and as a macOS notification (Settings).
- A waiting run holds no `claude` process and no queue slot. It can wait for hours, but **restarting the app cancels runs that are waiting**.
- Schedule ticks are skipped while that trigger's previous run is still waiting on you, so monitors don't pile up.
- **Notify the reviewer** (on Human review nodes, and "Notify when it asks" on agents that can ask): email (Mail app or SMTP), Slack, Teams, any webhook (JSON with the request and links), or a desktop notification, with optional reminders every N minutes up to M times. Each message has the content, a **Review now** link (a small page to approve, send back or answer, including from a phone if it can reach the app) and an **Open in Agent Canvas** link. Delivery results show in the step's activity. **Send test** checks your channels.
- Review links are single-use secrets per request. Opening a link only shows the form, so mail/chat link previews can't approve anything. Links point to this Mac unless you set **Settings → Public URL** (e.g. your Mac's LAN address with `HOST=0.0.0.0`, or a private tunnel).

## Orchestrator and team

- Team members are normal Agent nodes. Their **description** is how the orchestrator decides when to use them, so make it specific. Their prompt becomes standing instructions; the orchestrator's brief is the actual task.
- Members share the orchestrator's working directory. They can't ask you questions, but the orchestrator can (Can ask me questions). Members can use Memory nodes connected to them.
- Background subagents are turned off for orchestrators (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`), so every delegation reports back. Parallel work is several delegations in one turn.
- Tools allowed for any member are allowed for the whole session (permissions are per session in Claude Code), so the orchestrator could technically use them too.
- A Human review can loop back (↩ revise) to an orchestrator; it then re-plans with your feedback.

## Memory and RAG

- Search is local SQLite full-text search (FTS5 with BM25 ranking and stemming), so no embeddings API or API key is needed. It matches keywords and word forms, not meaning, so agents are told to search with several keywords.
- Indexing is incremental (by file modification time): text and code files up to 1 MB each, at most 3000 files per memory, skipping `node_modules`, `.git` and build folders. PDFs and Office files aren't indexed yet.
- **Remember my answers**: when a connected agent asks you something, the question and your answer are saved as a note, and the next run gets them up front instead of asking again.
- Several agents connected to one memory share it within a run and across runs. That's how later steps reuse what earlier ones found.
- Data lives in `~/.agent-canvas/memory.db`. A workflow's private memory is deleted with the workflow; shared memories are kept.
- Agent tools reach the app through the bundled MCP server (`src/mcp/tools-server.ts`) over localhost, authenticated with a per-process secret.

## Files and actions

- PDF uses the Chrome/Edge/Brave already installed (headless, with its own throwaway profile). The path can be set in Settings.
- Email through the **Mail app** uses the accounts set up there, with no password stored in this app. macOS asks once to allow controlling Mail. By default it opens a draft for you to check; "Send immediately" sends without asking.
- Email through **SMTP** is configured in Settings, and the password is kept in the macOS Keychain. SMTP always sends immediately, so put a Human review before it if you want to check first.
- Webhooks send the text and file *names/paths*. The files themselves stay on this Mac; use Email to send them.
- The UI can only download files that a run produced (looked up by id), never arbitrary paths.

## Safety defaults

- Agents run with `--permission-mode dontAsk` and `--permission-prompts none`, so only the tools you allow are available and headless runs never hang waiting on a permission prompt.
- `bypassPermissions` is available per agent, with a warning. Use it only in throwaway folders.
- The server binds to localhost. Webhooks need a per-workflow token and only work while the workflow is enabled.
- **Settings → Max agents running at once** (default 2) queues extra runs, because they all share one subscription's usage limits. The top bar shows your 5-hour usage as reported by the CLI.

## Data

- `~/.agent-canvas/workflows/*.json`: one JSON file per workflow (also downloadable or importable from the UI)
- `~/.agent-canvas/runs.db`: run history (SQLite), including each step's prompt, output, activity and session id
- `~/.agent-canvas/memory.db`: memory stores (notes and indexed document chunks)
- `~/.agent-canvas/outputs/`: files made by Output nodes (default location)
- Each agent step is a normal Claude Code session. Continue it in your terminal with the `claude --resume <id>` command shown in the step's **Last run** tab.

## Export to Claude Code

**Export** writes each agent node as `.claude/agents/<name>.md` in a project folder, or in `~/` to make it available in every project. The agents then appear in `/agents` inside Claude Code.
