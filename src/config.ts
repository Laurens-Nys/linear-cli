// `.lin.toml` discovery and the flag > env > project > global precedence chain.
// Flat TOML only; there is no reason for this tool to grow a TOML dependency.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { EXIT, LinError } from "./out.ts";

export interface Config {
  team?: string | undefined;
  limit?: number | undefined;
}

export const DEFAULT_LIMIT = 50;

export type TomlValue = string | number | boolean;

const CONFIG_KEYS = ["team", "limit"] as const;

function displayValue(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : String(value);
}

function failConfig(source: string, line: number, message: string, hint: string): never {
  throw new LinError(EXIT.input, `${source}:${line}: ${message}`, hint);
}

/** Shared wording for `--limit` and `LIN_LIMIT`. */
export function parseLimitInput(raw: string, name: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new LinError(EXIT.input, `${name} needs a number, got "${raw}"`, "example: --limit 20");
  }
  return parsed;
}

function parseLimitValue(value: TomlValue, source: string, line: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  failConfig(source, line, `limit needs a number, got ${displayValue(value)}`, "example: --limit 20");
}

/**
 * Flat `key = value` TOML. Quoted strings, bare strings, numbers and booleans;
 * `#` starts a comment outside quotes. Tables and arrays are deliberately
 * unsupported: no key in DESIGN.md needs them. Unknown keys and malformed
 * lines fail with the source path and line.
 */
export function parseToml(text: string, source = "config"): Record<string, TomlValue> {
  const result: Record<string, TomlValue> = {};

  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1;
    const line = (lines[index] ?? "").trim();
    if (line === "" || line.startsWith("#")) continue;

    if (line.startsWith("[")) {
      failConfig(source, lineNo, "tables are not supported", 'use flat keys, for example team = "ENG"');
    }

    const equals = line.indexOf("=");
    if (equals === -1) {
      failConfig(
        source,
        lineNo,
        "malformed line",
        'use key = value, for example team = "ENG"',
      );
    }

    const key = line.slice(0, equals).trim();
    if (key === "") {
      failConfig(
        source,
        lineNo,
        "malformed line",
        'use key = value, for example team = "ENG"',
      );
    }

    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      failConfig(source, lineNo, `unknown key ${key}`, "supported keys: team, limit");
    }

    let value = line.slice(equals + 1).trim();
    const quote = value[0];
    let parsed: TomlValue;
    if (quote === '"' || quote === "'") {
      const close = value.indexOf(quote, 1);
      if (close === -1) {
        failConfig(
          source,
          lineNo,
          `unterminated string for ${key}`,
          `close the ${quote} or use ${key} = ${key === "limit" ? "50" : '"ENG"'}`,
        );
      }
      parsed = value.slice(1, close);
    } else {
      const comment = value.indexOf("#");
      if (comment !== -1) value = value.slice(0, comment).trim();
      if (value === "") {
        failConfig(
          source,
          lineNo,
          `missing value for ${key}`,
          `example: ${key} = ${key === "limit" ? "50" : '"ENG"'}`,
        );
      }
      if (value === "true" || value === "false") parsed = value === "true";
      else if (/^-?\d+(?:\.\d+)?$/.test(value)) parsed = Number(value);
      else parsed = value;
    }

    if (key === "team") {
      if (typeof parsed !== "string" || parsed === "") {
        failConfig(source, lineNo, `team needs a string, got ${displayValue(parsed)}`, 'example: team = "ENG"');
      }
      result[key] = parsed;
      continue;
    }

    result[key] = parseLimitValue(parsed, source, lineNo);
  }

  return result;
}

function readToml(path: string): Record<string, TomlValue> | undefined {
  if (!existsSync(path)) return undefined;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new LinError(EXIT.input, `cannot read config ${path}`, "check that the path is a readable file");
  }
  return parseToml(text, path);
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
    config.limit = parseLimitInput(envLimit, "LIN_LIMIT");
  }

  if (overrides.team !== undefined && overrides.team !== "") config.team = overrides.team;
  if (overrides.limit !== undefined && Number.isFinite(overrides.limit)) config.limit = overrides.limit;

  if (config.limit === undefined) config.limit = DEFAULT_LIMIT;
  return config;
}
