import { describe, expect, test } from "bun:test";
import { toMeta, writeCached } from "../src/cache.ts";
import { keyFingerprint } from "../src/client.ts";
import {
  age,
  doneCommand,
  git,
  lsCommand,
  searchCommand,
  startCommand,
  triageCommand,
} from "../src/commands/aliases.ts";
import { EXIT } from "../src/out.ts";
import type { CommandSpec, Flags } from "../src/registry.ts";
import { captureStdout, mock, sandbox, type Mock, type MockResponse } from "./harness.ts";
import { WARM_DATA } from "./fixtures.ts";

const ENG = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const CASEY = "11111111-1111-4111-8111-111111111111";
const ENG42 = "f0f0f0f0-0001-4001-8001-f0f0f0f0f001";
const DAY_MS = 24 * 60 * 60 * 1000;

interface RunOptions {
  args?: string[];
  flags?: Flags;
  team?: string;
  limit?: number;
}

async function run(
  command: CommandSpec,
  options: RunOptions,
  responses: readonly MockResponse[],
  check: (output: string, stub: Mock) => void = () => {},
): Promise<void> {
  const box = sandbox();
  writeCached(
    { ...toMeta(WARM_DATA, keyFingerprint(box.env)), fetchedAt: new Date().toISOString() },
    box.env,
  );

  const stub = mock(responses);
  const captured = captureStdout();
  try {
    await command.run({
      args: options.args ?? [],
      flags: options.flags ?? {},
      config: { team: options.team, limit: options.limit ?? 50 },
      command,
    });
    captured.restore();
    check(captured.text(), stub);
  } finally {
    captured.restore();
    stub.restore();
    box.cleanup();
  }
}

/** Replace the git seam for one test. */
async function withBranch(name: string | undefined, body: () => Promise<void>): Promise<void> {
  const original = git.branch;
  git.branch = () => name;
  try {
    await body();
  } finally {
    git.branch = original;
  }
}

describe("lin ls", () => {
  test("my open issues, newest first, without the assignee column", async () => {
    await run(
      lsCommand,
      { team: "ENG" },
      [
        {
          match: "LinIssueList",
          data: {
            issues: {
              nodes: [
                {
                  identifier: "ENG-42",
                  title: "Fix login redirect loop",
                  state: { name: "In Progress" },
                  priority: 2,
                  updatedAt: "2026-07-30T09:15:00.000Z",
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: "c1" },
            },
          },
        },
      ],
      (output, stub) => {
        expect(stub.calls[0]?.document).not.toContain("assignee {");
        expect(stub.calls[0]?.variables).toEqual({
          filter: {
            assignee: { isMe: { eq: true } },
            state: { type: { nin: ["completed", "canceled"] } },
            team: { id: { eq: ENG } },
          },
          first: 50,
          after: null,
          sort: [{ updatedAt: { order: "Descending" } }],
          archived: false,
        });
        expect(output).toBe(
          "issues[1]{id,title,state,priority,updated}:\n  ENG-42,Fix login redirect loop,In Progress,high,2026-07-30\n",
        );
      },
    );
  });

  test("without a configured team it spans the workspace", async () => {
    await run(
      lsCommand,
      {},
      [{ match: "LinIssueList", data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }],
      (output, stub) => {
        expect(stub.calls[0]?.variables).toMatchObject({ filter: { assignee: { isMe: { eq: true } } } });
        expect(stub.calls[0]?.variables).not.toMatchObject({ filter: { team: {} } });
        expect(output).toBe("issues[0]:\n");
      },
    );
  });
});

const TARGET = {
  match: "LinIssueTarget",
  data: {
    issue: {
      id: ENG42,
      identifier: "ENG-42",
      team: { key: "ENG" },
      state: { name: "Todo" },
      assignee: null,
      branchName: "casey/eng-42-fix-login-redirect-loop",
    },
  },
};

describe("lin start", () => {
  test("assigns me, moves to the first started state, and prints the branch last", async () => {
    await run(
      startCommand,
      { args: ["ENG-42"] },
      [
        TARGET,
        {
          match: "LinIssueMove",
          data: {
            issueUpdate: {
              issue: {
                identifier: "ENG-42",
                state: { name: "In Progress" },
                assignee: { displayName: "casey" },
              },
            },
          },
        },
      ],
      (output, stub) => {
        expect(stub.calls[1]?.operation).toBe("LinIssueMove");
        // st-doing is position 3, the lowest of the two started states.
        expect(stub.calls[1]?.variables).toEqual({
          id: ENG42,
          input: { stateId: "st-doing", assigneeId: CASEY },
        });
        expect(output).toBe(
          "ENG-42:\n" +
            "  state: Todo -> In Progress\n" +
            "  assignee: none -> casey\n" +
            "casey/eng-42-fix-login-redirect-loop\n",
        );
      },
    );
  });

  test("with no argument it takes the identifier from the git branch", async () => {
    await withBranch("casey/eng-42-fix-login-redirect-loop", async () => {
      await run(
        startCommand,
        {},
        [
          TARGET,
          {
            match: "LinIssueMove",
            data: {
              issueUpdate: {
                issue: { identifier: "ENG-42", state: { name: "In Progress" }, assignee: { displayName: "casey" } },
              },
            },
          },
        ],
        (_output, stub) => {
          expect(stub.calls[0]?.variables).toEqual({ id: "ENG-42" });
        },
      );
    });
  });

  test("a branch with no identifier is exit 2", async () => {
    await withBranch("main", async () => {
      await expect(run(startCommand, {}, [])).rejects.toMatchObject({
        exitCode: EXIT.input,
        message: "start needs an issue id",
      });
    });
  });
});

describe("lin done", () => {
  test("moves to the first completed state and asks for no branch name", async () => {
    await run(
      doneCommand,
      { args: ["ENG-42"] },
      [
        TARGET,
        {
          match: "LinIssueMove",
          data: {
            issueUpdate: { issue: { identifier: "ENG-42", state: { name: "Done" }, assignee: null } },
          },
        },
      ],
      (output, stub) => {
        expect(stub.calls[0]?.document).not.toContain("branchName");
        expect(stub.calls[1]?.variables).toEqual({ id: ENG42, input: { stateId: "st-done" } });
        expect(output).toBe("ENG-42:\n  state: Todo -> Done\n");
      },
    );
  });
});

describe("lin triage", () => {
  test("oldest first, with an age column in whole days", async () => {
    const created = new Date(Date.now() - 12 * DAY_MS - 3600_000).toISOString();
    await run(
      triageCommand,
      { team: "ENG" },
      [
        {
          match: "LinTriage",
          data: {
            issues: {
              nodes: [
                { identifier: "ENG-38", title: "Upgrade to Bun 1.3", createdAt: created, priority: 0 },
              ],
              pageInfo: { hasNextPage: false, endCursor: "c1" },
            },
          },
        },
      ],
      (output, stub) => {
        expect(stub.calls[0]?.document).toContain("createdAt: { order: Ascending }");
        expect(stub.calls[0]?.variables).toEqual({
          filter: { team: { id: { eq: ENG } }, state: { type: { eq: "triage" } } },
          first: 50,
          after: null,
        });
        expect(output).toBe("issues[1]{id,title,age,priority}:\n  ENG-38,Upgrade to Bun 1.3,12d,none\n");
      },
    );
  });

  test("age counts whole days and never goes negative", () => {
    const now = Date.parse("2026-08-01T12:00:00.000Z");
    expect(age("2026-07-20T10:00:00.000Z", now)).toBe("12d");
    expect(age("2026-08-01T11:00:00.000Z", now)).toBe("0d");
    expect(age("2026-08-02T11:00:00.000Z", now)).toBe("0d");
  });

  test("no team is exit 2 naming --team", async () => {
    await expect(run(triageCommand, {}, [])).rejects.toMatchObject({
      exitCode: EXIT.input,
      hint: expect.stringContaining("--team"),
    });
  });
});

describe("lin search", () => {
  const ISSUES = {
    totalCount: 19,
    nodes: [
      {
        identifier: "ENG-42",
        title: "Fix login redirect loop",
        state: { name: "In Progress" },
        description: "Users bounce between /login and /app.",
      },
      {
        identifier: "ENG-40",
        title: "Handle stale sessions",
        state: { name: "Todo" },
        description: null,
      },
    ],
    pageInfo: { hasNextPage: true, endCursor: "c2" },
  };

  test("searches issues and counts the remainder exactly", async () => {
    await run(
      searchCommand,
      { args: ["login"], limit: 2 },
      [{ match: "LinSearch", data: { searchIssues: ISSUES } }],
      (output, stub) => {
        expect(stub.calls[0]?.variables).toEqual({ term: "login", first: 2, after: null });
        expect(output).toBe(
          "issues[2]{id,title,state,snippet}:\n" +
            "  ENG-42,Fix login redirect loop,In Progress,Users bounce between /login and /app.\n" +
            "  ENG-40,Handle stale sessions,Todo,\n" +
            "# 17 more · lin search login --after c2\n",
        );
      },
    );
  });

  test("a long description is clipped to 80 characters", async () => {
    await run(
      searchCommand,
      { args: ["login"] },
      [
        {
          match: "LinSearch",
          data: {
            searchIssues: {
              totalCount: 1,
              nodes: [
                {
                  identifier: "ENG-42",
                  title: "Fix login redirect loop",
                  state: { name: "Todo" },
                  description: "A".repeat(85),
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      ],
      (output) => {
        expect(output).toBe(
          `issues[1]{id,title,state,snippet}:\n  ENG-42,Fix login redirect loop,Todo,${"A".repeat(79)}…\n`,
        );
      },
    );
  });

  test("--projects and --docs widen the same request", async () => {
    await run(
      searchCommand,
      { args: ["webhook"], flags: { projects: true, docs: true } },
      [
        {
          match: "LinSearch",
          data: {
            searchIssues: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            searchProjects: {
              totalCount: 1,
              nodes: [{ slugId: "billing-4d5e6f", name: "Billing", status: { name: "Planned" } }],
            },
            searchDocuments: {
              totalCount: 1,
              nodes: [
                {
                  slugId: "runbook-7g8h9i",
                  title: "Webhook runbook",
                  project: { name: "Billing" },
                  updatedAt: "2026-07-28T11:44:00.000Z",
                },
              ],
            },
          },
        },
      ],
      (output, stub) => {
        expect(stub.calls).toHaveLength(1);
        expect(output).toBe(
          [
            "issues[0]:",
            "projects[1]{id,name,state}:",
            "  billing-4d5e6f,Billing,Planned",
            "docs[1]{id,title,project,updated}:",
            "  runbook-7g8h9i,Webhook runbook,Billing,2026-07-28",
            "",
          ].join("\n"),
        );
      },
    );
  });

  test("no term is exit 2", async () => {
    await expect(run(searchCommand, { args: [] }, [])).rejects.toMatchObject({ exitCode: EXIT.input });
  });
});
