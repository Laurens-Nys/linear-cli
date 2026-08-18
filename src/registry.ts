// The command registry. Plain data plus lookup functions: `--help`, `skill` and
// `completions` all render from here, so documentation cannot drift from code.

import type { Config } from "./config.ts";

export type FlagType = "string" | "boolean" | "number" | "repeatable";

export interface FlagSpec {
  type: FlagType;
  /** Single-letter form, without the dash. */
  short?: string;
  /** Placeholder shown in help, e.g. "KEY" in `--team KEY`. */
  valueHint?: string;
  /** One line, lower case, no trailing period. */
  doc: string;
  /**
   * Allows the flag to appear without a value, yielding `true`.
   * Used by `--fields`, which lists the available fields when bare.
   */
  bareOk?: boolean;
}

export interface ArgSpec {
  name: string;
  doc: string;
  required?: boolean;
  /** Accepts any number of trailing values, e.g. `issue update <id...>`. */
  variadic?: boolean;
}

export type FlagValue = string | number | boolean | string[];
export type Flags = Record<string, FlagValue>;

export interface RunContext {
  /** Positional arguments, after the command name and with flags removed. */
  args: string[];
  flags: Flags;
  /** `team` and `limit` resolved through flag > env > project > global. */
  config: Config;
  command: CommandSpec;
}

export interface CommandSpec {
  /** Full invocation, one or two words: "issue list", "auth". */
  name: string;
  /** Noun this command belongs to; groups the help output. */
  group: string;
  /** Top-level single-word shortcuts, e.g. "ls" for `issue list --mine`. */
  aliases?: string[];
  summary: string;
  args?: ArgSpec[];
  flags?: Record<string, FlagSpec>;
  /** `--all-pages` walks remaining pages of this command's list. */
  allPages?: boolean;
  /** Default table columns. Presence means `--fields` is supported. */
  fields?: readonly string[];
  /** Extra keys `--fields` may select beyond `fields`. */
  extra?: readonly string[];
  /** At least one, copy-pasteable, starting with "lin ". */
  examples: string[];
  run: (ctx: RunContext) => Promise<void> | void;
}

// --- global flags -----------------------------------------------------------

/** Available on every command; commands may not redeclare these names. */
export const GLOBAL_FLAGS: Record<string, FlagSpec> = {
  limit: { type: "number", short: "n", valueHint: "N", doc: "maximum rows to return (default 50)" },
  after: { type: "string", valueHint: "cursor", doc: "start from a pagination cursor" },
  "all-pages": {
    type: "boolean",
    doc: "fetch every remaining page of a paginated list command",
  },
  fields: {
    type: "string",
    valueHint: "a,b,c",
    doc: "select and order columns on a table command; bare lists them",
    bareOk: true,
  },
  team: { type: "string", valueHint: "KEY", doc: "team key, overriding config" },
  quiet: { type: "boolean", short: "q", doc: "receipts print the bare identifier only" },
  "no-cache": { type: "boolean", doc: "ignore the metadata cache and refetch" },
  help: { type: "boolean", short: "h", doc: "show help for this command" },
  version: { type: "boolean", doc: "print the version" },
};

// --- registry ---------------------------------------------------------------

const commands = new Map<string, CommandSpec>();
const aliases = new Map<string, string>();

export function defineCommand(spec: CommandSpec): CommandSpec {
  if (commands.has(spec.name)) throw new Error(`duplicate command: ${spec.name}`);
  for (const flag of Object.keys(spec.flags ?? {})) {
    if (flag in GLOBAL_FLAGS) throw new Error(`command ${spec.name} redeclares global flag --${flag}`);
  }
  commands.set(spec.name, spec);
  for (const alias of spec.aliases ?? []) {
    const existing = aliases.get(alias);
    if (existing) throw new Error(`duplicate alias ${alias}: ${existing} and ${spec.name}`);
    aliases.set(alias, spec.name);
  }
  return spec;
}

export function getCommand(name: string): CommandSpec | undefined {
  return commands.get(name);
}

export function allCommands(): CommandSpec[] {
  return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function allGroups(): string[] {
  return [...new Set(allCommands().map((command) => command.group))];
}

export function commandsInGroup(group: string): CommandSpec[] {
  return allCommands().filter((command) => command.group === group);
}

/** A noun the user can type, e.g. `issue` in `lin issue --help`. */
export function lookupGroup(name: string): string | undefined {
  return allGroups().includes(name) ? name : undefined;
}

export function allAliases(): Map<string, string> {
  return new Map(aliases);
}

export interface Lookup {
  command: CommandSpec;
  /** Tokens consumed from the front of argv by the command name or alias. */
  consumed: number;
}

/**
 * Resolve leading argv tokens to a command. Two-word names win over one-word
 * ones so `cache warm` beats `cache`.
 */
export function lookupCommand(tokens: readonly string[]): Lookup | undefined {
  const [first, second] = tokens;
  if (first === undefined) return undefined;

  if (second !== undefined) {
    const pair = commands.get(`${first} ${second}`);
    if (pair) return { command: pair, consumed: 2 };
  }

  const single = commands.get(first);
  if (single) return { command: single, consumed: 1 };

  const aliased = aliases.get(first);
  if (aliased) {
    const command = commands.get(aliased);
    if (command) return { command, consumed: 1 };
  }

  return undefined;
}

/** Every name a user could type, for "did you mean" and completions. */
export function knownNames(): string[] {
  return [...commands.keys(), ...aliases.keys()].sort();
}

/** Merged flag table for a command; command flags plus the globals. */
export function flagsFor(command: CommandSpec): Record<string, FlagSpec> {
  return { ...GLOBAL_FLAGS, ...command.flags };
}

/** Reset between tests. Never called by the CLI. */
export function clearRegistry(): void {
  commands.clear();
  aliases.clear();
}

// --- typed flag readers -----------------------------------------------------
// Commands use these instead of casting, so a wrong flag type is a loud error.

export function flagString(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

export function flagBool(flags: Flags, name: string): boolean {
  return flags[name] === true;
}

export function flagNumber(flags: Flags, name: string): number | undefined {
  const value = flags[name];
  return typeof value === "number" ? value : undefined;
}

export function flagList(flags: Flags, name: string): string[] {
  const value = flags[name];
  if (Array.isArray(value)) return value;
  return typeof value === "string" ? [value] : [];
}
