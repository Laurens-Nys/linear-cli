# lin — design

`lin` is a Linear CLI built primarily for coding agents. Every noninteractive command is designed to be read by a language model at the lowest token cost that still changes the caller's next move. `lin tui` is the one explicit human-facing exception: an opt-in terminal browser for the authenticated viewer's assigned issues, with session-only list/Kanban layouts plus team, project, sort, title, and All/Started/Todo/Done controls.

Settled decisions:

- Binary name `lin`. TypeScript on Bun, compiled to a single binary. Repo `Laurens-Nys/linear-cli`, public, MIT.
- Output is TOON (Token-Oriented Object Notation, spec v4.1) plus raw markdown for document bodies. There is no `--json` flag anywhere. The only JSON in the tool is `lin api`, which returns raw GraphQL responses.
- Runtime dependencies: `@toon-format/toon` for agent output, pinned `@opentui/core` for `lin tui`, and `beautiful-mermaid` for ASCII Mermaid fences in the TUI detail pane. Dev dependency: `typescript` (for `tsc --noEmit`).
- No prompts, color, ANSI, spinners, or pagers in noninteractive commands. They produce the same output piped or not. Only an explicit `lin tui` invocation may take over an interactive terminal.
- Coverage: first-class verbs for everything an individual contributor or agent touches; `lin api` + `lin schema` cover the long tail of Linear's 536-operation schema.

## The four noninteractive output shapes

Every noninteractive command returns one of four shapes. `src/out.ts` owns all four; commands never hand-roll output. The explicitly invoked `lin tui` is the only exception and lets OpenTUI control the interactive terminal.

### Shape 1 — lists are TOON tables

```
issues[3]{id,title,state,priority,updated}:
  ENG-42,Fix login redirect loop,In Progress,high,2026-07-30
  ENG-41,Rotate webhook secrets,Todo,medium,2026-07-29
  ENG-38,Upgrade to Bun 1.3,Todo,low,2026-07-28
```

- Encode with `@toon-format/toon` `encode()` — uniform arrays of flat objects collapse to tabular form automatically. Never hand-format TOON rows; the encoder owns quoting and escaping.
- Empty result: `issues[0]:` header line via encoder plus nothing else; exit 0.
- Pagination: when more pages exist, append a comment line (comments are legal TOON, decoders strip them) carrying the exact continuation command:

```
# more · lin issue list --team ENG --after <cursor>
```

  The count appears only when the connection reports a true total (search does: `# 11 more · ...`); plain connections carry no total and the line never invents one.

- Dates render as `YYYY-MM-DD`. Priorities render as words: `urgent, high, medium, low, none`. Booleans as `true/false`. Empty cells stay empty.

### Shape 2 — one record is key: value, then markdown

```
id: ENG-42
title: Fix login redirect loop
state: In Progress
assignee: casey
priority: high
team: ENG
labels[1]: Bug
blocks[1]: ENG-43
updated: 2026-07-30
url: https://linear.app/acme/issue/ENG-42
---
## Context
Users bounce between /login and /app when the session cookie is stale...
---
comments[2]{ref,author,date,body}:
  9f2ab41c,casey,2026-07-29,"Repro: stale cookie, then any deep link"
  1c0d88ee,agent,2026-07-30,Fix pushed for review
```

- Header block is a flat object through the TOON encoder. Omit empty fields entirely — never print `assignee:` with nothing after it, never print `null`.
- Long markdown fields (issue description, document content, comment thread bodies) are NOT TOON — they ride between `---` fence lines as raw markdown. TOON has no multiline string form; escaped `\n` strings are banned from our output.
- Sub-collections (comments, milestones, recent posts) follow the body as TOON tables.

### Shape 3 — writes return receipts

```
created: ENG-57
url: https://linear.app/acme/issue/ENG-57
```

```
ENG-42:
  state: Todo -> In Progress
  assignee: none -> casey
```

- Create receipts: `created:` + identifier, then `url:`. With `-q`: bare identifier only.
- Update receipts show only the fields that changed, `old -> new`. Values come from the mutation response (read-back), not from the arguments.
- Delete/archive receipts: `archived: ENG-42` etc.

### Shape 4 — errors name the correction

```
error: team ENG has no state "In Progress"
states: Triage, Todo, Doing, In Review, Done, Canceled
```

- Errors go to stderr. First line `error: <one sentence>`. When the error is correctable, a second line lists the valid options or the exact flag to add.
- Exit codes are a contract: `0` ok · `1` API/network/unexpected · `2` correctable input (unknown name, missing flag, bad value) · `3` auth (missing/invalid LINEAR_API_KEY) · `4` not found.
- Ambiguous name resolution is exit 2 and lists the candidates. Never fuzzy-match silently.

## Grammar

Full form: `lin <noun> <verb> [args] [flags]`. Top-level aliases for the hot path:

| Alias | Meaning |
|---|---|
| `lin ENG-42` | bare identifier is always `issue view` |
| `lin ls` | my open issues (assignee = me, state type not completed/canceled), most recently updated first |
| `lin start [id]` | assign me + move to the team's first `started`-type state + print the suggested branch name |
| `lin done [id]` | move to the team's first `completed`-type state; id inferred from the current git branch when omitted |
| `lin triage [--team X]` | issues in the team's triage state, oldest first |
| `lin search "term"` | full-text issue search; `--projects` / `--docs` widen |

- Identifiers accepted in any form: `ENG-42`, full issue URL, or UUID. Mutations require UUIDs — resolve `ENG-42` via a lookup query first (accept the extra round trip).
- Branch inference: extract `[A-Z]+-\d+` (case-insensitive) from the current git branch name.
- Team defaults come from config; `--team` overrides.

Global flags: `-n/--limit N` (default 50), `--after <cursor>`, `--all-pages` (fetch every remaining page; only the declared paginated list commands `issue list`, `ls`, `triage`, `comment`, and `search` accept it — others fail before any request), `--fields a,b,c` (select and order columns on table commands; bare `--fields` lists the available ones and exits 2; non-table commands reject it before execution), `--team KEY`, `-q/--quiet`, `--no-cache`, `--version`, `-h/--help`. `lin --help` lists every command grouped by noun; `lin <noun> --help` lists that noun's commands; `lin <command> -h` prints one command's arguments, flags and examples. `--all` is not global: on `inbox` / `inbox read` / `inbox archive` it means include-read or bulk, never pagination. `lin api --paginate` stays the raw GraphQL walker and fails if `hasNextPage` is true without a usable `endCursor` or if a cursor repeats.

## Configuration, auth, cache

- Auth: `LINEAR_API_KEY` env var only. Sent as `Authorization: <key>` (no `Bearer` prefix — that is how Linear personal keys work). Missing key: exit 3 with the exact env var name. The key is never printed, logged, or written to disk.
- Config file `.lin.toml`, discovered: cwd, then git root, then `$XDG_CONFIG_HOME/lin/config.toml` (default `~/.config/lin/config.toml`). Project file wins over global. Flat TOML only (`key = "value"` lines) parsed by a ~20-line internal parser; keys: `team`, `limit`. Unknown keys, malformed lines, and unreadable files fail with exit 2, naming the file, the offending line/key/value, and the correction. Env twins `LIN_TEAM`, `LIN_LIMIT` beat file; flags beat everything. Invalid `LIN_LIMIT` and `--limit` fail the same way (`needs a number, got "..."`). No API key in config files.
- Cache: `$XDG_CACHE_HOME/lin/<workspace-urlKey>/meta.json` (default `~/.cache/lin/...`), 24h TTL. Holds the workspace's small vocabularies: teams (with states and labels), users, projects, workspace labels, templates. `lin cache warm` follows every vocabulary page (teams, users, projects, organization labels/templates, and each team's states/labels/templates). A missing or repeated cursor is exit 1 and does not write a partial cache; a complete walk writes once. Name resolution is exact (case-insensitive) against the cache; on miss, refresh once, then fail with candidates (exit 2). Commands that only need the vocabularies still succeed if the cache file cannot be written (sandboxes such as Infisical agent-proxy deny `~/.cache`). `lin cache` shows status, `lin cache warm` refreshes everything, `lin cache clear` deletes.
- The workspace urlKey comes from `viewer { organization { urlKey } }`, cached with the rest.

## Command inventory

Everything below ships now. Curated default columns are part of the contract — changing them later is a breaking change.

### issue

| Command | Behavior | Output |
|---|---|---|
| `issue list` | filters: `--mine`, `--assignee <name>`, `--unassigned`, `--state <name>`, `--label <name>` (repeat = AND), `--project`, `--cycle current\|next\|previous\|<n>`, `--parent <id>`, `--updated-since <ISO date>`, `--created-since`, `--archived`, `--sort updated\|created\|priority\|manual` (default updated). `--all-pages` walks every remaining page from `--after`. `--fields` may also select `parent`, `project`, `labels`, `blockers`, `url`; those keys are queried only when requested. `labels` append `…` when the nested page is truncated. `blockers` is an exact count, or `N+` when more inverse relations exist | rows `{id,title,state,assignee,priority,updated}`; with `--mine` drop assignee |
| `issue view <id>` | full record; `--comments [N\|all]` (default: last 3), `--no-body` | record + body + comments table |
| `issue create` | `--team`, `-t/--title`, `-d/--body <text\|@file\|->`, `--parent`, `--label` (repeat), `--assignee <name\|me>`, `--priority urgent\|high\|medium\|low\|none`, `--estimate N`, `--project`, `--cycle`, `--milestone`, `--due YYYY-MM-DD`, `--state`, `--template <name>` | create receipt |
| `issue update <id...>` | same axes as create plus `--add-label`, `--rm-label`, `--unassign`; multiple ids = one `issueBatchUpdate` | update receipt per issue |
| `issue archive / unarchive / delete <id>` | delete is trash (recoverable 30 days) | receipt |
| `issue relate <a> blocks\|blocked-by\|related\|duplicate <b>` | native relation; `issue unrelate <a> <b>` removes | receipt |
| `issue reorder <parent> <child> <child...>` | rewrites `subIssueSortOrder` spaced by 100 in the given order | rows: children in new order |
| `issue link <id> <url> [--title]` | URL attachment via `attachmentLinkURL` | receipt |
| `issue attach <id> <file>` | `fileUpload` mutation → HTTP PUT with returned headers → attach `assetUrl` | receipt with asset url |
| `issue branch <id>` / `issue url <id>` | print Linear's suggested `branchName` / canonical URL | one line |
| `issue subscribe / unsubscribe <id>` | follow/mute | receipt |

### comment

| Command | Behavior | Output |
|---|---|---|
| `comment <issue>` (list) | thread, oldest first; resolved threads marked `resolved: true` | rows `{ref,author,date,body}` (body whitespace-collapsed, clipped ~100 chars) |
| `comment add <issue> -m <text\|@file\|->` | `--reply-to <ref>` threads under a parent | receipt: ref + url |
| `comment edit <issue> <ref> -m ...` | edit own comment | receipt |
| `comment resolve / unresolve <issue> <ref>` | thread resolution | receipt |

Comment refs are the first 8 hex chars of the comment UUID; commands accept the full UUID or the 8-char prefix (resolved by listing the issue's comments and prefix-matching).

`lin react <issue-or-comment-ref> <emoji-name>` adds a reaction (`reactionCreate`); on an issue id it reacts to the issue, on a comment ref (with `--issue <id>`) to the comment.

### project / milestone / cycle / initiative / doc

| Command | Behavior | Output |
|---|---|---|
| `project list` | `--team`, `--initiative`, `--state` | rows `{id,name,state,lead,target}` (id = project slugId short form) |
| `project view <ref>` | record + content body + milestones table + last 3 posts | record |
| `project create / update` | `--name`, `-d/--body`, `--team A,B` (comma-separated for multi-team), `--lead`, `--target YYYY-MM-DD`, `--state` | receipt |
| `project post <ref> --health on-track\|at-risk\|off-track -m <text\|@file\|->` | a project status update (the ProjectUpdate entity) | receipt |
| `project posts <ref>` | recent status updates | rows `{date,author,health,body}` clipped |
| `milestone list --project <ref>` | milestones with progress | rows `{id,name,target,progress}` |
| `milestone create / update / delete` | `--project`, `--name`, `--target` | receipt |
| `cycle list [--team]` | includes `current` marker column | rows `{n,name,start,end,active}` |
| `cycle view current\|next\|previous\|<n>` | cycle record with scope/progress numbers | record |
| `cycle create / update` | `--team`, `--start`, `--end`, `--name` | receipt |
| `initiative list / view <ref>` | initiatives; view includes project rollup table | rows / record |
| `initiative create / update` | `--name`, `-d`, `--target`, `--state` | receipt |
| `initiative add-project / rm-project <initiative> <project>` | membership | receipt |
| `initiative post / posts <ref>` | initiative status updates, same shape as project posts | receipt / rows |
| `doc list` | `--project`, `--initiative` | rows `{id,title,project,updated}` |
| `doc view <ref>` | record header + full markdown content | record |
| `doc create / update` | `-t/--title`, `-d/--body <text\|@file\|->`, `--project`, `--initiative` | receipt |

Naming trap, verified against the schema: the GraphQL mutation `projectUpdate` edits a Project; the status-post entity is `ProjectUpdate` with mutation `projectUpdateCreate`. Same collision for `initiativeUpdate`. Our verbs avoid the trap: `update` always edits fields, `post/posts` always mean status updates.

### team / user / label / template / customer / inbox

| Command | Behavior | Output |
|---|---|---|
| `team list` | all teams | rows `{key,name,cycles,issues}` |
| `team view <key>` | record + states table + labels table + members table | record |
| `team states <key>` | workflow states — the write-path vocabulary | rows `{name,type,position}` |
| `user list` / `user me` | workspace members / the API key's identity | rows `{name,email,active}` / record |
| `label list [--team]` | team + workspace labels; groups render as `group/label` | rows `{name,group,color}` |
| `label create / update / archive` | `--team` or `--workspace`, `--color #hex`, `--parent <group>`, `--name` | receipt |
| `template list [--team]` / `template view <ref>` | issue templates | rows / record |
| `customer list / view <ref>` | customers with tier and status | rows `{name,tier,status}` / record |
| `customer create` | `--name`, `--domain`, `--tier` | receipt |
| `need add <customer> --issue <id> [-m text]` | attach a customer request to an issue (registered as the two-word `need add`, grouped under customer in help) | receipt |
| `need list [--customer\|--issue]` | requests | rows `{ref,customer,issue,body}` clipped |
| `inbox` | unread notifications, newest first; `--all` includes read | rows `{ref,type,actor,target,age}` |
| `inbox read <ref...\|--all>` | mark read | receipt |
| `inbox archive <ref...\|--all>` | archive | receipt |

### meta

| Command | Behavior | Output |
|---|---|---|
| `tui` | browser for my assigned issues; All/Started/Todo/Done list tabs plus session-only Team, Project, Sort, title, and List/Board controls; All stays Mine + Open, Done is completed assigned work; list state names preserve the selected server sort inside groups; Board requires one team, orders its real workflow states by progression (`triage`, `backlog`, `unstarted`, `started`, `completed`) and then configured position within each category, uses each state's Linear color, adapts column widths to the terminal, and loads assigned issues across non-canceled, non-duplicate states; the list/board query stays slim (no descriptions or comment bodies) and returns `totalCount`/`pageInfo` so the header can say `50 of 123` when the configured limit truncates, `50+` when the page is truncated but the reported total is not larger than the shown page, and just `23` when the page is complete; opening an issue lazy-loads its description plus the last three comments (oldest first, labeled recent so it does not imply a complete thread), caches them for the session by issue id + `updatedAt`, and cancels stale list/detail requests with AbortSignal (AbortError is continuity, not a footer error); click opens a card and a thresholded mouse drag names and highlights the destination before optimistically updating `issueUpdate.stateId`, with identity-preserving reconciliation, scroll preservation, rollback on failure, and no within-column ordering; right-click on an exact list row or Kanban card (or keyboard `a` on the shown/selected issue) opens a searchable action menu for that issue: Open in Linear, copy identifier, copy https URL, move to the team's first started or completed state, set priority, and add a comment (no assign-me, because the TUI is already mine-only); copy uses the injected clipboard or OSC52 and never a shell; priority updates the summary optimistically and rolls back on a single failed `issueUpdate`; comments are a one-line modal that reject blanks, write once with `commentCreate`, then invalidate and refetch the lazy detail; Board detail is full-width and Escape returns to Board; the detail pane renders Linear markdown through OpenTUI `MarkdownRenderable`, with `beautiful-mermaid` ASCII for `mermaid` fences; panes are transparent to the terminal background; mouse-first chrome with keyboard fallbacks; an Open chip (or silent `o`) launches the shown issue in the Linear desktop app via `linear://` locally; over SSH/Herdr remote it copies the https URL and shows that URL as plain text so Herdr's ctrl-click can open it on the attached machine; filters, view, and layout are session-only; requires interactive stdin and stdout; the compiled binary copies OpenTUI's native library out of Bun's embedded filesystem into `/tmp` before `dlopen`, so Infisical's agent-proxy sandbox can load it | full-screen terminal interface |
| `api [query]` | raw GraphQL. Query from arg or stdin. `--var k=v` (string), `--vars-json '{...}'`, `--paginate` (follows `pageInfo` on the single top-level connection), `--toon` re-encodes the response data as TOON | raw JSON `data` (or errors, exit 1) |
| `schema [pattern]` | search the embedded SDL: prints matching type headers and field lines with 1 line of context; `--type <Name>` prints the full type block; `--full` dumps everything | SDL fragments |
| `skill` | print an agent cheatsheet (SKILL.md shape) generated from the command registry at runtime — synopsis, flags, one example per command, the output contract, exit codes. `--install <dir>` writes `<dir>/SKILL.md` | markdown |
| `auth` | viewer identity, workspace, plan, and rate-limit budget from the last response's `X-RateLimit-*` headers | record |
| `cache` / `cache warm` / `cache clear` | inspect / refresh / delete the name cache | record / receipt |
| `completions bash\|zsh\|fish` | static completion script generated from the registry | script |

## Linear API notes (verified 2026-08-01)

- Endpoint: `POST https://api.linear.app/graphql`. Auth header: `Authorization: <LINEAR_API_KEY>` — no Bearer prefix for personal keys.
- Pagination: Relay style — `first/after`, `nodes`, `pageInfo { hasNextPage endCursor }`, `orderBy: updatedAt` for lists unless `--sort` says otherwise. Default page 50.
- Filters: typed inputs (`IssueFilter` etc.). String comparators include `eq, in, contains, containsIgnoreCase, startsWith`; combine with `and/or`; relations nest (`assignee: { isMe: { eq: true } }`, `state: { type: { nin: ["completed","canceled"] } }`, `labels: { some: { name: { eqIgnoreCase: "bug" } } }`).
- Full-text search: `searchIssues(term, first)`, `searchProjects`, `searchDocuments` — return nodes plus `totalCount`.
- Batch: `issueBatchUpdate(ids: [UUID], input)` — max 50 ids.
- Mutations take UUIDs, not `ENG-42` identifiers. `issue(id:)` queries accept either — use that for resolution.
- Sub-issue ordering: `issueUpdate(input: { subIssueSortOrder: Float })` positions a child under its parent. `sortOrder` is a different field for board/list position — do not confuse them.
- File upload: `fileUpload(contentType, filename, size)` → `{ uploadUrl, assetUrl, headers[] }` → HTTP `PUT` of the bytes to `uploadUrl` with the returned headers → then `attachmentCreate` with the `assetUrl`.
- Rate limits: 2,500 requests/hour and 3,000,000 complexity points/hour per API key; single-query cap 10,000 points. Complexity ≈ 0.1/scalar, 1/object, connections multiply by page size — this is why every query selects only the fields it prints. Budget headers: `X-RateLimit-Requests-Remaining`, `X-Complexity`, etc. On HTTP 400 with `RATELIMITED`, report when the window resets (exit 1).
- Timeouts: every GraphQL request has a 30s bound. The error is exit 1 and names timeout/reachability.
- Retries: one retry with short backoff on network errors and 5xx. Never retry 4xx, timeouts, or cancelled requests.
- Cycle sugar: `current/next/previous` resolve via the team's `activeCycle` and cycle numbers.
- Workflow state types: `triage, backlog, unstarted, started, completed, canceled` — `start`/`done`/`triage`/open-state filters key off `type`, never off state names.

## Architecture

```
src/
  main.ts        arg parsing + routing from the registry; bare-identifier dispatch
  registry.ts    defineCommand(): name, aliases, args, flags, help, examples, run()
  client.ts      fetch wrapper: auth, 30s timeout, AbortSignal, one retry, rate headers, GraphQL errors -> LinError
  config.ts      .lin.toml discovery + env + flag precedence
  cache.ts       meta cache read/write/TTL
  resolve.ts     exact name->id resolution for team/state/label/user/project/cycle/template/customer; issue identifier->UUID
  out.ts         the four shapes + exit codes; the ONLY module that prints
  commands/      one file per noun (issue.ts, issue-extra.ts, comment.ts, project.ts, milestone.ts, cycle.ts, initiative.ts, doc.ts, team.ts, user.ts, label.ts, template.ts, customer.ts, inbox.ts, aliases.ts, api.ts, schema.ts, skill.ts, auth.ts, cache-cmd.ts, completions.ts, tui.ts)
  tui/           OpenTUI browser: app, actions menu + comment composer, mouse-first board, issue list, markdown+mermaid detail, data, theme, native extract, desktop open, run
schema.graphql   pinned Linear SDL, embedded into the compiled binary
test/            bun test; harness stubs fetch; fixtures are SANITIZED synthetic shapes
```

- Queries are hand-written template strings colocated with their commands, selecting exactly the printed fields. Response types are hand-written minimal TS interfaces next to each query. No codegen, no `graphql` package at runtime.
- Commands never call `fetch`, never `console.log`, never `process.exit` — they use client/out. `out.ts` writes stdout/stderr and returns exit codes; `main.ts` exits.
- Registry entries carry help text and one example each; `skill`, `completions`, and `--help` all render from the registry so docs cannot drift.

## Conventions

- No emojis anywhere. No color. ASCII + UTF-8 punctuation only.
- Tests: every command gets at least one test — args in, expected GraphQL operation/variables out, expected rendered output (exact string). The fetch stub asserts on the operation name and returns fixtures.
- Fixtures are synthetic: real Linear response STRUCTURE, fake values (team ENG, users casey/alex, issues ENG-40..57, workspace acme). Never commit real workspace content, team keys, issue titles, names, or ids from a live workspace.
- Keep modules small and flat; no classes where a function does; no speculative abstraction; every export used.
- Errors in code paths agents hit must name the correction (the exit-2 discipline) — this is a feature, not polish.
