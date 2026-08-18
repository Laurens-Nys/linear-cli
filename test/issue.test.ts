import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { toMeta, writeCached } from "../src/cache.ts";
import { keyFingerprint } from "../src/client.ts";
import {
  allPagesContinuation,
  blockerCell,
  branchCommand,
  continuation,
  createCommand,
  listCommand,
  listDocument,
  updateCommand,
  urlCommand,
  viewCommand,
} from "../src/commands/issue.ts";
import { EXIT, setFields } from "../src/out.ts";
import type { CommandSpec, Flags } from "../src/registry.ts";
import { captureStdout, mock, sandbox, type Mock, type MockResponse } from "./harness.ts";
import { WARM_DATA } from "./fixtures.ts";

const ENG = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const CASEY = "11111111-1111-4111-8111-111111111111";
const ALEX = "22222222-2222-4222-8222-222222222222";
const ENG42 = "f0f0f0f0-0001-4001-8001-f0f0f0f0f001";
const ENG41 = "f0f0f0f0-0002-4002-8002-f0f0f0f0f002";

interface RunOptions {
  args?: string[];
  flags?: Flags;
  team?: string;
  limit?: number;
  /** Extra files to drop in the sandbox, for `-d @file`. */
  files?: Record<string, string>;
}

/**
 * Run one command against the fetch stub with a warm metadata cache, so name
 * resolution answers from disk instead of firing a LinWarm request.
 */
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
  for (const [name, content] of Object.entries(options.files ?? {})) {
    writeFileSync(join(box.dir, name), content, "utf8");
  }

  const stub = mock(responses);
  const captured = captureStdout();
  try {
    setFields(options.flags?.["fields"]);
    await command.run({
      args: (options.args ?? []).map((arg) => arg.replace("<dir>", box.dir)),
      flags: Object.fromEntries(
        Object.entries(options.flags ?? {}).map(([flag, value]) => [
          flag,
          typeof value === "string" ? value.replace("<dir>", box.dir) : value,
        ]),
      ),
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

const LIST_NODES = [
  {
    identifier: "ENG-42",
    title: "Fix login redirect loop",
    state: { name: "In Progress" },
    assignee: { displayName: "casey" },
    priority: 2,
    updatedAt: "2026-07-30T09:15:00.000Z",
  },
  {
    identifier: "ENG-41",
    title: "Rotate webhook secrets, again",
    state: { name: "Todo" },
    assignee: { displayName: "alex" },
    priority: 3,
    updatedAt: "2026-07-29T18:02:00.000Z",
  },
  {
    identifier: "ENG-40",
    title: 'Handle "quoted" titles',
    state: { name: "Todo" },
    assignee: null,
    priority: 0,
    updatedAt: "2026-07-28T11:44:00.000Z",
  },
];

function listResponse(nodes: unknown[] = LIST_NODES, hasNextPage = false): MockResponse {
  return {
    match: "LinIssueList",
    data: { issues: { nodes, pageInfo: { hasNextPage, endCursor: "c50" } } },
  };
}

describe("continuation commands", () => {
  test("all-pages hints skip --after and do not duplicate --all-pages", () => {
    expect(
      allPagesContinuation("search", ["login redirect"], {
        projects: true,
        docs: true,
        after: "c2",
        "all-pages": true,
      }),
    ).toBe('lin search "login redirect" --projects --docs --all-pages');
  });

  test("cursor continuations still append --after last", () => {
    expect(continuation("search", ["login"], { projects: true, after: "old" }, "c4")).toBe(
      "lin search login --projects --after c4",
    );
  });
});

describe("issue list", () => {
  test("lists a team's open issues as a TOON table", async () => {
    await run(listCommand, { team: "ENG" }, [listResponse()], (output, stub) => {
      expect(stub.calls[0]?.operation).toBe("LinIssueList");
      expect(stub.calls[0]?.variables).toEqual({
        filter: {
          team: { id: { eq: ENG } },
          state: { type: { nin: ["completed", "canceled"] } },
        },
        first: 50,
        after: null,
        sort: [{ updatedAt: { order: "Descending" } }],
        archived: false,
      });
      expect(stub.calls[0]?.document).not.toContain("parent {");
      expect(stub.calls[0]?.document).not.toContain("labels(");
      expect(stub.calls[0]?.document).not.toContain("inverseRelations");
      expect(stub.calls[0]?.document).not.toContain(" url");
      expect(output).toBe(
        "issues[3]{id,title,state,assignee,priority,updated}:\n" +
          "  ENG-42,Fix login redirect loop,In Progress,casey,high,2026-07-30\n" +
          '  ENG-41,"Rotate webhook secrets, again",Todo,alex,medium,2026-07-29\n' +
          '  ENG-40,"Handle \\"quoted\\" titles",Todo,,none,2026-07-28\n',
      );
    });
  });

  test("--mine filters on the viewer and drops the assignee column", async () => {
    const mine = LIST_NODES.slice(0, 1).map(({ assignee: _assignee, ...node }) => node);
    await run(listCommand, { team: "ENG", flags: { mine: true } }, [listResponse(mine)], (output, stub) => {
      expect(stub.calls[0]?.document).not.toContain("assignee");
      expect(stub.calls[0]?.variables).toMatchObject({
        filter: { assignee: { isMe: { eq: true } } },
      });
      expect(output).toBe(
        "issues[1]{id,title,state,priority,updated}:\n  ENG-42,Fix login redirect loop,In Progress,high,2026-07-30\n",
      );
    });
  });

  test("no team and no scope is exit 2 naming --team", async () => {
    await expect(run(listCommand, {}, [])).rejects.toMatchObject({
      exitCode: EXIT.input,
      hint: expect.stringContaining("--team"),
    });
  });

  test("--assignee resolves the name to a user id", async () => {
    await run(listCommand, { team: "ENG", flags: { assignee: "alex" } }, [listResponse([])], (_output, stub) => {
      expect(stub.calls[0]?.variables).toMatchObject({ filter: { assignee: { id: { eq: ALEX } } } });
    });
  });

  test("--state replaces the open-state default and resolves against the team", async () => {
    await run(
      listCommand,
      { team: "ENG", flags: { state: "in progress", label: ["Bug", "Priority/P0"] } },
      [listResponse([])],
      (output, stub) => {
        expect(stub.calls[0]?.variables).toMatchObject({
          filter: {
            state: { id: { eq: "st-doing" } },
            and: [
              { labels: { some: { name: { eqIgnoreCase: "Bug" } } } },
              {
                labels: {
                  some: { name: { eqIgnoreCase: "P0" }, parent: { name: { eqIgnoreCase: "Priority" } } },
                },
              },
            ],
          },
        });
        expect(output).toBe("issues[0]:\n");
      },
    );
  });

  test("an unknown state is exit 2 with the team's states", async () => {
    // A miss refreshes the cache once before giving up, so the warm call answers.
    await expect(
      run(listCommand, { team: "ENG", flags: { state: "Shipped" } }, [{ match: "LinWarm", data: WARM_DATA }]),
    ).rejects.toMatchObject({
      exitCode: EXIT.input,
      message: 'team ENG has no state "Shipped"',
      hint: expect.stringContaining("In Progress"),
    });
  });

  test("--unassigned, --archived, --updated-since and --sort reach the query", async () => {
    await run(
      listCommand,
      {
        team: "ENG",
        flags: { unassigned: true, archived: true, "updated-since": "2026-07-01", sort: "priority" },
      },
      [listResponse([])],
      (_output, stub) => {
        expect(stub.calls[0]?.variables).toEqual({
          filter: {
            team: { id: { eq: ENG } },
            assignee: { null: true },
            updatedAt: { gte: "2026-07-01" },
          },
          first: 50,
          after: null,
          sort: [{ priority: { order: "Ascending" } }],
          archived: true,
        });
      },
    );
  });

  test("two assignee filters at once is exit 2", async () => {
    await expect(
      run(listCommand, { team: "ENG", flags: { mine: true, unassigned: true } }, []),
    ).rejects.toMatchObject({ exitCode: EXIT.input, hint: expect.stringContaining("--mine") });
  });

  test("a malformed --updated-since is exit 2 with the format", async () => {
    await expect(
      run(listCommand, { team: "ENG", flags: { "updated-since": "last tuesday" } }, []),
    ).rejects.toMatchObject({
      exitCode: EXIT.input,
      message: expect.stringContaining("YYYY-MM-DD"),
    });
  });

  test("another page appends the exact continuation command", async () => {
    await run(
      listCommand,
      { team: "ENG", limit: 2, flags: { team: "ENG", label: ["Bug"] } },
      [listResponse(LIST_NODES.slice(0, 2), true)],
      (output) => {
        expect(output.split("\n").at(-2)).toBe(
          "# more · lin issue list --team ENG --label Bug --after c50",
        );
      },
    );
  });

  test("--fields selects optional columns from the same query", async () => {
    const nodes = [
      {
        ...LIST_NODES[0],
        url: "https://linear.app/acme/issue/ENG-42",
        parent: { identifier: "ENG-30" },
        project: { name: "Onboarding" },
        labels: { nodes: [{ name: "Bug", parent: null }, { name: "P0", parent: { name: "Priority" } }] },
        inverseRelations: { nodes: [{ type: "blocks" }, { type: "related" }] },
      },
    ];
    await run(
      listCommand,
      { team: "ENG", flags: { fields: "id,parent,project,labels,blockers,url" } },
      [listResponse(nodes)],
      (output, stub) => {
        expect(stub.calls).toHaveLength(1);
        expect(stub.calls[0]?.document).toContain("parent { identifier }");
        expect(stub.calls[0]?.document).toContain("inverseRelations(first: 20)");
        expect(output).toBe(
          "issues[1]{id,parent,project,labels,blockers,url}:\n" +
            '  ENG-42,ENG-30,Onboarding,"Bug,Priority/P0",1,https://linear.app/acme/issue/ENG-42\n',
        );
      },
    );
  });

  test("--fields id,title does not select optional issue fields", async () => {
    await run(
      listCommand,
      { team: "ENG", flags: { fields: "id,title" } },
      [listResponse(LIST_NODES.slice(0, 1))],
      (output, stub) => {
        expect(stub.calls[0]?.document).toBe(listDocument(true));
        expect(output).toBe("issues[1]{id,title}:\n  ENG-42,Fix login redirect loop\n");
      },
    );
  });

  test("truncated labels and blockers do not look exact", async () => {
    const nodes = [
      {
        ...LIST_NODES[0],
        labels: {
          nodes: [{ name: "Bug", parent: null }],
          pageInfo: { hasNextPage: true },
        },
        inverseRelations: {
          nodes: [{ type: "blocks" }, { type: "related" }],
          pageInfo: { hasNextPage: true },
        },
      },
    ];
    await run(
      listCommand,
      { team: "ENG", flags: { fields: "id,labels,blockers" } },
      [listResponse(nodes)],
      (output, stub) => {
        expect(stub.calls[0]?.document).toContain("pageInfo { hasNextPage }");
        expect(output).toBe("issues[1]{id,labels,blockers}:\n  ENG-42,\"Bug,…\",1+\n");
      },
    );
  });

  test("a capped blockers page without hasNextPage stays an exact count", () => {
    expect(blockerCell({ nodes: [{ type: "blocks" }, { type: "related" }] })).toBe(1);
    expect(blockerCell({ nodes: [{ type: "blocks" }], pageInfo: { hasNextPage: false } })).toBe(1);
    expect(blockerCell({ nodes: [{ type: "blocks" }], pageInfo: { hasNextPage: true } })).toBe("1+");
  });

  test("bare --fields lists issue list columns without printing rows", async () => {
    await expect(run(listCommand, { team: "ENG", flags: { fields: true } }, [listResponse()])).rejects.toMatchObject({
      exitCode: EXIT.input,
      message: "--fields needs a column list",
      hint: "fields: id, title, state, assignee, priority, updated, parent, project, labels, blockers, url",
    });
  });

  test("--all-pages concatenates pages and drops the continuation", async () => {
    await run(
      listCommand,
      { team: "ENG", limit: 2, flags: { "all-pages": true } },
      [
        {
          match: "LinIssueList",
          data: {
            issues: { nodes: LIST_NODES.slice(0, 2), pageInfo: { hasNextPage: true, endCursor: "c2" } },
          },
        },
        {
          match: "LinIssueList",
          data: {
            issues: { nodes: LIST_NODES.slice(2), pageInfo: { hasNextPage: false, endCursor: "c3" } },
          },
        },
      ],
      (output, stub) => {
        expect(stub.calls).toHaveLength(2);
        expect(stub.calls[0]?.variables).toMatchObject({ first: 2, after: null });
        expect(stub.calls[1]?.variables).toMatchObject({ first: 2, after: "c2" });
        expect(output).toBe(
          "issues[3]{id,title,state,assignee,priority,updated}:\n" +
            "  ENG-42,Fix login redirect loop,In Progress,casey,high,2026-07-30\n" +
            '  ENG-41,"Rotate webhook secrets, again",Todo,alex,medium,2026-07-29\n' +
            '  ENG-40,"Handle \\"quoted\\" titles",Todo,,none,2026-07-28\n',
        );
        expect(output).not.toContain("# ");
      },
    );
  });

  test("--after + --all-pages starts at the cursor", async () => {
    await run(
      listCommand,
      { team: "ENG", flags: { after: "c2", "all-pages": true } },
      [
        {
          match: "LinIssueList",
          data: {
            issues: { nodes: LIST_NODES.slice(2), pageInfo: { hasNextPage: false, endCursor: "c3" } },
          },
        },
      ],
      (_output, stub) => {
        expect(stub.calls).toHaveLength(1);
        expect(stub.calls[0]?.variables).toMatchObject({ after: "c2" });
      },
    );
  });

  test("an empty --all-pages list is a header and no continuation", async () => {
    await run(
      listCommand,
      { team: "ENG", flags: { "all-pages": true } },
      [listResponse([], false)],
      (output, stub) => {
        expect(stub.calls).toHaveLength(1);
        expect(output).toBe("issues[0]:\n");
      },
    );
  });

  test("a repeated pagination cursor is exit 1", async () => {
    await expect(
      run(
        listCommand,
        { team: "ENG", flags: { "all-pages": true } },
        [
          {
            match: "LinIssueList",
            data: {
              issues: { nodes: LIST_NODES.slice(0, 1), pageInfo: { hasNextPage: true, endCursor: "loop" } },
            },
          },
          {
            match: "LinIssueList",
            data: {
              issues: { nodes: LIST_NODES.slice(1, 2), pageInfo: { hasNextPage: true, endCursor: "loop" } },
            },
          },
        ],
      ),
    ).rejects.toMatchObject({
      exitCode: EXIT.api,
      message: "pagination cursor repeated",
    });
  });

  test("a missing pagination cursor is exit 1", async () => {
    await expect(
      run(
        listCommand,
        { team: "ENG", flags: { "all-pages": true } },
        [
          {
            match: "LinIssueList",
            data: {
              issues: { nodes: LIST_NODES.slice(0, 1), pageInfo: { hasNextPage: true, endCursor: null } },
            },
          },
        ],
      ),
    ).rejects.toMatchObject({
      exitCode: EXIT.api,
      message: "pagination cursor missing",
    });
  });
});

const VIEW_ISSUE = {
  identifier: "ENG-42",
  title: "Fix login redirect loop",
  priority: 2,
  estimate: 3,
  dueDate: "2026-08-15",
  createdAt: "2026-07-20T10:00:00.000Z",
  updatedAt: "2026-07-30T09:15:00.000Z",
  url: "https://linear.app/acme/issue/ENG-42",
  description: "## Context\nUsers bounce between /login and /app when the session cookie is stale.",
  state: { name: "In Progress" },
  assignee: { displayName: "casey" },
  team: { key: "ENG" },
  parent: { identifier: "ENG-30" },
  labels: { nodes: [{ name: "Bug", parent: null }, { name: "P0", parent: { name: "Priority" } }] },
  relations: { nodes: [{ type: "blocks", relatedIssue: { identifier: "ENG-43" } }] },
  inverseRelations: {
    nodes: [
      { type: "blocks", issue: { identifier: "ENG-41" } },
      { type: "related", issue: { identifier: "ENG-38" } },
    ],
  },
  attachments: { nodes: [{ title: "PR 123", url: "https://github.com/acme/app/pull/123" }] },
  cycle: { number: 7 },
  project: { name: "Onboarding" },
  projectMilestone: { name: "Beta" },
  comments: {
    nodes: [
      {
        id: "9f2ab41c-1111-4111-8111-999999999999",
        createdAt: "2026-07-29T08:00:00.000Z",
        body: "Repro:  stale cookie,\nthen any deep link",
        resolvedAt: null,
        user: { displayName: "casey" },
        botActor: null,
      },
      {
        id: "1c0d88ee-2222-4222-8222-888888888888",
        createdAt: "2026-07-30T09:15:00.000Z",
        body: "Fix pushed for review",
        resolvedAt: "2026-07-30T10:00:00.000Z",
        user: null,
        botActor: { name: "agent" },
      },
    ],
  },
};

describe("issue view", () => {
  test("prints the record, the body between fences, and the comment table", async () => {
    await run(
      viewCommand,
      { args: ["eng-42"] },
      [{ match: "LinIssueView", data: { issue: VIEW_ISSUE } }],
      (output, stub) => {
        expect(stub.calls[0]?.variables).toEqual({ id: "ENG-42" });
        expect(stub.calls[0]?.document).toContain("comments(last: 3)");
        expect(output).toBe(
          [
            "id: ENG-42",
            "title: Fix login redirect loop",
            "state: In Progress",
            "assignee: casey",
            "priority: high",
            "team: ENG",
            "parent: ENG-30",
            "labels[2]: Bug,Priority/P0",
            "blocks[1]: ENG-43",
            "blockedBy[1]: ENG-41",
            "attachments[1]: PR 123 · https://github.com/acme/app/pull/123",
            "estimate: 3",
            "cycle: 7",
            "project: Onboarding",
            "milestone: Beta",
            "due: 2026-08-15",
            "created: 2026-07-20",
            "updated: 2026-07-30",
            "url: https://linear.app/acme/issue/ENG-42",
            "---",
            "## Context",
            "Users bounce between /login and /app when the session cookie is stale.",
            "---",
            "comments[2]{ref,author,date,body}:",
            '  9f2ab41c,casey,2026-07-29,"Repro: stale cookie, then any deep link"',
            "  1c0d88ee,agent,2026-07-30,Fix pushed for review (resolved)",
            "",
          ].join("\n"),
        );
      },
    );
  });

  test("empty fields are omitted entirely", async () => {
    const bare = {
      ...VIEW_ISSUE,
      description: null,
      assignee: null,
      estimate: null,
      dueDate: null,
      parent: null,
      cycle: null,
      project: null,
      projectMilestone: null,
      labels: { nodes: [] },
      relations: { nodes: [] },
      inverseRelations: { nodes: [] },
      attachments: { nodes: [] },
      comments: { nodes: [] },
    };
    await run(viewCommand, { args: ["ENG-42"] }, [{ match: "LinIssueView", data: { issue: bare } }], (output) => {
      expect(output).toBe(
        [
          "id: ENG-42",
          "title: Fix login redirect loop",
          "state: In Progress",
          "priority: high",
          "team: ENG",
          "created: 2026-07-20",
          "updated: 2026-07-30",
          "url: https://linear.app/acme/issue/ENG-42",
          "comments[0]:",
          "",
        ].join("\n"),
      );
    });
  });

  test("--no-body and --comments all shape the document", async () => {
    await run(
      viewCommand,
      { args: ["ENG-42"], flags: { "no-body": true, comments: "all" } },
      [{ match: "LinIssueView", data: { issue: { ...VIEW_ISSUE, description: undefined } } }],
      (_output, stub) => {
        expect(stub.calls[0]?.document).not.toContain("description");
        expect(stub.calls[0]?.document).toContain("comments(last: 100)");
      },
    );
  });

  test("--comments 0 drops the comment selection altogether", async () => {
    const { comments: _comments, ...withoutComments } = VIEW_ISSUE;
    await run(
      viewCommand,
      { args: ["ENG-42"], flags: { comments: "0" } },
      [{ match: "LinIssueView", data: { issue: withoutComments } }],
      (output, stub) => {
        expect(stub.calls[0]?.document).not.toContain("comments(");
        expect(output).not.toContain("comments");
      },
    );
  });
});

describe("issue create", () => {
  const receipt = {
    match: "LinIssueCreate",
    data: {
      issueCreate: {
        issue: { identifier: "ENG-57", url: "https://linear.app/acme/issue/ENG-57" },
      },
    },
  };

  test("resolves every name and returns a create receipt", async () => {
    await run(
      createCommand,
      {
        team: "ENG",
        flags: {
          title: "Fix login redirect loop",
          body: "Users bounce between /login and /app.",
          assignee: "me",
          priority: "high",
          estimate: 3,
          state: "Todo",
          label: ["Bug"],
          project: "Onboarding",
          due: "2026-08-15",
        },
      },
      [receipt],
      (output, stub) => {
        expect(stub.calls[0]?.operation).toBe("LinIssueCreate");
        expect(stub.calls[0]?.variables).toEqual({
          input: {
            title: "Fix login redirect loop",
            description: "Users bounce between /login and /app.",
            stateId: "st-todo",
            assigneeId: CASEY,
            priority: 2,
            estimate: 3,
            projectId: "cccccccc-3333-4333-8333-cccccccccccc",
            dueDate: "2026-08-15",
            labelIds: ["lb-bug"],
            teamId: ENG,
          },
        });
        expect(output).toBe("created: ENG-57\nurl: https://linear.app/acme/issue/ENG-57\n");
      },
    );
  });

  test("-d @file reads the description from disk and --template resolves by name", async () => {
    await run(
      createCommand,
      {
        team: "ENG",
        files: { "body.md": "## Context\nStale cookies.\n" },
        flags: { title: "Rotate webhook secrets", body: "@<dir>/body.md", template: "Bug report" },
      },
      [receipt],
      (_output, stub) => {
        expect(stub.calls[0]?.variables).toMatchObject({
          input: { description: "## Context\nStale cookies.\n", templateId: "tpl-bug" },
        });
      },
    );
  });

  test("-d @missing is exit 2", async () => {
    await expect(
      run(createCommand, { team: "ENG", flags: { title: "x", body: "@<dir>/nope.md" } }, []),
    ).rejects.toMatchObject({ exitCode: EXIT.input });
  });

  test("no title and no template is exit 2", async () => {
    await expect(run(createCommand, { team: "ENG", flags: {} }, [])).rejects.toMatchObject({
      exitCode: EXIT.input,
      message: "issue create needs a title",
    });
  });

  test("an unknown priority word is exit 2 with the vocabulary", async () => {
    await expect(
      run(createCommand, { team: "ENG", flags: { title: "x", priority: "P0" } }, []),
    ).rejects.toMatchObject({ exitCode: EXIT.input, hint: expect.stringContaining("urgent") });
  });

  test("--milestone without a project is exit 2", async () => {
    await expect(
      run(createCommand, { team: "ENG", flags: { title: "x", milestone: "Beta" } }, []),
    ).rejects.toMatchObject({ exitCode: EXIT.input, hint: expect.stringContaining("--project") });
  });
});

describe("issue update", () => {
  const before = {
    match: "LinIssueBefore",
    data: {
      issues: {
        nodes: [
          {
            id: ENG42,
            identifier: "ENG-42",
            team: { key: "ENG" },
            state: { name: "Todo" },
            assignee: null,
          },
        ],
      },
    },
  };

  test("reads the before state, mutates, and prints only what moved", async () => {
    await run(
      updateCommand,
      { args: ["ENG-42"], flags: { state: "In Progress", assignee: "casey" } },
      [
        before,
        {
          match: "LinIssueUpdate",
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
        expect(stub.calls[0]?.variables).toEqual({ ids: ["ENG-42"], first: 50 });
        expect(stub.calls[1]?.operation).toBe("LinIssueUpdate");
        expect(stub.calls[1]?.variables).toEqual({
          id: ENG42,
          input: { stateId: "st-doing", assigneeId: CASEY },
        });
        expect(output).toBe("ENG-42:\n  state: Todo -> In Progress\n  assignee: none -> casey\n");
      },
    );
  });

  test("two ids go through issueBatchUpdate with UUIDs", async () => {
    await run(
      updateCommand,
      { args: ["ENG-42", "ENG-41"], flags: { priority: "urgent" } },
      [
        {
          match: "LinIssueBefore",
          data: {
            issues: {
              nodes: [
                { id: ENG41, identifier: "ENG-41", team: { key: "ENG" }, priority: 3 },
                { id: ENG42, identifier: "ENG-42", team: { key: "ENG" }, priority: 0 },
              ],
            },
          },
        },
        {
          match: "LinIssueBatchUpdate",
          data: {
            issueBatchUpdate: {
              issues: [
                { identifier: "ENG-42", priority: 1 },
                { identifier: "ENG-41", priority: 1 },
              ],
            },
          },
        },
      ],
      (output, stub) => {
        expect(stub.calls[1]?.operation).toBe("LinIssueBatchUpdate");
        expect(stub.calls[1]?.variables).toEqual({ ids: [ENG42, ENG41], input: { priority: 1 } });
        // Receipts follow the order the caller asked for, not the API's.
        expect(output).toBe("ENG-42:\n  priority: none -> urgent\nENG-41:\n  priority: medium -> urgent\n");
      },
    );
  });

  test("--add-label uses issueAddLabel and reports the new label set", async () => {
    await run(
      updateCommand,
      { args: ["ENG-42"], flags: { "add-label": ["Bug"] } },
      [
        {
          match: "LinIssueBefore",
          data: {
            issues: {
              nodes: [{ id: ENG42, identifier: "ENG-42", team: { key: "ENG" }, labels: { nodes: [] } }],
            },
          },
        },
        {
          match: "LinIssueAddLabel",
          data: {
            issueAddLabel: { issue: { identifier: "ENG-42", labels: { nodes: [{ name: "Bug" }] } } },
          },
        },
      ],
      (output, stub) => {
        expect(stub.calls[1]?.operation).toBe("LinIssueAddLabel");
        expect(stub.calls[1]?.variables).toEqual({ id: ENG42, labelId: "lb-bug" });
        expect(output).toBe("ENG-42:\n  labels: none -> Bug\n");
      },
    );
  });

  test("an unchanged issue says so rather than inventing a diff", async () => {
    await run(
      updateCommand,
      { args: ["ENG-42"], flags: { priority: "medium" } },
      [
        {
          match: "LinIssueBefore",
          data: { issues: { nodes: [{ id: ENG42, identifier: "ENG-42", team: { key: "ENG" }, priority: 3 }] } },
        },
        {
          match: "LinIssueUpdate",
          data: { issueUpdate: { issue: { identifier: "ENG-42", priority: 3 } } },
        },
      ],
      (output) => {
        expect(output).toBe("ENG-42: unchanged\n");
      },
    );
  });

  test("a batch spanning two teams is fine for a team-agnostic field", async () => {
    await run(
      updateCommand,
      { args: ["ENG-42", "DES-1"], flags: { priority: "low" } },
      [
        {
          match: "LinIssueBefore",
          data: {
            issues: {
              nodes: [
                { id: ENG42, identifier: "ENG-42", team: { key: "ENG" }, priority: 0 },
                { id: ENG41, identifier: "DES-1", team: { key: "DES" }, priority: 0 },
              ],
            },
          },
        },
        {
          match: "LinIssueBatchUpdate",
          data: {
            issueBatchUpdate: {
              issues: [
                { identifier: "ENG-42", priority: 4 },
                { identifier: "DES-1", priority: 4 },
              ],
            },
          },
        },
      ],
      (output) => {
        expect(output).toBe("ENG-42:\n  priority: none -> low\nDES-1:\n  priority: none -> low\n");
      },
    );
  });

  test("a state name across two teams is exit 2 naming --team", async () => {
    await expect(
      run(
        updateCommand,
        { args: ["ENG-42", "DES-1"], flags: { state: "Done" } },
        [
          {
            match: "LinIssueBefore",
            data: {
              issues: {
                nodes: [
                  { id: ENG42, identifier: "ENG-42", team: { key: "ENG" }, state: { name: "Todo" } },
                  { id: ENG41, identifier: "DES-1", team: { key: "DES" }, state: { name: "Todo" } },
                ],
              },
            },
          },
        ],
      ),
    ).rejects.toMatchObject({ exitCode: EXIT.input, hint: expect.stringContaining("--team") });
  });

  test("an identifier the query did not return is exit 4", async () => {
    await expect(
      run(
        updateCommand,
        { args: ["ENG-42", "ENG-99"], flags: { priority: "low" } },
        [{ match: "LinIssueBefore", data: { issues: { nodes: [{ id: ENG42, identifier: "ENG-42", team: { key: "ENG" }, priority: 0 }] } } }],
      ),
    ).rejects.toMatchObject({ exitCode: EXIT.notFound, message: "no issue ENG-99" });
  });

  test("more than 50 ids is exit 2 before any request", async () => {
    const ids = Array.from({ length: 51 }, (_value, index) => `ENG-${index + 1}`);
    await expect(run(updateCommand, { args: ids, flags: { priority: "low" } }, [])).rejects.toMatchObject({
      exitCode: EXIT.input,
    });
  });

  test("nothing to change is exit 2 listing the fields", async () => {
    await expect(run(updateCommand, { args: ["ENG-42"] }, [])).rejects.toMatchObject({
      exitCode: EXIT.input,
      hint: expect.stringContaining("add-label"),
    });
  });
});

describe("issue branch and url", () => {
  test("branch prints Linear's suggested branch name", async () => {
    await run(
      branchCommand,
      { args: ["ENG-42"] },
      [{ match: "LinIssueBranch", data: { issue: { branchName: "casey/eng-42-fix-login-redirect-loop" } } }],
      (output) => {
        expect(output).toBe("casey/eng-42-fix-login-redirect-loop\n");
      },
    );
  });

  test("url prints the canonical URL", async () => {
    await run(
      urlCommand,
      { args: ["https://linear.app/acme/issue/ENG-42"] },
      [{ match: "LinIssueUrl", data: { issue: { url: "https://linear.app/acme/issue/ENG-42" } } }],
      (output, stub) => {
        expect(stub.calls[0]?.variables).toEqual({ id: "ENG-42" });
        expect(output).toBe("https://linear.app/acme/issue/ENG-42\n");
      },
    );
  });
});
