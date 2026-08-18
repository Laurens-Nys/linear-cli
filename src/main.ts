#!/usr/bin/env bun
// Argument parsing and routing. The only module that calls process.exit.

import pkg from "../package.json" with { type: "json" };
import "./commands/index.ts";
import { DEFAULT_LIMIT, parseLimitInput, resolveConfig } from "./config.ts";
import { EXIT, LinError, failFrom, line, resetFields, selectColumns, setFields, setQuiet, type ExitCode } from "./out.ts";
import {
  allCommands,
  allGroups,
  commandsInGroup,
  flagsFor,
  GLOBAL_FLAGS,
  knownNames,
  lookupCommand,
  lookupGroup,
  type CommandSpec,
  type FlagSpec,
  type Flags,
} from "./registry.ts";
import { issueIdentifierFrom } from "./resolve.ts";

export const VERSION: string = pkg.version;

// --- flag parsing -----------------------------------------------------------

export interface Parsed {
  args: string[];
  flags: Flags;
}

function shortIndex(specs: Record<string, FlagSpec>): Map<string, string> {
  const index = new Map<string, string>();
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.short) index.set(spec.short, name);
  }
  return index;
}

function unknownFlag(token: string, specs: Record<string, FlagSpec>): LinError {
  const names = Object.keys(specs)
    .sort()
    .map((name) => `--${name}`);
  return new LinError(EXIT.input, `unknown flag ${token}`, `flags: ${names.join(", ")}`);
}

function parseNumberFlag(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new LinError(EXIT.input, `--${name} needs a number, got "${value}"`, `example: --${name} 20`);
  }
  return parsed;
}

function assign(flags: Flags, name: string, spec: FlagSpec, value: string): void {
  if (spec.type === "number") {
    flags[name] = name === "limit" ? parseLimitInput(value, "--limit") : parseNumberFlag(name, value);
    return;
  }

  if (spec.type === "repeatable") {
    const current = flags[name];
    flags[name] = Array.isArray(current) ? [...current, value] : [value];
    return;
  }

  flags[name] = value;
}

/**
 * Hand-rolled because the shapes are small and a dependency here would be the
 * whole runtime footprint of the tool. `--` ends flag parsing.
 */
export function parseArgs(tokens: readonly string[], specs: Record<string, FlagSpec>): Parsed {
  const shorts = shortIndex(specs);
  const args: string[] = [];
  const flags: Flags = {};

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;

    if (token === "--") {
      args.push(...tokens.slice(index + 1));
      break;
    }

    if (!token.startsWith("-") || token === "-") {
      args.push(token);
      continue;
    }

    let name: string;
    let inline: string | undefined;

    if (token.startsWith("--")) {
      const equals = token.indexOf("=");
      name = equals === -1 ? token.slice(2) : token.slice(2, equals);
      inline = equals === -1 ? undefined : token.slice(equals + 1);
    } else {
      const equals = token.indexOf("=");
      const short = equals === -1 ? token.slice(1) : token.slice(1, equals);
      const mapped = shorts.get(short);
      if (mapped === undefined) throw unknownFlag(token, specs);
      name = mapped;
      inline = equals === -1 ? undefined : token.slice(equals + 1);
    }

    const spec = specs[name];
    if (spec === undefined) throw unknownFlag(token, specs);

    if (spec.type === "boolean") {
      if (inline !== undefined) {
        flags[name] = inline !== "false";
        continue;
      }
      flags[name] = true;
      continue;
    }

    if (inline !== undefined) {
      assign(flags, name, spec, inline);
      continue;
    }

    // Take the next token unless it is itself a recognised flag, so that a
    // typo like `--state --mine` reports a missing value instead of eating it.
    const next = tokens[index + 1];
    const nextIsFlag =
      next !== undefined &&
      next.startsWith("-") &&
      next !== "-" &&
      (next.startsWith("--")
        ? specs[next.slice(2).split("=")[0] as string] !== undefined
        : shorts.has(next.slice(1).split("=")[0] as string));

    if (next === undefined || nextIsFlag) {
      if (spec.bareOk) {
        flags[name] = true;
        continue;
      }
      throw new LinError(
        EXIT.input,
        `--${name} needs a value`,
        spec.valueHint ? `example: --${name} ${spec.valueHint}` : `pass a value after --${name}`,
      );
    }

    assign(flags, name, spec, next);
    index += 1;
  }

  return { args, flags };
}

// --- help -------------------------------------------------------------------

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function flagLabel(name: string, spec: FlagSpec): string {
  const short = spec.short ? `-${spec.short}, ` : "    ";
  const hint = spec.type === "boolean" ? "" : ` ${spec.valueHint ?? "value"}`;
  return `${short}--${name}${hint}`;
}

function flagLines(specs: Record<string, FlagSpec>): string[] {
  const entries = Object.entries(specs);
  const width = Math.max(0, ...entries.map(([name, spec]) => flagLabel(name, spec).length));
  return entries.map(([name, spec]) => `  ${pad(flagLabel(name, spec), width)}  ${spec.doc}`);
}

export function renderGlobalHelp(): string {
  const out: string[] = [
    "lin — Linear for coding agents",
    "",
    "usage: lin <noun> <verb> [args] [flags]",
  ];

  for (const group of allGroups()) {
    const commands = commandsInGroup(group);
    const width = Math.max(...commands.map((command) => command.name.length));
    out.push("", group);
    for (const command of commands) {
      const aliases = command.aliases?.length ? ` (${command.aliases.join(", ")})` : "";
      out.push(`  ${pad(command.name, width)}  ${command.summary}${aliases}`);
    }
  }

  out.push("", "global flags", ...flagLines(GLOBAL_FLAGS));
  out.push("", "lin ENG-42 is shorthand for lin issue view ENG-42");
  out.push("run lin <noun> -h for that noun's commands");
  out.push("run lin <command> -h for arguments and examples");
  return out.join("\n");
}

export function renderGroupHelp(group: string): string {
  const commands = commandsInGroup(group);
  const width = Math.max(...commands.map((command) => command.name.length));
  const prefix = `${group} `;
  const hasNounCommands = commands.some((command) => command.name === group || command.name.startsWith(prefix));
  const out: string[] = [
    `lin ${group}`,
    "",
    hasNounCommands ? `usage: lin ${group} <verb> [args] [flags]` : "usage: lin <command> [args] [flags]",
    "",
    "commands",
  ];
  for (const command of commands) {
    const aliases = command.aliases?.length ? ` (${command.aliases.join(", ")})` : "";
    out.push(`  ${pad(command.name, width)}  ${command.summary}${aliases}`);
  }
  out.push("", "global flags", ...flagLines(GLOBAL_FLAGS));
  out.push(
    "",
    hasNounCommands
      ? `run lin ${group} <verb> -h for arguments and examples`
      : "run lin <command> -h for arguments and examples",
  );
  return out.join("\n");
}

export function renderCommandHelp(command: CommandSpec): string {
  const usageArgs = (command.args ?? [])
    .map((arg) => {
      const name = arg.variadic ? `${arg.name}...` : arg.name;
      return arg.required ? `<${name}>` : `[${name}]`;
    })
    .join(" ");

  const out: string[] = [
    `lin ${command.name} — ${command.summary}`,
    "",
    `usage: lin ${command.name}${usageArgs ? ` ${usageArgs}` : ""} [flags]`,
  ];

  if (command.aliases?.length) out.push("", `aliases: ${command.aliases.join(", ")}`);

  if (command.args?.length) {
    const width = Math.max(...command.args.map((arg) => arg.name.length));
    out.push("", "args");
    for (const arg of command.args) out.push(`  ${pad(arg.name, width)}  ${arg.doc}`);
  }

  if (command.flags && Object.keys(command.flags).length > 0) {
    out.push("", "flags", ...flagLines(command.flags));
  }

  out.push("", "global flags", ...flagLines(GLOBAL_FLAGS));
  out.push("", "examples", ...command.examples.map((example) => `  ${example}`));
  return out.join("\n");
}

// --- dispatch ---------------------------------------------------------------

function supportedNames(ok: (command: CommandSpec) => boolean): string {
  return allCommands()
    .filter(ok)
    .map((command) => command.name)
    .join(", ");
}

/** Reject global flags this command does not honor, before any network. */
export function preflightGlobals(command: CommandSpec, flags: Flags): void {
  if (flags["all-pages"] === true && command.allPages !== true) {
    throw new LinError(
      EXIT.input,
      `--all-pages is not supported on ${command.name}`,
      `supported: ${supportedNames((item) => item.allPages === true)}`,
    );
  }

  if (flags["fields"] === undefined) return;
  if (command.fields === undefined) {
    throw new LinError(
      EXIT.input,
      `--fields is not supported on ${command.name}`,
      `supported: ${supportedNames((item) => item.fields !== undefined)}`,
    );
  }

  const requested = flags["fields"] === true ? true : typeof flags["fields"] === "string" ? flags["fields"] : undefined;
  // `--mine` already implies the viewer, so assignee is not a list column.
  const defaults =
    command.name === "issue list" && flags["mine"] === true
      ? command.fields.filter((field) => field !== "assignee")
      : command.fields;
  selectColumns(defaults, command.extra, requested);
}

function suggest(name: string): string {
  const lower = name.toLowerCase();
  const near = knownNames().filter(
    (candidate) => candidate.startsWith(lower) || candidate.includes(lower),
  );
  const shown = (near.length > 0 ? near : knownNames()).slice(0, 12);
  return `commands: ${shown.join(", ")}`;
}

export async function run(argv: readonly string[]): Promise<ExitCode> {
  const tokens = [...argv];

  if (tokens.length === 0 || tokens[0] === "-h" || tokens[0] === "--help") {
    line(renderGlobalHelp());
    return EXIT.ok;
  }

  if (tokens[0] === "--version") {
    line(VERSION);
    return EXIT.ok;
  }

  // A bare identifier or issue URL is always `issue view`.
  const first = tokens[0] as string;
  if (!first.startsWith("-") && issueIdentifierFrom(first) !== undefined) {
    tokens.unshift("issue", "view");
  }

  const found = lookupCommand(tokens);
  if (!found) {
    const group = lookupGroup(first);
    if (group) {
      const rest = tokens[1];
      if (rest === undefined || rest === "-h" || rest === "--help") {
        line(renderGroupHelp(group));
        return EXIT.ok;
      }
      throw new LinError(
        EXIT.input,
        `unknown command "${tokens.slice(0, 2).join(" ")}"`,
        `commands: ${commandsInGroup(group).map((command) => command.name).join(", ")}`,
      );
    }
    throw new LinError(EXIT.input, `unknown command "${tokens.slice(0, 2).join(" ")}"`, suggest(first));
  }

  const specs = flagsFor(found.command);
  const { args, flags } = parseArgs(tokens.slice(found.consumed), specs);

  if (flags["help"] === true) {
    line(renderCommandHelp(found.command));
    return EXIT.ok;
  }

  if (flags["version"] === true) {
    line(VERSION);
    return EXIT.ok;
  }

  setQuiet(flags["quiet"] === true);

  try {
    preflightGlobals(found.command, flags);
    setFields(flags["fields"]);

    const team = typeof flags["team"] === "string" ? flags["team"] : undefined;
    const limit = typeof flags["limit"] === "number" ? flags["limit"] : undefined;
    // `selfConfig` commands diagnose a broken file; they must not die here.
    const config = found.command.selfConfig
      ? { limit: DEFAULT_LIMIT }
      : resolveConfig({ team, limit });

    await found.command.run({ args, flags, config, command: found.command });
    return EXIT.ok;
  } finally {
    resetFields();
  }
}

async function main(): Promise<void> {
  let code: ExitCode = EXIT.ok;
  try {
    code = await run(process.argv.slice(2));
  } catch (error) {
    code =
      error instanceof LinError
        ? failFrom(error)
        : failFrom(
            new LinError(EXIT.api, error instanceof Error ? error.message : String(error)),
          );
  }
  process.exit(code);
}

if (import.meta.main) await main();
