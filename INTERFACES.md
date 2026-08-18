# INTERFACES.md — building commands on the `lin` foundation

Read `DESIGN.md` first. It is the contract: output shapes, exit codes, curated columns, command inventory. This file is how you use the foundation to satisfy it.

## The rule that matters most

**You edit only your own files.** Four agents work in parallel on one repo.

| Agent | Owns `src/commands/` | Owns `test/` |
|---|---|---|
| issue | `issue.ts`, `issue-extra.ts`, `comment.ts` | `issue*.test.ts`, `comment.test.ts` |
| project | `project.ts`, `milestone.ts`, `cycle.ts`, `initiative.ts`, `doc.ts` | `project.test.ts`, `milestone.test.ts`, `cycle.test.ts`, `initiative.test.ts`, `doc.test.ts` |
| workspace | `team.ts`, `user.ts`, `label.ts`, `template.ts`, `customer.ts`, `inbox.ts` | `team.test.ts`, `user.test.ts`, `label.test.ts`, `template.test.ts`, `customer.test.ts`, `inbox.test.ts` |
| alias | `aliases.ts`, `skill.ts`, `completions.ts` | `aliases.test.ts`, `skill.test.ts`, `completions.test.ts` |

Never edit `main.ts`, `registry.ts`, `client.ts`, `out.ts`, `config.ts`, `cache.ts`, `resolve.ts`, `commands/index.ts`, `test/harness.ts`, or `test/fixtures.ts`. Every file you need is already imported by `commands/index.ts`; adding a command never touches a shared file. If you believe a shared file must change, say so in your report instead of changing it.

## Three hard prohibitions

Commands never call `fetch`, never call `console.log` or `process.stdout.write`, and never call `process.exit`. Use `client.gql`, the `out.ts` printers, and `throw new LinError(...)`. `main.ts` is the only module that exits.

## defineCommand

```ts
import { gql } from "../client.ts";
import { table, LinError, EXIT } from "../out.ts";
import { defineCommand, flagBool, flagString } from "../registry.ts";
import { resolveTeam, resolveUser } from "../resolve.ts";

const LIST_QUERY = `query LinIssueList($filter: IssueFilter, $first: Int) {
  issues(filter: $filter, first: $first, orderBy: updatedAt) {
    nodes { identifier title state { name } assignee { displayName } priority updatedAt }
    pageInfo { hasNextPage endCursor }
  }
}`;

interface ListResponse {
  issues: {
    nodes: {
      identifier: string;
      title: string;
      state: { name: string };
      assignee: { displayName: string } | null;
      priority: number;
      updatedAt: string;
    }[];
    pageInfo: { hasNextPage: boolean; endCursor: string };
  };
}

export default defineCommand({
  name: "issue list",           // one or two words; two-word names win at lookup
  group: "issue",               // groups the help output
  aliases: ["ls"],              // optional top-level single-word shortcuts
  summary: "list issues",       // one line, lower case, no trailing period
  args: [{ name: "query", doc: "free text to match" }],
  flags: {
    mine: { type: "boolean", doc: "only issues assigned to me" },
    assignee: { type: "string", valueHint: "name", doc: "filter by assignee" },
    label: { type: "repeatable", valueHint: "name", doc: "filter by label; repeat to AND" },
  },
  examples: ["lin issue list --mine", "lin issue list --team ENG --label Bug"],
  async run({ args, flags, config }) {
    const team = await resolveTeam(config.team);
    const assignee = flagBool(flags, "mine") ? await resolveUser("me") : undefined;

    const data = await gql<ListResponse>(LIST_QUERY, {
      filter: { team: { id: { eq: team.id } }, ...(assignee && { assignee: { id: { eq: assignee.id } } }) },
      first: config.limit,
    });

    const rows = data.issues.nodes.map((node) => ({
      id: node.identifier,
      title: node.title,
      state: node.state.name,
      assignee: node.assignee?.displayName,
      priority: node.priority,
      updated: node.updatedAt,
    }));

    table("issues", rows, ["id", "title", "state", "assignee", "priority", "updated"]);
  },
});
```

Flag types are `string | boolean | number | repeatable`. `repeatable` yields `string[]`. `bareOk: true` lets a flag appear without a value (it becomes `true`); only `--fields` uses it. Declaring a flag that collides with a global one throws at import, so the whole CLI fails loudly rather than silently shadowing.

Read flags with the typed helpers — `flagString`, `flagBool`, `flagNumber`, `flagList` — never by casting.

Global flags arrive in `ctx.flags` already parsed: `fields`, `limit` (`-n`), `all-pages`, `after`, `team`, `quiet` (`-q`), `no-cache`, `help` (`-h`), `version`. `ctx.config` gives you `team` and `limit` already resolved through flag > env > project file > global file, so prefer `config.team` and `config.limit` over reading the flags yourself. `--all` is not global; only inbox commands declare it.

`--fields` and `--all-pages` are rejected in `main.ts` before config resolution or `run` unless the command opts in. Set `fields: ["id", "title", ...]` (and optional `extra`) on every pure table command; set `allPages: true` only on `issue list`, `ls`, `triage`, `comment`, and `search`. Bare or invalid `--fields` is validated against that list before any network. `table()` still projects the chosen columns. Non-table commands must not accept `--fields`. Use `collectPages` on connections that expose `pageInfo`; a missing or repeated cursor is exit 1. `lin api --paginate` uses the same cursor contract.

## out.ts — the only printer

```ts
table(key, rows, columns, { more, extra })   // shape 1; extra = optional --fields keys
record(fields, { body, children })    // shape 2
created(identifier, url)              // shape 3, create
changed(identifier, changes)          // shape 3, update diff
simpleReceipt(label, identifier)      // shape 3, archived/deleted/...
line(text)                            // one bare line (issue branch, issue url)
raw(text)                             // verbatim, no newline added
```

- `columns` both selects and orders the printed fields; extra keys on a row are dropped. `--fields` overrides that list from the intersection of `columns` plus `options.extra`, in the requested order. Absent `--fields` keeps `columns` byte-for-byte.
- Values are formatted for you: ISO timestamps collapse to `YYYY-MM-DD`, a field named `priority` holding a number renders as `none/urgent/high/medium/low`, `null` and `undefined` become empty cells, and in records empty fields are omitted entirely. Pass raw API values; do not pre-format.
- `changes` is `{ field, from, to }[]`. Empty sides render as `none`. Take `from`/`to` from the mutation's read-back response, never from the arguments.
- `{ more: { count, command } }` appends `# N more · <command>`; `command` must be the exact runnable continuation.
- `-q` is handled inside the printers; do not branch on it yourself.
- Bodies (descriptions, document content) go in `body`, never into a field. TOON has no multiline string; escaped `\n` is banned from our output.
- `priorityWord(n)` and `priorityNumber(word)` are exported for `--priority` flags.

Every error is a `LinError(exitCode, message, hint?)` and every correctable one names the correction:

```ts
throw new LinError(EXIT.input, `team ENG has no state "${name}"`, `states: ${names.join(", ")}`);
```

`EXIT` is `{ ok: 0, api: 1, input: 2, auth: 3, notFound: 4 }`. Exit 2 means the caller can fix it — list the candidates. Never fuzzy-match silently.

## client.gql

```ts
const data = await gql<Response>(document, variables);        // throws LinError on any error
const envelope = await gqlRaw<Response>(document, variables); // returns GraphQL errors instead
```

Auth, the single retry on network errors and 5xx, rate-limit headers, and the mapping of Linear errors onto exit codes are all handled. Write the query as a template string next to the command and a minimal hand-written response interface beside it. Select only the fields you print — complexity is billed per field, and the single-query cap is 10,000 points.

Name every operation (`query LinIssueList(...)`) — the test harness matches on that name.

## resolve.*

Exact, case-insensitive lookups against the cache. A miss refreshes once, then throws exit 2 with candidates. All take an optional final `{ noCache, env }`.

```ts
resolveTeam(ref: string | undefined)            => CachedTeam        // undefined ref => exit 2 naming --team
resolveState(teamRef, name)                     => CachedState
resolveStateByType(teamRef, type)               => CachedState       // lowest position wins
resolveUser(ref)                                => CachedUser        // "me" resolves to the viewer
resolveLabel(teamRef | null, name)              => CachedLabel       // accepts "group/label"
resolveProject(nameOrSlugOrId)                  => CachedProject
resolveTemplate(ref, teamRef?)                  => CachedTemplate
resolveCycle(teamRef, "current"|"next"|"previous"|number) => ResolvedCycle  // fetched live
resolveIssueUUID(identifierOrUrlOrUuid)         => string            // one lookup unless already a UUID
issueIdentifierFrom(ref)                        => string | undefined
issueIdentifierFromBranch(branch)               => string | undefined
```

Mutations take UUIDs, so run `resolveIssueUUID` before any write. `start`, `done` and triage filters must key off state **type**, never off state names — names differ per team.

## Tests

Every command gets at least one test: arguments in, expected operation and variables out, expected rendered output as an exact string. Tests never touch the network.

Any command that calls `resolve.*` reads the metadata cache, so seed it first — otherwise the resolver fires a `LinWarm` request and the mock reports no match.

```ts
import { describe, expect, test } from "bun:test";
import { toMeta, writeCached } from "../src/cache.ts";
import { keyFingerprint } from "../src/client.ts";
import issueList from "../src/commands/issue.ts";
import { captureStdout, mock, sandbox } from "./harness.ts";
import { WARM_DATA } from "./fixtures.ts";

test("lists issues as a TOON table", async () => {
  const box = sandbox();
  // Seed a fresh cache so resolveTeam("ENG") answers without a request.
  writeCached(
    { ...toMeta(WARM_DATA, keyFingerprint(box.env)), fetchedAt: new Date().toISOString() },
    box.env,
  );

  const stub = mock([
    {
      match: "LinIssueList",
      data: {
        issues: {
          nodes: [
            {
              identifier: "ENG-42",
              title: "Fix login redirect loop",
              state: { name: "In Progress" },
              assignee: { displayName: "casey" },
              priority: 2,
              updatedAt: "2026-07-30T09:15:00.000Z",
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: "c1" },
        },
      },
    },
  ]);
  const captured = captureStdout();

  try {
    await issueList.run({
      args: [],
      flags: {},
      config: { team: "ENG", limit: 50 },
      command: issueList,
    });
    captured.restore();

    expect(stub.calls[0]?.operation).toBe("LinIssueList");
    expect(stub.calls[0]?.variables).toMatchObject({ first: 50 });
    expect(captured.text()).toBe(
      "issues[1]{id,title,state,assignee,priority,updated}:\n" +
        "  ENG-42,Fix login redirect loop,In Progress,casey,high,2026-07-30\n",
    );
  } finally {
    captured.restore();
    stub.restore();
    box.cleanup();
  }
});
```

Harness API:

- `mock(responses)` replaces the client's fetch. Each entry is `{ match, data?, errors?, status?, headers?, networkError? }`, where `match` is an operation name or any substring of the document. Entries are consumed in order, so listing the same matcher twice describes a sequence; once all are consumed the last match repeats. Returns `{ calls, restore() }` with `calls[i] = { document, variables, operation }`. Always `restore()` in a `finally`.
- `captureStdout()` returns `{ text(), restore() }`.
- `sandbox()` returns `{ env, dir, cleanup() }` with a private cache directory and a fake `LINEAR_API_KEY`. It also installs those values into `process.env` and restores them on `cleanup()`, so a command that calls `resolve.*` with no env argument still reads the sandbox rather than your real cache. Always `cleanup()` in a `finally`. Seed cached metadata with `writeCached(toMeta(WARM_DATA, keyFingerprint(box.env)), box.env)` — see `test/resolve.test.ts`.

Fixtures live in `test/fixtures.ts` and are synthetic — workspace `acme`, teams ENG and DES, users casey and alex, issues ENG-40..57 — with real Linear response structure. Extend them by adding new exports to your own test file, not by editing `fixtures.ts`. Never commit a real workspace's names, ids, keys or issue titles.

## Before you report done

`bun test`, `bunx tsc --noEmit`, and `bun run build` all clean. Curated columns must match the `DESIGN.md` inventory table exactly — they are the contract, and changing one later is a breaking change.
