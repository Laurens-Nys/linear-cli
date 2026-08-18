// Bounded setup checks for `lin doctor`. Each check is injectable so tests
// never need a network, a TUI, or the developer's real cache.

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cacheAge, cacheRoot, isFresh, readCached, type Meta } from "./cache.ts";
import { lastRateInfo, MISSING_API_KEY_HINT, gql, type RateInfo } from "./client.ts";
import { resolveConfig, type Config } from "./config.ts";
import { LinError } from "./out.ts";
import { MISSING_TEAM_HINT } from "./resolve.ts";
import { loadNativeLibrary, materializeNativeLibrary } from "./tui/native.ts";
import { isRemoteSession } from "./tui/open.ts";

export const DOCTOR_COLUMNS = ["check", "status", "detail", "fix"] as const;

export type DoctorStatus = "pass" | "fail" | "warn" | "skip";

export interface DoctorRow {
  check: string;
  status: DoctorStatus;
  detail: string;
  fix: string;
  [key: string]: string;
}

export interface DoctorViewer {
  name: string;
  organization: { urlKey: string; name: string };
}

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: number;
  config?: Config;
  loadConfig?: () => Config;
  queryAuth?: () => Promise<DoctorViewer>;
  rateInfo?: RateInfo | null;
  readCache?: (env?: NodeJS.ProcessEnv) => Meta | null;
  probeWrite?: (root: string) => { ok: boolean; error?: string };
  materializeNative?: () => Promise<string | undefined>;
  loadNative?: (path: string) => void;
  fontMatches?: (env: NodeJS.ProcessEnv) => string[];
  remote?: boolean;
}

export interface DoctorResult {
  rows: DoctorRow[];
  failedRequired: boolean;
  failing: string[];
}

const AUTH_QUERY = `query LinDoctorAuth {
  viewer { id name email organization { urlKey name } }
}`;

const REQUIRED = new Set(["api-key", "linear", "config", "tui-native"]);

const FONT_NAME = /material\s*design\s*icons|materialdesignicons/i;
const FONT_EXT = /\.(ttf|otf|woff2?|ttc)$/i;
const FONT_WALK_BUDGET = 200;
const FONT_WALK_DEPTH = 2;

const INSTALL_FONTS_FIX =
  "brew install --cask font-material-design-icons-webfont on the machine that renders the terminal";

function keyValue(env: NodeJS.ProcessEnv): string | undefined {
  const key = env["LINEAR_API_KEY"];
  if (key === undefined || key.trim() === "") return undefined;
  return key.trim();
}

function redact(text: string, secret: string | undefined): string {
  if (!secret || secret === "" || !text.includes(secret)) return text;
  return text.split(secret).join("[redacted]");
}

function redactRow(row: DoctorRow, secret: string | undefined): DoctorRow {
  return {
    ...row,
    detail: redact(row.detail, secret),
    fix: redact(row.fix, secret),
  };
}

function causeMessage(cause: unknown): string {
  if (cause instanceof LinError) return cause.message;
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

function causeFix(cause: unknown, fallback: string): string {
  return cause instanceof LinError && cause.hint ? cause.hint : fallback;
}

function requiredFail(row: DoctorRow): boolean {
  return row.status === "fail" && REQUIRED.has(row.check);
}

export function checkApiKey(env: NodeJS.ProcessEnv = process.env): DoctorRow {
  if (keyValue(env) !== undefined) {
    return { check: "api-key", status: "pass", detail: "set", fix: "" };
  }
  return { check: "api-key", status: "fail", detail: "not set", fix: MISSING_API_KEY_HINT };
}

export async function checkLinear(options: {
  env?: NodeJS.ProcessEnv;
  hasKey: boolean;
  queryAuth?: () => Promise<DoctorViewer>;
}): Promise<DoctorRow> {
  if (!options.hasKey) {
    return {
      check: "linear",
      status: "skip",
      detail: "no API key",
      fix: "set LINEAR_API_KEY and rerun lin doctor",
    };
  }

  try {
    const viewer = options.queryAuth
      ? await options.queryAuth()
      : (await gql<{ viewer: DoctorViewer }>(AUTH_QUERY, undefined, { env: options.env })).viewer;
    return {
      check: "linear",
      status: "pass",
      detail: `${viewer.name} @ ${viewer.organization.urlKey}`,
      fix: "",
    };
  } catch (cause) {
    return {
      check: "linear",
      status: "fail",
      detail: causeMessage(cause),
      fix: causeFix(cause, "check network connectivity and that LINEAR_API_KEY is a current personal API key"),
    };
  }
}

export function checkRate(rate: RateInfo | null): DoctorRow {
  const hasBudget =
    rate !== null &&
    (rate.requestsRemaining !== undefined ||
      rate.requestsLimit !== undefined ||
      rate.complexityRemaining !== undefined ||
      rate.complexityLimit !== undefined);
  if (!hasBudget) {
    return { check: "rate", status: "skip", detail: "no rate headers", fix: "" };
  }

  const parts: string[] = [];
  if (rate.requestsRemaining !== undefined && rate.requestsLimit !== undefined) {
    parts.push(`${rate.requestsRemaining}/${rate.requestsLimit} requests`);
  } else if (rate.requestsRemaining !== undefined) {
    parts.push(`${rate.requestsRemaining} requests remaining`);
  }
  if (rate.complexityRemaining !== undefined && rate.complexityLimit !== undefined) {
    parts.push(`${rate.complexityRemaining}/${rate.complexityLimit} complexity`);
  }
  if (rate.requestsReset) parts.push(`reset ${rate.requestsReset}`);

  if (rate.requestsRemaining === 0 || rate.complexityRemaining === 0) {
    return {
      check: "rate",
      status: "warn",
      detail: parts.join(", "),
      fix: "wait for the rate limit window to reset",
    };
  }

  return { check: "rate", status: "pass", detail: parts.join(", "), fix: "" };
}

export function checkConfig(options: {
  config?: Config;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  loadConfig?: () => Config;
}): DoctorRow {
  try {
    const loaded = options.loadConfig?.() ?? options.config ?? resolveConfig({}, options.cwd, options.env);
    if (loaded.team && loaded.team !== "") {
      return { check: "config", status: "pass", detail: `team ${loaded.team}`, fix: "" };
    }
    return { check: "config", status: "warn", detail: "no default team", fix: MISSING_TEAM_HINT };
  } catch (cause) {
    return {
      check: "config",
      status: "fail",
      detail: causeMessage(cause),
      fix: causeFix(cause, 'fix .lin.toml; example: team = "ENG"'),
    };
  }
}

/** Create and delete only an owned probe file under the cache root. */
export function probeCacheWrite(root: string): { ok: boolean; error?: string } {
  const name = `.lin-doctor-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const path = join(root, name);
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(path, "ok\n", { flag: "wx" });
    return { ok: true };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    try {
      rmSync(path, { force: true });
    } catch {
      // The probe must not linger even when the write failed.
    }
  }
}

export function checkCache(options: {
  env?: NodeJS.ProcessEnv;
  now?: number;
  readCache?: (env?: NodeJS.ProcessEnv) => Meta | null;
  probeWrite?: (root: string) => { ok: boolean; error?: string };
}): DoctorRow {
  const env = options.env ?? process.env;
  const meta = (options.readCache ?? readCached)(env);
  const root = cacheRoot(env);
  const probe = (options.probeWrite ?? probeCacheWrite)(root);

  const parts: string[] = [];
  if (!meta) {
    parts.push("empty");
  } else {
    const age = cacheAge(meta.fetchedAt, options.now);
    const stale = !isFresh(meta, options.now);
    parts.push(meta.workspace.urlKey, `age ${age}${stale ? " stale" : ""}`);
  }
  parts.push(probe.ok ? "writable" : "not writable");

  const detail = parts.join(", ");
  if (!probe.ok) {
    return {
      check: "cache",
      status: "warn",
      detail,
      fix: `cache root ${root} is not writable`,
    };
  }
  if (!meta) {
    return { check: "cache", status: "warn", detail, fix: "run lin cache warm" };
  }
  if (!isFresh(meta, options.now)) {
    return { check: "cache", status: "warn", detail, fix: "run lin cache warm" };
  }
  return { check: "cache", status: "pass", detail, fix: "" };
}

export async function checkNative(options: {
  materialize?: () => Promise<string | undefined>;
  load?: (path: string) => void;
} = {}): Promise<DoctorRow> {
  try {
    const dest = await (options.materialize ?? materializeNativeLibrary)();
    if (!dest) {
      return {
        check: "tui-native",
        status: "skip",
        detail: "no embedded native library",
        fix: "compile lin with bun run build to bundle the OpenTUI native library",
      };
    }
    if (!existsSync(dest) || statSync(dest).size === 0) {
      return {
        check: "tui-native",
        status: "fail",
        detail: "extracted library is missing or empty",
        fix: "delete /tmp/lin-opentui and rerun lin doctor",
      };
    }
    try {
      (options.load ?? loadNativeLibrary)(dest);
    } catch (cause) {
      return {
        check: "tui-native",
        status: "fail",
        detail: causeMessage(cause),
        fix: "delete /tmp/lin-opentui and rerun lin doctor, or reinstall lin",
      };
    }
    return { check: "tui-native", status: "pass", detail: dest, fix: "" };
  } catch (cause) {
    return {
      check: "tui-native",
      status: "fail",
      detail: causeMessage(cause),
      fix: "ensure /tmp is writable, then rerun lin doctor",
    };
  }
}

export function fontSearchRoots(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const home = env["HOME"] && env["HOME"] !== "" ? env["HOME"] : homedir();
  if (platform === "darwin") {
    return [join(home, "Library", "Fonts"), "/Library/Fonts", "/System/Library/Fonts"];
  }
  if (platform === "win32") {
    const local = env["LOCALAPPDATA"] ?? "";
    return [local ? join(local, "Microsoft", "Windows", "Fonts") : "", "C:\\Windows\\Fonts"].filter((dir) => dir !== "");
  }
  return [join(home, ".local", "share", "fonts"), join(home, ".fonts"), "/usr/local/share/fonts", "/usr/share/fonts"];
}

function walkFontMatches(dir: string, depth: number, hits: string[], budget: { left: number }): void {
  if (budget.left <= 0 || depth < 0) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (budget.left <= 0) return;
    budget.left -= 1;
    const path = join(dir, entry.name);
    if (entry.isFile() && FONT_NAME.test(entry.name) && FONT_EXT.test(entry.name)) {
      hits.push(path);
      return;
    }
    if (entry.isDirectory() && depth > 0) walkFontMatches(path, depth - 1, hits, budget);
  }
}

export function findFontMatches(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  roots?: string[],
): string[] {
  const hits: string[] = [];
  const budget = { left: FONT_WALK_BUDGET };
  for (const dir of roots ?? fontSearchRoots(env, platform)) {
    walkFontMatches(dir, FONT_WALK_DEPTH, hits, budget);
    if (hits.length > 0) return hits;
  }
  return hits;
}

export function checkFonts(options: {
  env?: NodeJS.ProcessEnv;
  remote?: boolean;
  fontMatches?: (env: NodeJS.ProcessEnv) => string[];
} = {}): DoctorRow {
  const env = options.env ?? process.env;
  const remote = options.remote ?? isRemoteSession(env);
  if (remote) {
    return {
      check: "fonts",
      status: "warn",
      detail: "terminal is rendered on another machine",
      fix: "install Material Design Icons on the client Mac, not this host",
    };
  }

  const matches = (options.fontMatches ?? findFontMatches)(env);
  if (matches.length > 0) {
    return { check: "fonts", status: "pass", detail: matches[0] as string, fix: "" };
  }
  return {
    check: "fonts",
    status: "warn",
    detail: "Material Design Icons not found",
    fix: INSTALL_FONTS_FIX,
  };
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorResult> {
  const env = options.env ?? process.env;
  const secret = keyValue(env);
  const rows: DoctorRow[] = [];

  const apiKey = checkApiKey(env);
  rows.push(apiKey);
  const hasKey = apiKey.status === "pass";

  const linear = await checkLinear({ env, hasKey, queryAuth: options.queryAuth });
  rows.push(linear);

  const rate =
    options.rateInfo !== undefined ? options.rateInfo : hasKey && linear.status !== "skip" ? lastRateInfo : null;
  rows.push(checkRate(rate));
  rows.push(checkConfig(options));
  rows.push(checkCache({ env, now: options.now, readCache: options.readCache, probeWrite: options.probeWrite }));
  rows.push(await checkNative({ materialize: options.materializeNative, load: options.loadNative }));
  rows.push(checkFonts({ env, remote: options.remote, fontMatches: options.fontMatches }));

  const redacted = rows.map((row) => redactRow(row, secret));
  const failing = redacted.filter(requiredFail).map((row) => row.check);
  return { rows: redacted, failedRequired: failing.length > 0, failing };
}
