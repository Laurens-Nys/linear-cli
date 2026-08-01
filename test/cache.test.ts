import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  clear,
  isFresh,
  load,
  metaPath,
  readCached,
  toMeta,
  TTL_MS,
  warm,
  writeCached,
  type Meta,
} from "../src/cache.ts";
import { keyFingerprint } from "../src/client.ts";
import { mock, sandbox } from "./harness.ts";
import { WARM_DATA } from "./fixtures.ts";

function meta(env: NodeJS.ProcessEnv, fetchedAt: string): Meta {
  return { ...toMeta(WARM_DATA, keyFingerprint(env)), fetchedAt };
}

describe("the 24 hour TTL", () => {
  test("a cache written now is fresh", () => {
    const box = sandbox();
    try {
      expect(isFresh(meta(box.env, new Date().toISOString()))).toBe(true);
    } finally {
      box.cleanup();
    }
  });

  test("a cache older than the TTL is stale", () => {
    const box = sandbox();
    try {
      const old = new Date(Date.now() - TTL_MS - 60_000).toISOString();
      expect(isFresh(meta(box.env, old))).toBe(false);
    } finally {
      box.cleanup();
    }
  });

  test("a cache just inside the TTL is still fresh", () => {
    const box = sandbox();
    try {
      const recent = new Date(Date.now() - TTL_MS + 60_000).toISOString();
      expect(isFresh(meta(box.env, recent))).toBe(true);
    } finally {
      box.cleanup();
    }
  });
});

describe("parsing a warm response", () => {
  const parsed = toMeta(WARM_DATA, "fingerprint");

  test("keeps the workspace identity", () => {
    expect(parsed.workspace).toEqual({ urlKey: "acme", name: "Acme" });
  });

  test("nests states and labels under their team", () => {
    const eng = parsed.teams.find((team) => team.key === "ENG");
    expect(eng?.name).toBe("Engineering");
    expect(eng?.states.map((state) => state.name)).toEqual([
      "Triage",
      "Backlog",
      "Todo",
      "In Progress",
      "In Review",
      "Done",
      "Canceled",
    ]);
    expect(eng?.labels.find((label) => label.name === "P0")?.parent).toBe("Priority");
    expect(eng?.labels.find((label) => label.name === "Bug")?.parent).toBeNull();
  });

  test("keeps only unscoped labels as workspace labels", () => {
    expect(parsed.workspaceLabels.map((label) => label.name)).toEqual(["SecOps"]);
  });

  test("flattens templates and tags each with its team", () => {
    expect(parsed.templates).toEqual([
      { id: "tpl-bug", name: "Bug report", teamId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", type: "issue" },
      { id: "tpl-rfc", name: "RFC", teamId: null, type: "document" },
    ]);
  });

  test("reads project state from status, not the deprecated field", () => {
    expect(parsed.projects.map((project) => project.state)).toEqual(["In Progress", "Planned"]);
  });

  test("marks the viewer among the users", () => {
    expect(parsed.users.filter((user) => user.isMe).map((user) => user.displayName)).toEqual(["casey"]);
  });
});

describe("reading and writing", () => {
  test("round-trips through the XDG cache directory", () => {
    const box = sandbox();
    const stub = mock([]);
    try {
      const written = writeCached(meta(box.env, new Date().toISOString()), box.env);
      expect(written).toBe(metaPath("acme", box.env));
      expect(existsSync(written)).toBe(true);
      expect(readCached(box.env)?.workspace.urlKey).toBe("acme");
    } finally {
      stub.restore();
      box.cleanup();
    }
  });

  test("ignores a cache belonging to a different API key", () => {
    const box = sandbox();
    try {
      writeCached(meta(box.env, new Date().toISOString()), box.env);
      const otherKey = { ...box.env, LINEAR_API_KEY: "lin_api_a_different_key" };
      // Same machine, different workspace: never hand back the wrong UUIDs.
      expect(readCached(otherKey)).toBeNull();
    } finally {
      box.cleanup();
    }
  });

  test("clear removes every cached workspace", () => {
    const box = sandbox();
    try {
      const written = writeCached(meta(box.env, new Date().toISOString()), box.env);
      expect(clear(box.env)).toHaveLength(1);
      expect(existsSync(written)).toBe(false);
      expect(readCached(box.env)).toBeNull();
    } finally {
      box.cleanup();
    }
  });
});

describe("load", () => {
  test("fills an empty cache with one request", async () => {
    const box = sandbox();
    const stub = mock([{ match: "LinWarm", data: WARM_DATA }]);
    try {
      const loaded = await load({ env: box.env });
      expect(loaded.workspace.urlKey).toBe("acme");
      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0]?.operation).toBe("LinWarm");
      expect(existsSync(metaPath("acme", box.env))).toBe(true);
    } finally {
      stub.restore();
      box.cleanup();
    }
  });

  test("serves a fresh cache without touching the network", async () => {
    const box = sandbox();
    const stub = mock([{ match: "LinWarm", data: WARM_DATA }]);
    try {
      writeCached(meta(box.env, new Date().toISOString()), box.env);
      await load({ env: box.env });
      expect(stub.calls).toHaveLength(0);
    } finally {
      stub.restore();
      box.cleanup();
    }
  });

  test("refetches once the cache goes stale", async () => {
    const box = sandbox();
    const stub = mock([{ match: "LinWarm", data: WARM_DATA }]);
    try {
      writeCached(meta(box.env, new Date(Date.now() - TTL_MS - 1000).toISOString()), box.env);
      await load({ env: box.env });
      expect(stub.calls).toHaveLength(1);
    } finally {
      stub.restore();
      box.cleanup();
    }
  });

  test("--no-cache refetches even when the cache is fresh", async () => {
    const box = sandbox();
    const stub = mock([{ match: "LinWarm", data: WARM_DATA }]);
    try {
      writeCached(meta(box.env, new Date().toISOString()), box.env);
      await load({ noCache: true, env: box.env });
      expect(stub.calls).toHaveLength(1);
    } finally {
      stub.restore();
      box.cleanup();
    }
  });

  test("warm asks for every vocabulary in a single request", async () => {
    const box = sandbox();
    const stub = mock([{ match: "LinWarm", data: WARM_DATA }]);
    try {
      await warm(box.env);
      expect(stub.calls).toHaveLength(1);
      const document = stub.calls[0]?.document ?? "";
      for (const field of ["viewer", "teams(", "states(", "labels(", "templates(", "users(", "projects(", "organization"]) {
        expect(document).toContain(field);
      }
    } finally {
      stub.restore();
      box.cleanup();
    }
  });
});
