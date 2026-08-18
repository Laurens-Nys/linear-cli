import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import {
  cacheAge,
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
import { EXIT } from "../src/out.ts";
import { MAX_PAGES } from "../src/page.ts";
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

  test("cacheAge names minutes, hours, then days", () => {
    const now = Date.parse("2026-08-01T12:00:00.000Z");
    expect(cacheAge("2026-08-01T11:50:00.000Z", now)).toBe("10m");
    expect(cacheAge("2026-08-01T09:00:00.000Z", now)).toBe("3h");
    expect(cacheAge("2026-07-20T12:00:00.000Z", now)).toBe("12d");
    expect(cacheAge("not-a-date", now)).toBe("unknown");
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
    expect(eng?.states.find((state) => state.name === "In Review")?.color).toBe("#bb9af7");
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

  test("accepts caches written before workflow state colors were captured", () => {
    const box = sandbox();
    try {
      const old = meta(box.env, new Date().toISOString());
      old.teams = old.teams.map((team) => ({
        ...team,
        states: team.states.map(({ color: _color, ...state }) => state),
      }));
      writeCached(old, box.env);
      expect(readCached(box.env)?.teams[0]?.states[0]?.color).toBeUndefined();
    } finally {
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

  test("load still returns metadata when the cache cannot be written", async () => {
    const box = sandbox();
    const stub = mock([{ match: "LinWarm", data: WARM_DATA }]);
    try {
      writeFileSync(box.env.XDG_CACHE_HOME!, "not-a-directory");
      const loaded = await load({ env: box.env });
      expect(loaded.workspace.urlKey).toBe("acme");
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
      expect(document).toContain(
        "states(first: 30) { nodes { id name type position color } pageInfo { hasNextPage endCursor } }",
      );
    } finally {
      stub.restore();
      box.cleanup();
    }
  });

  test("warm paginates vocabularies that exceed the first-page caps", async () => {
    const first = structuredClone(WARM_DATA);
    const eng = first.teams.nodes[0]!;
    Object.assign(first.teams, { pageInfo: { hasNextPage: true, endCursor: "teams-2" } });
    first.teams.nodes = [eng];
    Object.assign(eng.states, { pageInfo: { hasNextPage: true, endCursor: "states-2" } });
    Object.assign(eng.labels, { pageInfo: { hasNextPage: true, endCursor: "labels-2" } });
    Object.assign(eng.templates, { pageInfo: { hasNextPage: true, endCursor: "templates-2" } });
    Object.assign(first.users, { pageInfo: { hasNextPage: true, endCursor: "users-2" } });
    Object.assign(first.projects, { pageInfo: { hasNextPage: true, endCursor: "projects-2" } });
    Object.assign(first.organization.labels, { pageInfo: { hasNextPage: true, endCursor: "orglabels-2" } });
    Object.assign(first.organization.templates, { pageInfo: { hasNextPage: true, endCursor: "orgtemplates-2" } });

    const box = sandbox();
    const stub = mock([
      { match: "LinWarm", data: first },
      {
        match: "LinCacheTeams",
        data: {
          teams: {
            nodes: [
              {
                id: "ffffffff-6666-4666-8666-ffffffffffff",
                key: "OPS",
                name: "Operations",
                states: {
                  nodes: [{ id: "op-todo", name: "Todo", type: "unstarted", position: 0, color: "#a8a8a8" }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
                labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                templates: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: "teams-end" },
          },
        },
      },
      {
        match: "LinCacheTeamStates",
        data: {
          team: {
            states: {
              nodes: [{ id: "st-blocked", name: "Blocked", type: "started", position: 4.5, color: "#f7768e" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
      {
        match: "LinCacheTeamLabels",
        data: {
          team: {
            labels: {
              nodes: [{ id: "lb-ops", name: "Infra", color: "#7aa2f7", parent: null }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
      {
        match: "LinCacheTeamTemplates",
        data: {
          team: {
            templates: {
              nodes: [{ id: "tpl-inc", name: "Incident", type: "issue" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
      {
        match: "LinCacheUsers",
        data: {
          users: {
            nodes: [
              {
                id: "33333333-3333-4333-8333-333333333333",
                name: "Riley Chen",
                displayName: "riley",
                email: "riley@acme.test",
                active: true,
                isMe: false,
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
      {
        match: "LinCacheProjects",
        data: {
          projects: {
            nodes: [
              {
                id: "eeeeeeee-5555-4555-8555-eeeeeeeeeeee",
                slugId: "infra-7g8h9i",
                name: "Infra",
                status: { name: "Started" },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
      {
        match: "LinCacheOrgLabels",
        data: {
          organization: {
            labels: {
              nodes: [{ id: "lb-legal", name: "Legal", color: "#9ece6a", parent: null, team: null }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
      {
        match: "LinCacheOrgTemplates",
        data: {
          organization: {
            templates: {
              nodes: [{ id: "tpl-adr", name: "ADR", type: "document" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    ]);
    try {
      const loaded = await warm(box.env);
      expect(stub.calls.map((call) => call.operation)).toEqual([
        "LinWarm",
        "LinCacheTeams",
        "LinCacheTeamStates",
        "LinCacheTeamLabels",
        "LinCacheTeamTemplates",
        "LinCacheUsers",
        "LinCacheProjects",
        "LinCacheOrgLabels",
        "LinCacheOrgTemplates",
      ]);
      expect(loaded.teams.map((team) => team.key)).toEqual(["ENG", "OPS"]);
      expect(loaded.teams[0]?.states.map((state) => state.name)).toContain("Blocked");
      expect(loaded.teams[0]?.labels.map((label) => label.name)).toContain("Infra");
      expect(loaded.templates.map((template) => template.name)).toEqual(["Bug report", "Incident", "RFC", "ADR"]);
      expect(loaded.users.map((user) => user.displayName)).toEqual(["casey", "alex", "riley"]);
      expect(loaded.projects.map((project) => project.name)).toEqual(["Onboarding", "Billing", "Infra"]);
      expect(loaded.workspaceLabels.map((label) => label.name)).toEqual(["SecOps", "Legal"]);
      expect(readCached(box.env)?.users).toHaveLength(3);
    } finally {
      stub.restore();
      box.cleanup();
    }
  });

  test("a missing cache cursor fails before writing", async () => {
    const first = structuredClone(WARM_DATA);
    Object.assign(first.users, { pageInfo: { hasNextPage: true, endCursor: null } });
    const box = sandbox();
    const stub = mock([{ match: "LinWarm", data: first }]);
    try {
      await expect(warm(box.env)).rejects.toMatchObject({
        exitCode: EXIT.api,
        message: "cache pagination cursor missing",
      });
      expect(readCached(box.env)).toBeNull();
      expect(stub.calls.map((call) => call.operation)).toEqual(["LinWarm"]);
    } finally {
      stub.restore();
      box.cleanup();
    }
  });

  test("unique cache cursors still fail at MAX_PAGES before writing", async () => {
    const first = structuredClone(WARM_DATA);
    Object.assign(first.users, { pageInfo: { hasNextPage: true, endCursor: "u0" } });
    const box = sandbox();
    const stub = mock([
      { match: "LinWarm", data: first },
      ...Array.from({ length: MAX_PAGES - 1 }, (_, index) => ({
        match: "LinCacheUsers",
        data: {
          users: { nodes: [], pageInfo: { hasNextPage: true, endCursor: `u${index + 1}` } },
        },
      })),
    ]);
    try {
      await expect(warm(box.env)).rejects.toMatchObject({
        exitCode: EXIT.api,
        message: "cache pagination exceeded maximum pages",
      });
      expect(readCached(box.env)).toBeNull();
      expect(stub.calls).toHaveLength(MAX_PAGES);
    } finally {
      stub.restore();
      box.cleanup();
    }
  });

  test("a repeated cache cursor fails before writing", async () => {
    const first = structuredClone(WARM_DATA);
    Object.assign(first.users, { pageInfo: { hasNextPage: true, endCursor: "loop" } });
    const box = sandbox();
    const stub = mock([
      { match: "LinWarm", data: first },
      {
        match: "LinCacheUsers",
        data: { users: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "loop" } } },
      },
    ]);
    try {
      await expect(warm(box.env)).rejects.toMatchObject({
        exitCode: EXIT.api,
        message: "cache pagination cursor repeated",
      });
      expect(readCached(box.env)).toBeNull();
    } finally {
      stub.restore();
      box.cleanup();
    }
  });
});
