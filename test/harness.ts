// Test plumbing: a fetch stub, stdout capture, and a throwaway cache directory.
// Tests never reach the network — `mock()` replaces the client's fetch.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetFetch, setFetch, setRetryDelay, type GraphQLError } from "../src/client.ts";

export interface MockResponse {
  /** Operation name, or any substring of the query document. */
  match: string;
  data?: unknown;
  errors?: GraphQLError[];
  status?: number;
  headers?: Record<string, string>;
  /** Reject instead of responding, to exercise the retry path. */
  networkError?: string;
}

export interface RecordedCall {
  document: string;
  variables: Record<string, unknown> | undefined;
  operation: string | undefined;
}

export interface Mock {
  calls: RecordedCall[];
  restore(): void;
}

const OPERATION = /(?:query|mutation|subscription)\s+(\w+)/;

function operationName(document: string): string | undefined {
  return OPERATION.exec(document)?.[1];
}

function matches(call: RecordedCall, match: string): boolean {
  return call.operation === match || call.document.includes(match);
}

/**
 * Responses are matched in declaration order and each is consumed once, so
 * listing the same matcher twice describes a sequence (a 500 then a 200). Once
 * every match is consumed the last matching entry repeats.
 */
export function mock(responses: readonly MockResponse[]): Mock {
  const calls: RecordedCall[] = [];
  const consumed = new Set<number>();

  setRetryDelay(0);
  setFetch(async (_url, init) => {
    const body = JSON.parse(String(init.body)) as {
      query: string;
      variables?: Record<string, unknown>;
    };
    const call: RecordedCall = {
      document: body.query,
      variables: body.variables,
      operation: operationName(body.query),
    };
    calls.push(call);

    let chosen = responses.findIndex((response, index) => !consumed.has(index) && matches(call, response.match));
    if (chosen === -1) {
      chosen = responses.reduce(
        (last, response, index) => (matches(call, response.match) ? index : last),
        -1,
      );
    } else {
      consumed.add(chosen);
    }

    const response = responses[chosen];
    if (!response) {
      throw new Error(`no mock matched operation ${call.operation ?? "?"}: ${call.document.slice(0, 120)}`);
    }
    if (response.networkError !== undefined) throw new Error(response.networkError);

    const envelope: Record<string, unknown> = {};
    if (response.data !== undefined) envelope["data"] = response.data;
    if (response.errors !== undefined) envelope["errors"] = response.errors;

    return new Response(JSON.stringify(envelope), {
      status: response.status ?? 200,
      headers: { "content-type": "application/json", ...response.headers },
    });
  });

  return {
    calls,
    restore() {
      resetFetch();
      setRetryDelay(300);
    },
  };
}

// --- stdout -----------------------------------------------------------------

export interface Capture {
  text(): string;
  restore(): void;
}

/** Collect everything out.ts writes to stdout. */
export function captureStdout(): Capture {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);

  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stdout.write;

  return {
    text: () => chunks.join(""),
    restore() {
      process.stdout.write = original;
    },
  };
}

// --- environment ------------------------------------------------------------

export interface Sandbox {
  env: NodeJS.ProcessEnv;
  dir: string;
  cleanup(): void;
}

/**
 * A private cache directory and a fake key, so tests never collide with the
 * developer's real cache. The values are also installed into `process.env` and
 * restored on cleanup, because commands call `resolve.*` without an env
 * argument and would otherwise read the real one.
 */
export function sandbox(extra: Record<string, string> = {}): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "lin-test-"));
  const env: NodeJS.ProcessEnv = {
    HOME: dir,
    XDG_CACHE_HOME: join(dir, "cache"),
    XDG_CONFIG_HOME: join(dir, "config"),
    LINEAR_API_KEY: "lin_api_test_key",
    ...extra,
  };

  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }

  return {
    dir,
    env,
    cleanup() {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
