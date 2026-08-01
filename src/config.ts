// `.lin.toml` discovery and the flag > env > project > global precedence chain.
// Flat TOML only; there is no reason for this tool to grow a TOML dependency.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface Config {
  team?: string | undefined;
  limit?: number | undefined;
}

export const DEFAULT_LIMIT = 50;

export type TomlValue = string | number | boolean;

/**
 * Flat `key = value` TOML. Quoted strings, bare strings, numbers and booleans;
 * `#` starts a comment outside quotes. Tables and arrays are deliberately
 * unsupported: no key in DESIGN.md needs them.
 */
export function parseToml(text: string): Record<string, TomlValue> {
  const result: Record<string, TomlValue> = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("[")) continue;

    const equals = line.indexOf("=");
    if (equals === -1) continue;

    const key = line.slice(0, equals).trim();
    if (key === "") continue;
    let value = line.slice(equals + 1).trim();

    const quote = value[0];
    if (quote === '"' || quote === "'") {
      const close = value.indexOf(quote, 1);
      if (close === -1) continue; // unterminated string: skip the line
      result[key] = value.slice(1, close);
      continue;
    }

    const comment = value.indexOf("#");
    if (comment !== -1) value = value.slice(0, comment).trim();
    if (value === "") continue;

    if (value === "true" || value === "false") result[key] = value === "true";
    else if (/^-?\d+(?:\.\d+)?$/.test(value)) result[key] = Number(value);
    else result[key] = value;
  }

  return result;
}

function readToml(path: string): Record<string, TomlValue> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return parseToml(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Nearest ancestor directory containing `.git`, if any. */
export function findGitRoot(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env["XDG_CONFIG_HOME"];
  const base = xdg && xdg !== "" ? xdg : join(env["HOME"] ?? homedir(), ".config");
  return join(base, "lin", "config.toml");
}

/** Config files in precedence order, lowest first. */
export function configPaths(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const paths = [globalConfigPath(env)];
  const gitRoot = findGitRoot(cwd);
  if (gitRoot && gitRoot !== resolve(cwd)) paths.push(join(gitRoot, ".lin.toml"));
  paths.push(join(resolve(cwd), ".lin.toml"));
  return paths;
}

function pick(source: Record<string, TomlValue> | undefined, into: Config): void {
  if (!source) return;
  const team = source["team"];
  if (typeof team === "string" && team !== "") into.team = team;
  const limit = source["limit"];
  if (typeof limit === "number" && Number.isFinite(limit)) into.limit = limit;
}

/** File layer only: global, then git root, then cwd. Later files win. */
export function loadConfigFiles(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): Config {
  const config: Config = {};
  for (const path of configPaths(cwd, env)) pick(readToml(path), config);
  return config;
}

export interface ConfigOverrides {
  team?: string | undefined;
  limit?: number | undefined;
}

/**
 * The full chain: flags beat `LIN_TEAM`/`LIN_LIMIT`, which beat the project
 * file, which beats the global file.
 */
export function resolveConfig(
  overrides: ConfigOverrides = {},
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Config {
  const config = loadConfigFiles(cwd, env);

  const envTeam = env["LIN_TEAM"];
  if (envTeam && envTeam !== "") config.team = envTeam;

  const envLimit = env["LIN_LIMIT"];
  if (envLimit && envLimit !== "") {
    const parsed = Number(envLimit);
    if (Number.isFinite(parsed)) config.limit = parsed;
  }

  if (overrides.team !== undefined && overrides.team !== "") config.team = overrides.team;
  if (overrides.limit !== undefined && Number.isFinite(overrides.limit)) config.limit = overrides.limit;

  if (config.limit === undefined) config.limit = DEFAULT_LIMIT;
  return config;
}
