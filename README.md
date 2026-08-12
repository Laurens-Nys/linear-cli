# lin

`lin` is a Linear CLI for coding agents. Noninteractive commands print TOON, a tabular format an LLM reads at a fraction of the token cost of JSON. It ships as one binary with no runtime to install or config wizard. An explicit `lin tui` command provides a read-only terminal browser; every other command keeps the same automation-safe output in terminals and pipes.

## Why TOON

TOON (Token-Oriented Object Notation) names the columns once, then writes one row per record. A page of issues costs about half what the same JSON costs, and a model reads it without a parser. Long text never rides inside it: descriptions and comment bodies come out as raw markdown between `---` fences, because escaped newline strings are the most expensive thing you can put in a context window.

```
issues[3]{id,title,state,priority,updated}:
  ENG-42,Fix login redirect loop,In Progress,high,2026-07-30
  ENG-41,Rotate webhook secrets,Todo,medium,2026-07-29
  ENG-38,Upgrade to Bun 1.3,Todo,low,2026-07-28
```

## Install

Binaries and a Homebrew tap land with the first tagged release. Until then, build from source with [Bun](https://bun.sh):

```sh
git clone https://github.com/Laurens-Nys/linear-cli
cd linear-cli
bun install
bun run build
cp dist/lin ~/.local/bin/lin
```

## Quickstart

Create a personal API key in Linear under Settings, Security and access, then:

```sh
export LINEAR_API_KEY=lin_api_...
lin auth                 # who the key is, which workspace, how much rate budget is left
lin ls                   # my open issues, most recently updated first
lin ENG-42               # a bare identifier is always issue view
lin issue create --team ENG -t "Fix login redirect loop" --label Bug --assignee casey
lin tui                  # browse my open assigned issues interactively
```

## Read-only terminal browser

`lin tui` is the only interactive command. It opens a read-only list of open issues assigned to the authenticated viewer with a detail pane. Use the arrow keys or `j`/`k` to select an issue, click or scroll with the mouse, press `r` to refresh, and press `q` or Ctrl-C to quit. It must be run directly in an interactive terminal; use `lin ls` when piping output.

## The output contract

Noninteractive commands return one of four shapes. `lin tui` owns the terminal only when explicitly invoked and does not use these output shapes.

Lists are TOON tables. When a page is cut, the last line is a comment carrying the exact command that fetches the next one:

```
# 11 more · lin issue list --team ENG --after <cursor>
```

One record is `key: value` lines, then the markdown body between fences, then any sub-tables:

```
id: ENG-42
state: In Progress
assignee: casey
---
Users bounce between /login and /app when the session cookie is stale.
---
comments[1]{ref,author,date,body}:
  9f2ab41c,casey,2026-07-29,Repro: stale cookie, then any deep link
```

Writes return receipts. Creates print the new identifier and its URL; updates print only the fields that changed, read back from the response:

```
ENG-42:
  state: Todo -> In Progress
  assignee: none -> casey
```

Errors go to stderr and name the correction:

```
error: team ENG has no state "In Progress"
states: Triage, Todo, Doing, In Review, Done, Canceled
```

Exit codes are part of the contract: `0` ok, `1` API or network, `2` correctable input, `3` auth, `4` not found. Exit 2 always lists the valid values, so a caller can fix its own command.

## Commands

Full form is `lin <noun> <verb> [args] [flags]`. Top-level shortcuts cover the hot path: `lin ENG-42`, `lin ls`, `lin start`, `lin done`, `lin triage`, `lin search "term"`.

| noun | verbs |
|---|---|
| issue | list, view, create, update, archive, unarchive, delete, relate, unrelate, reorder, link, attach, branch, url, subscribe, unsubscribe |
| comment | list, add, edit, resolve, unresolve |
| project | list, view, create, update, post, posts |
| milestone | list, create, update, delete |
| cycle | list, view, create, update |
| initiative | list, view, create, update, add-project, rm-project, post, posts |
| doc | list, view, create, update |
| team | list, view, states |
| user | list, me |
| label | list, create, update, archive |
| template | list, view |
| customer | list, view, create, need add, need list |
| inbox | read, archive |
| meta | api, schema, auth, cache, skill, completions, tui |

`lin --help` prints every command your binary has, grouped by noun. `lin issue create -h` prints one command's arguments, flags and examples. `lin api` and `lin schema` reach the rest of Linear's API, the part no verb covers.

DESIGN.md is the full map: curated columns, filters and behaviour per command.

## Configuration

`lin` reads `.lin.toml` from the current directory, then the git root, then `~/.config/lin/config.toml`. The nearest file wins. Flat keys only:

```toml
team = "ENG"
limit = 50
```

`LINEAR_API_KEY` is the only way to authenticate, and it is never printed, logged or written to disk. `LIN_TEAM` and `LIN_LIMIT` override the files; flags override everything.

Name lookups for teams, states, labels, users, projects and templates resolve against a cache at `~/.cache/lin/<workspace>/meta.json` with a 24 hour life. `lin cache` shows its age, `lin cache warm` refreshes it, `lin cache clear` deletes it, and `--no-cache` skips it for one command.

## For agents

```sh
lin skill --install .claude/skills/linear
```

That writes a `SKILL.md` cheatsheet: the output contract, the exit codes, and every command with its synopsis and one worked example. Completions come from the same place:

```sh
lin completions zsh > ~/.zfunc/_lin
```

Help, `skill` and `completions` all render from one command registry at runtime, so none of them can drift from the commands that exist.

## Development

```sh
bun test          # unit tests, no network
bunx tsc --noEmit # types
bun run build     # dist/lin
```

## License

MIT. See LICENSE.
