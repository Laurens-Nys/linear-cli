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
export const MAX_LIMIT = 250;
export const LIMIT_RANGE = "an integer from 1 to 250";
export const LIMIT_HINT = "example: --limit 20";

export type TomlValue = string | number | boolean;

const CONFIG_KEYS = ["team", "limit"] as const;

function displayValue(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : String(value);
}

function failConfig(source: string, line: number, message: string, hint: string): never {
  throw new LinError(EXIT.input, `${source}:${line}: ${message}`, hint);
}

function limitError(name: string, raw: string): LinError {
  return new LinError(EXIT.input, `${name} must be ${LIMIT_RANGE}, got "${raw}"`, LIMIT_HINT);
}

/** Shared validation for file, env, flag, and override limits. */
export function parseLimit(value: number | string, name: string): number {
  if (typeof value === "string") {
    const raw = value.trim();
    if (!/^-?\d+$/.test(raw)) throw limitError(name, value);
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) throw limitError(name, raw);
    return parsed;
  }
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) throw limitError(name, String(value));
  return value;
}

/** Shared wording for `--limit` and `LIN_LIMIT`. */
export function parseLimitInput(raw: string, name: string): number {
  return parseLimit(raw, name);
}

function parseLimitValue(value: TomlValue, source: string, line: number): number {
  try {
    if (typeof value === "number" || typeof value === "string") return parseLimit(value, "limit");
    throw limitError("limit", String(value));
  } catch (error) {
    if (error instanceof LinError) failConfig(source, line, error.message, error.hint ?? LIMIT_HINT);
    throw error;
  }
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
  if (overrides.limit !== undefined) config.limit = parseLimit(overrides.limit, "--limit");

  if (config.limit === undefined) config.limit = DEFAULT_LIMIT;
  return config;
}
