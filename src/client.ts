// The GraphQL transport. Auth, one retry, rate headers, and the mapping from
// Linear errors onto our exit-code contract. Commands never call fetch.

import { createHash } from "node:crypto";
import { EXIT, LinError, type ExitCode } from "./out.ts";

export const ENDPOINT = "https://api.linear.app/graphql";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

let fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init);
let retryDelayMs = 300;

/** Tests inject a stub here; nothing else should call this. */
export function setFetch(impl: FetchLike): void {
  fetchImpl = impl;
}

export function resetFetch(): void {
  fetchImpl = (input, init) => globalThis.fetch(input, init);
}

/** Tests shorten the backoff; the CLI never calls this. */
export function setRetryDelay(ms: number): void {
  retryDelayMs = ms;
}

// --- rate limit budget ------------------------------------------------------

export interface RateInfo {
  requestsRemaining?: number;
  requestsLimit?: number;
  requestsReset?: string;
  complexity?: number;
  complexityRemaining?: number;
  complexityLimit?: number;
  complexityReset?: string;
}

/** Budget from the most recent response, for `lin auth`. Live ESM binding. */
export let lastRateInfo: RateInfo | null = null;

function numberHeader(headers: Headers, name: string): number | undefined {
  const value = headers.get(name);
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Linear sends epoch seconds or milliseconds. Rendered as `YYYY-MM-DD HH:MM:SSZ`
 * rather than ISO: out.ts collapses anything with a `T` to a bare date, and a
 * reset instant without its time is useless.
 */
export function formatReset(value: string | null): string | undefined {
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  const ms = parsed > 1e11 ? parsed : parsed * 1000;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toISOString().slice(0, 19).replace("T", " ")}Z`;
}

function captureRateInfo(headers: Headers): RateInfo {
  const info: RateInfo = {
    requestsRemaining: numberHeader(headers, "x-ratelimit-requests-remaining"),
    requestsLimit: numberHeader(headers, "x-ratelimit-requests-limit"),
    requestsReset: formatReset(headers.get("x-ratelimit-requests-reset")),
    complexity: numberHeader(headers, "x-complexity"),
    complexityRemaining: numberHeader(headers, "x-ratelimit-complexity-remaining"),
    complexityLimit: numberHeader(headers, "x-ratelimit-complexity-limit"),
    complexityReset: formatReset(headers.get("x-ratelimit-complexity-reset")),
  };
  lastRateInfo = info;
  return info;
}

// --- auth -------------------------------------------------------------------

export function apiKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env["LINEAR_API_KEY"];
  if (key === undefined || key.trim() === "") {
    throw new LinError(
      EXIT.auth,
      "LINEAR_API_KEY is not set",
      "create a personal API key at https://linear.app/settings/api and export LINEAR_API_KEY",
    );
  }
  return key.trim();
}

/**
 * A short one-way fingerprint of the key, used to tell cached workspaces apart.
 * Never reversible, never printed.
 */
export function keyFingerprint(env: NodeJS.ProcessEnv = process.env): string {
  return createHash("sha256").update(apiKey(env)).digest("hex").slice(0, 16);
}

// --- errors -----------------------------------------------------------------

export interface GraphQLError {
  message: string;
  path?: (string | number)[];
  extensions?: {
    code?: string;
    type?: string;
    userPresentableMessage?: string;
    [key: string]: unknown;
  };
}

export interface GraphQLResponse<T> {
  data?: T | null;
  errors?: GraphQLError[];
}

function exitCodeFor(error: GraphQLError): ExitCode {
  const code = error.extensions?.code ?? "";
  if (code === "AUTHENTICATION_ERROR") return EXIT.auth;
  if (code === "RATELIMITED") return EXIT.api;
  if (/entity not found|could not find/i.test(error.message)) return EXIT.notFound;
  return EXIT.api;
}

function hintFor(error: GraphQLError, rate: RateInfo | null): string | undefined {
  const code = error.extensions?.code ?? "";
  if (code === "RATELIMITED") {
    const reset = rate?.requestsReset ?? rate?.complexityReset;
    return reset ? `the rate limit window resets at ${reset}` : undefined;
  }
  if (code === "AUTHENTICATION_ERROR") {
    return "check that LINEAR_API_KEY holds a current personal API key";
  }
  const presentable = error.extensions?.userPresentableMessage;
  return typeof presentable === "string" && presentable !== error.message ? presentable : undefined;
}

/** Turn the first GraphQL error into a LinError on the right exit code. */
export function toLinError(errors: readonly GraphQLError[], rate: RateInfo | null = lastRateInfo): LinError {
  const first = errors[0];
  if (!first) return new LinError(EXIT.api, "the Linear API returned an unspecified error");
  return new LinError(exitCodeFor(first), first.message, hintFor(first, rate));
}

// --- transport --------------------------------------------------------------

export interface GqlOptions {
  /** Set false to disable the single retry (used by mutations that are not idempotent). */
  retry?: boolean;
  env?: NodeJS.ProcessEnv;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function post(body: string, key: string): Promise<Response> {
  return fetchImpl(ENDPOINT, {
    method: "POST",
    headers: {
      // Linear personal API keys go in bare, with no `Bearer` prefix.
      authorization: key,
      "content-type": "application/json",
      accept: "application/json",
    },
    body,
  });
}

/**
 * Execute a document and return the raw envelope. GraphQL-level errors are
 * returned, not thrown, so `lin api` can print them itself. Transport and auth
 * failures still throw.
 */
export async function gqlRaw<T>(
  document: string,
  variables?: Record<string, unknown>,
  options: GqlOptions = {},
): Promise<GraphQLResponse<T>> {
  const key = apiKey(options.env);
  const body = JSON.stringify(variables ? { query: document, variables } : { query: document });
  const mayRetry = options.retry !== false;

  let response: Response;
  try {
    response = await post(body, key);
    if (response.status >= 500 && mayRetry) {
      await sleep(retryDelayMs);
      response = await post(body, key);
    }
  } catch (cause) {
    if (!mayRetry) throw networkError(cause);
    await sleep(retryDelayMs);
    try {
      response = await post(body, key);
    } catch (retryCause) {
      throw networkError(retryCause);
    }
  }

  const rate = captureRateInfo(response.headers);

  let envelope: GraphQLResponse<T>;
  try {
    envelope = (await response.json()) as GraphQLResponse<T>;
  } catch {
    throw new LinError(
      response.status === 401 || response.status === 403 ? EXIT.auth : EXIT.api,
      `the Linear API returned HTTP ${response.status} with a non-JSON body`,
    );
  }

  if (!response.ok && (!envelope.errors || envelope.errors.length === 0)) {
    throw new LinError(
      response.status === 401 || response.status === 403 ? EXIT.auth : EXIT.api,
      `the Linear API returned HTTP ${response.status}`,
    );
  }

  if (envelope.errors && envelope.errors.length > 0) {
    // Surface auth failures immediately; `lin api` should not have to detect them.
    const first = envelope.errors[0];
    if (first && exitCodeFor(first) === EXIT.auth) throw toLinError(envelope.errors, rate);
  }

  return envelope;
}

function networkError(cause: unknown): LinError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new LinError(EXIT.api, `could not reach the Linear API: ${detail}`, "check network connectivity and retry");
}

/** Execute a document and return `data`, throwing a LinError on any error. */
export async function gql<T>(
  document: string,
  variables?: Record<string, unknown>,
  options: GqlOptions = {},
): Promise<T> {
  const envelope = await gqlRaw<T>(document, variables, options);

  if (envelope.errors && envelope.errors.length > 0) throw toLinError(envelope.errors);
  if (envelope.data === undefined || envelope.data === null) {
    throw new LinError(EXIT.api, "the Linear API returned no data");
  }

  return envelope.data;
}
