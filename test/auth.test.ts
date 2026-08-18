import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import auth, { AUTH_QUERY } from "../src/commands/auth.ts";
import { cacheRoot, toMeta, writeCached } from "../src/cache.ts";
import { keyFingerprint } from "../src/client.ts";
import { captureStdout, mock, sandbox } from "./harness.ts";
import { RATE_HEADERS, WARM_DATA } from "./fixtures.ts";

const VIEWER = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Casey Jordan",
  email: "casey@acme.test",
  organization: { urlKey: "acme", name: "Acme" },
};

describe("lin auth", () => {
  test("prints identity, rate budget, default team, and cache age without writing", async () => {
    const box = sandbox();
    writeCached(toMeta(WARM_DATA, keyFingerprint(box.env), new Date()), box.env);
    const before = new Set(readdirSync(cacheRoot(box.env), { recursive: true }).map(String));
    const stub = mock([{ match: "LinAuth", data: { viewer: VIEWER }, headers: RATE_HEADERS }]);
    const captured = captureStdout();

    try {
      await auth.run({
        args: [],
        flags: {},
        config: { team: "ENG", limit: 50 },
        command: auth,
      });
      captured.restore();

      const text = captured.text();
      expect(AUTH_QUERY).toContain("viewer");
      expect(text).toContain("name: Casey Jordan");
      expect(text).toContain("workspace: acme");
      expect(text).toContain("team: ENG");
      expect(text).toContain("cache:");
      expect(text).toContain("cacheFresh: true");
      expect(text).toContain("requestsRemaining: 2487");
      expect(text).not.toContain("lin_api_test_key");
      expect(stub.calls.map((call) => call.operation)).toEqual(["LinAuth"]);

      const after = readdirSync(cacheRoot(box.env), { recursive: true }).map(String);
      expect(new Set(after)).toEqual(before);
      expect(existsSync(join(cacheRoot(box.env), "acme", "meta.json"))).toBe(true);
    } finally {
      captured.restore();
      stub.restore();
      box.cleanup();
    }
  });

  test("omits default team and reports an empty cache when neither exists", async () => {
    const box = sandbox();
    const stub = mock([{ match: "LinAuth", data: { viewer: VIEWER } }]);
    const captured = captureStdout();

    try {
      await auth.run({
        args: [],
        flags: {},
        config: { limit: 50 },
        command: auth,
      });
      captured.restore();

      const text = captured.text();
      expect(text).toContain("cache: empty");
      expect(text).not.toContain("\nteam:");
      expect(text).not.toContain("cacheFresh:");
      expect(text).not.toContain("lin_api_test_key");
    } finally {
      captured.restore();
      stub.restore();
      box.cleanup();
    }
  });
});
