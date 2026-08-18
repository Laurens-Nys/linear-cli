import { describe, expect, test } from "bun:test";
import { toMeta, writeCached, type Meta } from "../src/cache.ts";
import { keyFingerprint } from "../src/client.ts";
import { EXIT, LinError } from "../src/out.ts";
import {
  issueIdentifierFrom,
  issueIdentifierFromBranch,
  resolveCycle,
  resolveIssueUUID,
  resolveLabel,
  resolveProject,
  resolveState,
  resolveStateByType,
  resolveTeam,
  resolveTemplate,
  resolveUser,
} from "../src/resolve.ts";
import { mock, sandbox, type Mock } from "./harness.ts";
import { WARM_DATA, WARM_DATA_WITH_OPS } from "./fixtures.ts";

/** Seed a fresh on-disk cache so lookups start from the cached path. */
function seed(env: NodeJS.ProcessEnv, data: typeof WARM_DATA = WARM_DATA): Meta {
  const meta = { ...toMeta(data, keyFingerprint(env)), fetchedAt: new Date().toISOString() };
  writeCached(meta, env);
  return meta;
}

async function expectLinError(run: () => Promise<unknown>): Promise<LinError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(LinError);
    return error as LinError;
  }
  throw new Error("expected a LinError, but the call resolved");
}

function withSandbox<T>(body: (env: NodeJS.ProcessEnv, stub: Mock) => Promise<T>, responses: Parameters<typeof mock>[0] = []) {
  return async () => {
    const box = sandbox();
    const stub = mock(responses);
    try {
      await body(box.env, stub);
    } finally {
      stub.restore();
      box.cleanup();
    }
  };
}

describe("teams", () => {
  test(
    "resolves by key, case-insensitively, without a request",
    withSandbox(async (env, stub) => {
      seed(env);
      expect((await resolveTeam("eng", { env })).id).toBe("aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa");
      expect(stub.calls).toHaveLength(0);
    }),
  );

  test(
    "resolves by full name too",
    withSandbox(async (env) => {
      seed(env);
      expect((await resolveTeam("Engineering", { env })).key).toBe("ENG");
    }),
  );

  test(
    "no team at all names the two ways to supply one",
    withSandbox(async (env) => {
      const error = await expectLinError(() => resolveTeam(undefined, { env }));
      expect(error.exitCode).toBe(EXIT.input);
      expect(error.message).toBe("no team given");
      expect(error.hint).toContain("lin team list");
      expect(error.hint).toContain("--team ENG");
      expect(error.hint).toContain('team = "ENG"');
      expect(error.hint).toContain(".lin.toml");
    }),
  );

  test(
    "a miss refreshes the cache once and then succeeds",
    withSandbox(
      async (env, stub) => {
        seed(env); // cached copy has ENG and DES only
        const team = await resolveTeam("OPS", { env });
        expect(team.key).toBe("OPS");
        expect(stub.calls).toHaveLength(1); // exactly one refresh, not a loop
        expect(stub.calls[0]?.operation).toBe("LinWarm");
      },
      [{ match: "LinWarm", data: WARM_DATA_WITH_OPS }],
    ),
  );

  test(
    "a real miss lists the candidates and exits 2",
    withSandbox(
      async (env, stub) => {
        seed(env);
        const error = await expectLinError(() => resolveTeam("NOPE", { env }));
        expect(error.exitCode).toBe(EXIT.input);
        expect(error.message).toBe('no team "NOPE"');
        expect(error.hint).toBe("teams: ENG, DES");
        expect(stub.calls).toHaveLength(1); // refreshed once, then gave up
      },
      [{ match: "LinWarm", data: WARM_DATA }],
    ),
  );
});

describe("workflow states", () => {
  test(
    "resolves a state within its team",
    withSandbox(async (env) => {
      seed(env);
      expect((await resolveState("ENG", "in progress", { env })).id).toBe("st-doing");
    }),
  );

  test(
    "an unknown state lists that team's states, in the DESIGN.md wording",
    withSandbox(
      async (env) => {
        seed(env);
        const error = await expectLinError(() => resolveState("ENG", "Shipping", { env }));
        expect(error.exitCode).toBe(EXIT.input);
        expect(error.message).toBe('team ENG has no state "Shipping"');
        expect(error.hint).toBe("states: Triage, Backlog, Todo, In Progress, In Review, Done, Canceled");
      },
      [{ match: "LinWarm", data: WARM_DATA }],
    ),
  );

  test(
    "by type picks the lowest position when several share a type",
    withSandbox(async (env) => {
      seed(env);
      // In Progress (3) and In Review (4) are both "started"; start means the first.
      expect((await resolveStateByType("ENG", "started", { env })).name).toBe("In Progress");
      expect((await resolveStateByType("ENG", "completed", { env })).name).toBe("Done");
      expect((await resolveStateByType("ENG", "triage", { env })).name).toBe("Triage");
    }),
  );

  test(
    "a team without that state type says so and lists the types it has",
    withSandbox(
      async (env) => {
        seed(env);
        const error = await expectLinError(() => resolveStateByType("DES", "triage", { env }));
        expect(error.message).toBe('team DES has no state of type "triage"');
        expect(error.hint).toBe("state types: unstarted, completed");
      },
      [{ match: "LinWarm", data: WARM_DATA }],
    ),
  );
});

describe("users", () => {
  test(
    "me resolves to the viewer",
    withSandbox(async (env) => {
      seed(env);
      expect((await resolveUser("me", { env })).displayName).toBe("casey");
      expect((await resolveUser("ME", { env })).isMe).toBe(true);
    }),
  );

  test(
    "resolves by display name, full name or email",
    withSandbox(async (env) => {
      seed(env);
      expect((await resolveUser("alex", { env })).id).toBe("22222222-2222-4222-8222-222222222222");
      expect((await resolveUser("Alex Rivera", { env })).displayName).toBe("alex");
      expect((await resolveUser("ALEX@acme.test", { env })).displayName).toBe("alex");
    }),
  );

  test(
    "an unknown user lists the active ones",
    withSandbox(
      async (env) => {
        seed(env);
        const error = await expectLinError(() => resolveUser("jordan", { env }));
        expect(error.exitCode).toBe(EXIT.input);
        expect(error.hint).toBe("users: casey, alex");
      },
      [{ match: "LinWarm", data: WARM_DATA }],
    ),
  );
});

describe("labels", () => {
  test(
    "a team label resolves against that team plus workspace labels",
    withSandbox(async (env) => {
      seed(env);
      expect((await resolveLabel("ENG", "bug", { env })).id).toBe("lb-bug");
      expect((await resolveLabel("ENG", "SecOps", { env })).id).toBe("lb-secops");
    }),
  );

  test(
    "group/label picks inside a label group",
    withSandbox(async (env) => {
      seed(env);
      expect((await resolveLabel("ENG", "Priority/P0", { env })).id).toBe("lb-p0");
    }),
  );

  test(
    "an unqualified name matching two teams is ambiguous, never guessed",
    withSandbox(
      async (env) => {
        seed(env);
        const error = await expectLinError(() => resolveLabel(null, "Bug", { env }));
        expect(error.exitCode).toBe(EXIT.input);
        expect(error.message).toContain("ambiguous");
        expect(error.hint).toContain("Bug");
      },
      [{ match: "LinWarm", data: WARM_DATA }],
    ),
  );
});

describe("projects and templates", () => {
  test(
    "a project resolves by name, slug or id",
    withSandbox(async (env) => {
      seed(env);
      expect((await resolveProject("Onboarding", { env })).slugId).toBe("onboarding-1a2b3c");
      expect((await resolveProject("billing-4d5e6f", { env })).name).toBe("Billing");
      expect((await resolveProject("cccccccc-3333-4333-8333-cccccccccccc", { env })).name).toBe("Onboarding");
    }),
  );

  test(
    "templates scope to their team, and workspace templates apply anywhere",
    withSandbox(async (env) => {
      seed(env);
      expect((await resolveTemplate("Bug report", "ENG", { env })).id).toBe("tpl-bug");
      expect((await resolveTemplate("RFC", "DES", { env })).teamId).toBeNull();
    }),
  );

  test(
    "another team's template is not visible",
    withSandbox(
      async (env) => {
        seed(env);
        const error = await expectLinError(() => resolveTemplate("Bug report", "DES", { env }));
        expect(error.exitCode).toBe(EXIT.input);
        expect(error.hint).toBe("templates: RFC");
      },
      [{ match: "LinWarm", data: WARM_DATA }],
    ),
  );
});

describe("cycles", () => {
  const CYCLES = {
    team: {
      activeCycle: { id: "cy-7", number: 7 },
      cycles: {
        nodes: [
          { id: "cy-6", number: 6, name: null, startsAt: "2026-07-06T00:00:00.000Z", endsAt: "2026-07-20T00:00:00.000Z" },
          { id: "cy-7", number: 7, name: "Cycle 7", startsAt: "2026-07-20T00:00:00.000Z", endsAt: "2026-08-03T00:00:00.000Z" },
          { id: "cy-8", number: 8, name: null, startsAt: "2026-08-03T00:00:00.000Z", endsAt: "2026-08-17T00:00:00.000Z" },
        ],
      },
    },
  };

  test(
    "current, next and previous key off the active cycle",
    withSandbox(
      async (env) => {
        seed(env);
        expect((await resolveCycle("ENG", "current", { env })).id).toBe("cy-7");
        expect((await resolveCycle("ENG", "next", { env })).id).toBe("cy-8");
        expect((await resolveCycle("ENG", "previous", { env })).id).toBe("cy-6");
        expect((await resolveCycle("ENG", 6, { env })).id).toBe("cy-6");
      },
      [{ match: "LinCycles", data: CYCLES }],
    ),
  );

  test(
    "cycles are fetched live, never read from the cache",
    withSandbox(
      async (env, stub) => {
        seed(env);
        await resolveCycle("ENG", "current", { env });
        expect(stub.calls).toHaveLength(1);
        expect(stub.calls[0]?.operation).toBe("LinCycles");
        expect(stub.calls[0]?.variables).toEqual({ teamId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa" });
      },
      [{ match: "LinCycles", data: CYCLES }],
    ),
  );

  test(
    "a missing cycle number lists the ones that exist",
    withSandbox(
      async (env) => {
        seed(env);
        const error = await expectLinError(() => resolveCycle("ENG", 99, { env }));
        expect(error.exitCode).toBe(EXIT.input);
        expect(error.hint).toBe("cycles: 6, 7, 8");
      },
      [{ match: "LinCycles", data: CYCLES }],
    ),
  );

  test(
    "no active cycle points at the numeric form",
    withSandbox(
      async (env) => {
        seed(env);
        const error = await expectLinError(() => resolveCycle("ENG", "current", { env }));
        expect(error.message).toBe("team ENG has no active cycle");
        expect(error.hint).toContain("cycle number");
      },
      [{ match: "LinCycles", data: { team: { activeCycle: null, cycles: { nodes: [] } } } }],
    ),
  );
});

describe("issue identifiers", () => {
  test("recognises identifiers and URLs, and normalises case", () => {
    expect(issueIdentifierFrom("ENG-42")).toBe("ENG-42");
    expect(issueIdentifierFrom("eng-42")).toBe("ENG-42");
    expect(issueIdentifierFrom("https://linear.app/acme/issue/ENG-42/fix-login")).toBe("ENG-42");
    expect(issueIdentifierFrom("https://linear.app/acme/issue/ENG-42")).toBe("ENG-42");
    expect(issueIdentifierFrom("issue")).toBeUndefined();
    expect(issueIdentifierFrom("ENG-")).toBeUndefined();
    expect(issueIdentifierFrom("https://github.com/acme/repo/pull/42")).toBeUndefined();
  });

  test("pulls an identifier out of a git branch name", () => {
    expect(issueIdentifierFromBranch("casey/eng-42-fix-login")).toBe("ENG-42");
    expect(issueIdentifierFromBranch("main")).toBeUndefined();
  });

  test(
    "a UUID passes through without a lookup",
    withSandbox(async (env, stub) => {
      const uuid = "11111111-1111-4111-8111-111111111111";
      expect(await resolveIssueUUID(uuid, { env })).toBe(uuid);
      expect(stub.calls).toHaveLength(0);
    }),
  );

  test(
    "an identifier costs one lookup",
    withSandbox(
      async (env, stub) => {
        const uuid = "99999999-9999-4999-8999-999999999999";
        expect(await resolveIssueUUID("ENG-42", { env })).toBe(uuid);
        expect(stub.calls).toHaveLength(1);
        expect(stub.calls[0]?.variables).toEqual({ id: "ENG-42" });
      },
      [{ match: "LinIssueId", data: { issue: { id: "99999999-9999-4999-8999-999999999999" } } }],
    ),
  );

  test(
    "an unusable reference is exit 2 and shows the accepted forms",
    withSandbox(async (env) => {
      const error = await expectLinError(() => resolveIssueUUID("not-an-issue!", { env }));
      expect(error.exitCode).toBe(EXIT.input);
      expect(error.hint).toContain("ENG-42");
    }),
  );
});
