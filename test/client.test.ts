import { describe, expect, test } from "bun:test";
import * as client from "../src/client.ts";
import { EXIT, LinError } from "../src/out.ts";
import { mock, sandbox } from "./harness.ts";
import { RATE_HEADERS } from "./fixtures.ts";

const QUERY = "query LinTest { viewer { id } }";

async function expectLinError(run: () => Promise<unknown>): Promise<LinError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(LinError);
    return error as LinError;
  }
  throw new Error("expected a LinError, but the call resolved");
}

describe("auth", () => {
  test("a missing key is exit 3 and names the variable", async () => {
    const stub = mock([{ match: "LinTest", data: { viewer: { id: "u1" } } }]);
    try {
      const error = await expectLinError(() => client.gql(QUERY, undefined, { env: {} }));
      expect(error.exitCode).toBe(EXIT.auth);
      expect(error.message).toContain("LINEAR_API_KEY");
      expect(stub.calls).toHaveLength(0); // fails before any request
    } finally {
      stub.restore();
    }
  });

  test("a blank key is treated as missing", async () => {
    const stub = mock([]);
    try {
      const error = await expectLinError(() =>
        client.gql(QUERY, undefined, { env: { LINEAR_API_KEY: "   " } }),
      );
      expect(error.exitCode).toBe(EXIT.auth);
    } finally {
      stub.restore();
    }
  });

  test("the key is sent bare, with no Bearer prefix", async () => {
    const box = sandbox();
    let sent: string | undefined;
    client.setFetch(async (_url, init) => {
      sent = new Headers(init.headers).get("authorization") ?? undefined;
      return new Response(JSON.stringify({ data: { viewer: { id: "u1" } } }), {
        headers: { "content-type": "application/json" },
      });
    });
    try {
      await client.gql(QUERY, undefined, { env: box.env });
      expect(sent).toBe("lin_api_test_key");
    } finally {
      client.resetFetch();
      box.cleanup();
    }
  });

  test("the key fingerprint is stable and never the key itself", () => {
    const env = { LINEAR_API_KEY: "lin_api_secret" };
    const fingerprint = client.keyFingerprint(env);
    expect(fingerprint).toHaveLength(16);
    expect(fingerprint).toBe(client.keyFingerprint(env));
    expect(fingerprint).not.toContain("secret");
    expect(client.keyFingerprint({ LINEAR_API_KEY: "other" })).not.toBe(fingerprint);
  });
});

describe("retries", () => {
  test("a 500 is retried once and then succeeds", async () => {
    const box = sandbox();
    const stub = mock([
      { match: "LinTest", status: 500, errors: [{ message: "upstream is unhappy" }] },
      { match: "LinTest", data: { viewer: { id: "u1" } } },
    ]);
    try {
      const data = await client.gql<{ viewer: { id: string } }>(QUERY, undefined, { env: box.env });
      expect(data.viewer.id).toBe("u1");
      expect(stub.calls).toHaveLength(2);
    } finally {
      stub.restore();
      box.cleanup();
    }
  });

  test("a network failure is retried once and then succeeds", async () => {
    const box = sandbox();
    const stub = mock([
      { match: "LinTest", networkError: "connection reset" },
      { match: "LinTest", data: { viewer: { id: "u1" } } },
    ]);
    try {
      await client.gql(QUERY, undefined, { env: box.env });
      expect(stub.calls).toHaveLength(2);
    } finally {
      stub.restore();
      box.cleanup();
    }
  });

  test("two network failures give up with a reachability error", async () => {
    const box = sandbox();
    const stub = mock([
      { match: "LinTest", networkError: "connection reset" },
      { match: "LinTest", networkError: "connection reset" },
    ]);
    try {
      const error = await expectLinError(() => client.gql(QUERY, undefined, { env: box.env }));
      expect(error.exitCode).toBe(EXIT.api);
      expect(error.message).toContain("could not reach the Linear API");
      expect(stub.calls).toHaveLength(2);
    } finally {
      stub.restore();
      box.cleanup();
    }
  });

  test("a 4xx is never retried", async () => {
    const box = sandbox();
    const stub = mock([
      { match: "LinTest", status: 400, errors: [{ message: "Query too complex" }] },
      { match: "LinTest", data: { viewer: { id: "u1" } } },
    ]);
    try {
      await expectLinError(() => client.gql(QUERY, undefined, { env: box.env }));
      expect(stub.calls).toHaveLength(1);
    } finally {
      stub.restore();
      box.cleanup();
    }
  });
});

describe("GraphQL error mapping", () => {
  test("an authentication error is exit 3", async () => {
    const box = sandbox();
    const stub = mock([
      {
        match: "LinTest",
        status: 401,
        errors: [
          {
            message: "Authentication required, not authenticated",
            extensions: { code: "AUTHENTICATION_ERROR", type: "authentication error" },
          },
        ],
      },
    ]);
    try {
      const error = await expectLinError(() => client.gql(QUERY, undefined, { env: box.env }));
      expect(error.exitCode).toBe(EXIT.auth);
      expect(error.hint).toContain("LINEAR_API_KEY");
    } finally {
      stub.restore();
      box.cleanup();
    }
  });

  test("entity not found is exit 4", async () => {
    const box = sandbox();
    const stub = mock([
      {
        match: "LinTest",
        errors: [
          {
            message: "Entity not found: Issue",
            extensions: { code: "INPUT_ERROR", userPresentableMessage: "Could not find referenced Issue." },
          },
        ],
      },
    ]);
    try {
      const error = await expectLinError(() => client.gql(QUERY, undefined, { env: box.env }));
      expect(error.exitCode).toBe(EXIT.notFound);
      expect(error.message).toBe("Entity not found: Issue");
      expect(error.hint).toBe("Could not find referenced Issue.");
    } finally {
      stub.restore();
      box.cleanup();
    }
  });

  test("a rate limit is exit 1 and reports when the window resets", async () => {
    const box = sandbox();
    const stub = mock([
      {
        match: "LinTest",
        status: 400,
        headers: RATE_HEADERS,
        errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }],
      },
    ]);
    try {
      const error = await expectLinError(() => client.gql(QUERY, undefined, { env: box.env }));
      expect(error.exitCode).toBe(EXIT.api);
      expect(error.hint).toContain("resets at");
      expect(error.hint).toContain("2026-07-29"); // epoch 1785312000
    } finally {
      stub.restore();
      box.cleanup();
    }
  });

  test("a validation error is exit 1 with the API's own wording", async () => {
    const box = sandbox();
    const stub = mock([
      {
        match: "LinTest",
        status: 400,
        errors: [
          {
            message: 'Cannot query field "nope" on type "User".',
            extensions: { code: "GRAPHQL_VALIDATION_FAILED" },
          },
        ],
      },
    ]);
    try {
      const error = await expectLinError(() => client.gql(QUERY, undefined, { env: box.env }));
      expect(error.exitCode).toBe(EXIT.api);
      expect(error.message).toBe('Cannot query field "nope" on type "User".');
    } finally {
      stub.restore();
      box.cleanup();
    }
  });
});

describe("rate budget capture", () => {
  test("the last response's headers land in lastRateInfo", async () => {
    const box = sandbox();
    const stub = mock([{ match: "LinTest", data: { viewer: { id: "u1" } }, headers: RATE_HEADERS }]);
    try {
      await client.gql(QUERY, undefined, { env: box.env });
      expect(client.lastRateInfo).toMatchObject({
        requestsRemaining: 2487,
        requestsLimit: 2500,
        complexityRemaining: 2996000,
        complexityLimit: 3000000,
        complexity: 42,
      });
      // Rendered with a space, not a T, so out.ts does not collapse it to a date.
      expect(client.lastRateInfo?.requestsReset).toBe("2026-07-29 08:00:00Z");
    } finally {
      stub.restore();
      box.cleanup();
    }
  });

  test("missing headers leave the fields undefined rather than NaN", async () => {
    const box = sandbox();
    const stub = mock([{ match: "LinTest", data: { viewer: { id: "u1" } } }]);
    try {
      await client.gql(QUERY, undefined, { env: box.env });
      expect(client.lastRateInfo?.requestsRemaining).toBeUndefined();
      expect(client.lastRateInfo?.requestsReset).toBeUndefined();
    } finally {
      stub.restore();
      box.cleanup();
    }
  });
});

describe("gqlRaw", () => {
  test("returns GraphQL errors instead of throwing, so lin api can print them", async () => {
    const box = sandbox();
    const stub = mock([
      { match: "LinTest", status: 400, errors: [{ message: "Cannot query field" }] },
    ]);
    try {
      const envelope = await client.gqlRaw(QUERY, undefined, { env: box.env });
      expect(envelope.errors?.[0]?.message).toBe("Cannot query field");
    } finally {
      stub.restore();
      box.cleanup();
    }
  });

  test("still throws on auth failures", async () => {
    const box = sandbox();
    const stub = mock([
      {
        match: "LinTest",
        status: 401,
        errors: [{ message: "not authenticated", extensions: { code: "AUTHENTICATION_ERROR" } }],
      },
    ]);
    try {
      const error = await expectLinError(() => client.gqlRaw(QUERY, undefined, { env: box.env }));
      expect(error.exitCode).toBe(EXIT.auth);
    } finally {
      stub.restore();
      box.cleanup();
    }
  });
});
