// owned by: alias agent
// `lin skill` renders the agent cheatsheet from the registry at runtime, so it
// cannot drift from the commands that exist. The renderer takes the command
// list as an argument: nothing here knows which commands are registered.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EXIT, LinError, raw, simpleReceipt } from "../out.ts";
import {
  allCommands,
  defineCommand,
  flagString,
  GLOBAL_FLAGS,
  type ArgSpec,
  type CommandSpec,
  type FlagSpec,
} from "../registry.ts";

/** Beyond this many command flags the synopsis says `...` and defers to -h. */
const SYNOPSIS_FLAGS = 6;

const HEADER = `---
name: linear
description: Manage Linear from the shell with the lin CLI - read, create, update and search issues, projects, cycles, docs and comments.
---

# lin - Linear for coding agents

Output is TOON: YAML-adjacent, tabular, never JSON. Four shapes:

- list: \`issues[2]{id,title,state}:\` then one indented comma row per item; a trailing \`# 11 more · <exact next-page command>\` means the page was cut.
- record: \`key: value\` lines, the markdown body between \`---\` fences, then sub-tables like \`comments[2]{ref,author,date,body}:\`.
- receipt: creates print \`created: ENG-57\` plus \`url:\`; updates print \`ENG-42:\` then one indented \`state: Todo -> In Progress\` per changed field.
- error: stderr, \`error: team ENG has no state "In Progress"\` then a line naming the fix, here \`states: Triage, Todo, Doing, Done\`.

Empty fields are dropped, dates are YYYY-MM-DD, priority is a word (urgent|high|medium|low|none). No color, prompts or pager, piped or not.
Exit codes: 0 ok, 1 API or network, 2 correctable input (line two lists the valid values), 3 auth, 4 not found.
Auth: \`export LINEAR_API_KEY=<personal key>\`, else exit 3. Config \`.lin.toml\`: \`team = "ENG"\`, \`limit = 50\`; \`LIN_TEAM\`/\`LIN_LIMIT\` beat the file, flags beat both.
Shorthand: \`lin ENG-42\` is \`lin issue view ENG-42\`; an issue URL or UUID works anywhere an identifier does.
`;

function argToken(arg: ArgSpec): string {
  const name = arg.variadic ? `${arg.name}...` : arg.name;
  return arg.required ? `<${name}>` : `[${name}]`;
}

function flagToken(name: string, spec: FlagSpec): string {
  const label = spec.short ? `-${spec.short}` : `--${name}`;
  return spec.type === "boolean" ? label : `${label} ${spec.valueHint ?? "value"}`;
}

function flagLabel(name: string, spec: FlagSpec): string {
  const long = spec.type === "boolean" ? `--${name}` : `--${name} ${spec.valueHint ?? "value"}`;
  return spec.short ? `-${spec.short}, ${long}` : long;
}

/** `lin issue list [query] [--mine --assignee name ...]` */
export function synopsis(command: CommandSpec): string {
  const parts = [`lin ${command.name}`];
  for (const arg of command.args ?? []) parts.push(argToken(arg));

  const entries = Object.entries(command.flags ?? {});
  if (entries.length > 0) {
    const shown = entries.slice(0, SYNOPSIS_FLAGS).map(([name, spec]) => flagToken(name, spec));
    if (entries.length > shown.length) shown.push("...");
    parts.push(`[${shown.join(" ")}]`);
  }

  return parts.join(" ");
}

/** Groups in alphabetical order, commands inside a group by name. */
function byGroup(commands: readonly CommandSpec[]): Map<string, CommandSpec[]> {
  const sorted = [...commands].sort((a, b) => a.name.localeCompare(b.name));
  const groups = new Map<string, CommandSpec[]>();

  for (const group of [...new Set(sorted.map((command) => command.group))].sort()) {
    groups.set(
      group,
      sorted.filter((command) => command.group === group),
    );
  }

  return groups;
}

/**
 * The whole cheatsheet. Kept to two lines per command — synopsis with its
 * summary, then one worked example — because an agent pays for every line.
 */
export function renderSkill(commands: readonly CommandSpec[]): string {
  const out: string[] = [HEADER];

  out.push("| global flag | meaning |", "|---|---|");
  for (const [name, spec] of Object.entries(GLOBAL_FLAGS)) {
    out.push(`| \`${flagLabel(name, spec)}\` | ${spec.doc} |`);
  }

  for (const [group, members] of byGroup(commands)) {
    out.push("", `## ${group}`, "", "```");
    for (const command of members) {
      const aliases = command.aliases?.length ? ` (alias: ${command.aliases.join(", ")})` : "";
      out.push(`${synopsis(command)} - ${command.summary}${aliases}`);
      // An example that only repeats the synopsis is a line the caller pays for
      // twice; a command with no arguments and no flags has nothing to show.
      const example = command.examples[0];
      if (example && example !== `lin ${command.name}`) out.push(`  ${example}`);
    }
    out.push("```");
  }

  return `${out.join("\n")}\n`;
}

export default defineCommand({
  name: "skill",
  group: "meta",
  summary: "print an agent cheatsheet for every command, in SKILL.md shape",
  flags: {
    install: {
      type: "string",
      valueHint: "dir",
      doc: "write the cheatsheet to <dir>/SKILL.md instead of stdout",
    },
  },
  examples: ["lin skill", "lin skill --install .claude/skills/linear"],
  run({ flags }) {
    const text = renderSkill(allCommands());

    const dir = flagString(flags, "install");
    if (dir === undefined) {
      raw(text);
      return;
    }

    const target = resolve(dir);
    const path = join(target, "SKILL.md");
    try {
      mkdirSync(target, { recursive: true });
      writeFileSync(path, text, "utf8");
    } catch (cause) {
      throw new LinError(
        EXIT.input,
        `cannot write ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
        "pass --install <dir> pointing at a writable directory",
      );
    }

    simpleReceipt("installed", path);
  },
});
