// The GraphQL transport. Auth, timeout, one retry, rate headers, and the
// mapping from Linear errors onto our exit-code contract. Commands never call fetch.

import { createHash } from "node:crypto";
import { EXIT, LinError, type ExitCode } from "./out.ts";

export const ENDPOINT = "https://api.linear.app/graphql";

/** Bound on every GraphQL request. Tests may shorten it via `setRequestTimeout`. */
export const REQUEST_TIMEOUT_MS = 30_000;

const TIMEOUT_MESSAGE = "could not reach the Linear API: request timed out";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

let fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init);
let retryDelayMs = 300;
let requestTimeoutMs = REQUEST_TIMEOUT_MS;

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

/** Tests shorten the request timeout; the CLI never calls this. */
export function setRequestTimeout(ms: number): void {
  requestTimeoutMs = ms;
}

export function resetRequestTimeout(): void {
  requestTimeoutMs = REQUEST_TIMEOUT_MS;
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

/** Hint for a missing key: the Linear settings path and an export with no fake secret. */
export const MISSING_API_KEY_HINT =
  "create a personal API key in Linear Settings > Security & access > Personal API keys, then export LINEAR_API_KEY";

export function apiKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env["LINEAR_API_KEY"];
  if (key === undefined || key.trim() === "") {
    throw new LinError(EXIT.auth, "LINEAR_API_KEY is not set", MISSING_API_KEY_HINT);
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
  /** Caller cancellation; combined with the request timeout. */
  signal?: AbortSignal;
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError";
}

function isTimeoutError(cause: unknown): boolean {
  return cause instanceof LinError && cause.message === TIMEOUT_MESSAGE;
}

function cancelled(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("the Linear API request was cancelled");
  error.name = "AbortError";
  return error;
}

function timeoutError(): LinError {
  return new LinError(
    EXIT.api,
    TIMEOUT_MESSAGE,
    "check network connectivity and retry",
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelled(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(cancelled(signal));
    };
    signal?.addEventListener("abort", onAbort);
  });
}

function withTimeoutSignal(
  caller: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; timedOut: () => boolean; cleanup: () => void } {
  const controller = new AbortController();
  let timedOut = false;
  let cleaned = false;

  const onCallerAbort = () => {
    controller.abort(caller?.reason);
  };

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  if (caller) {
    if (caller.aborted) controller.abort(caller.reason);
    else caller.addEventListener("abort", onCallerAbort);
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      caller?.removeEventListener("abort", onCallerAbort);
    },
  };
}

async function post(body: string, key: string, signal: AbortSignal): Promise<Response> {
  return fetchImpl(ENDPOINT, {
    method: "POST",
    headers: {
      // Linear personal API keys go in bare, with no `Bearer` prefix.
      authorization: key,
      "content-type": "application/json",
      accept: "application/json",
    },
    body,
    signal,
  });
}

async function requestOnce(body: string, key: string, caller: AbortSignal | undefined): Promise<Response> {
  if (caller?.aborted) throw cancelled(caller);

  const timeout = withTimeoutSignal(caller, requestTimeoutMs);
  try {
    return await post(body, key, timeout.signal);
  } catch (cause) {
    if (caller?.aborted) throw cancelled(caller);
    if (timeout.timedOut() || isAbortError(cause)) throw timeoutError();
    throw cause;
  } finally {
    timeout.cleanup();
  }
}

function throwTransport(cause: unknown): never {
  if (cause instanceof LinError || isAbortError(cause)) throw cause;
  throw networkError(cause);
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
  const caller = options.signal;
  const attempts = mayRetry ? 2 : 1;

  // One logical request: at most two HTTP attempts, whether the first failure
  // is 5xx or a network error. Timeouts, caller cancels, 4xx, and GraphQL
  // validation never retry.
  let response: Response | undefined;
  let lastFailure: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      response = await requestOnce(body, key, caller);
      lastFailure = undefined;
      if (response.status < 500 || attempt === attempts) break;
    } catch (cause) {
      lastFailure = cause;
      if (!mayRetry || isAbortError(cause) || isTimeoutError(cause) || attempt === attempts) {
        throwTransport(cause);
      }
    }
    await sleep(retryDelayMs, caller);
  }
  if (!response) throwTransport(lastFailure);

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
