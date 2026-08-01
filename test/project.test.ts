// project list / view / create / update / post / posts.
// Arguments in, GraphQL operation and variables out, exact rendered output.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toMeta, writeCached } from "../src/cache.ts";
import { keyFingerprint } from "../src/client.ts";
import {
  clip,
  healthWord,
  projectCreate,
  projectList,
  projectPost,
  projectPosts,
  projectUpdate,
  projectView,
} from "../src/commands/project.ts";
import type { Config } from "../src/config.ts";
import { EXIT, LinError } from "../src/out.ts";
import type { CommandSpec, Flags } from "../src/registry.ts";
import { WARM_DATA } from "./fixtures.ts";
import { captureStdout, mock, sandbox, type Mock, type MockResponse } from "./harness.ts";

interface Invocation {
  args?: string[];
  flags?: Flags;
  config?: Config;
}

/** Seed the cache, stub fetch, run one command, hand back stdout and the calls. */
async function run(
  command: CommandSpec,
  invocation: Invocation,
  responses: MockResponse[],
  check: (output: string, stub: Mock) => void,
): Promise<void> {
  const box = sandbox();
  writeCached(toMeta(WARM_DATA, keyFingerprint(box.env)), box.env);
  const stub = mock(responses);
  const captured = captureStdout();

  try {
    await command.run({
      args: invocation.args ?? [],
      flags: invocation.flags ?? {},
      config: invocation.config ?? { limit: 50 },
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

async function expectFailure(
  command: CommandSpec,
  invocation: Invocation,
  responses: MockResponse[],
): Promise<LinError> {
  const box = sandbox();
  writeCached(toMeta(WARM_DATA, keyFingerprint(box.env)), box.env);
  const stub = mock(responses);
  const captured = captureStdout();

  try {
    await command.run({
      args: invocation.args ?? [],
      flags: invocation.flags ?? {},
      config: invocation.config ?? { limit: 50 },
      command,
    });
    throw new Error("expected a LinError");
  } catch (error) {
    expect(error).toBeInstanceOf(LinError);
    return error as LinError;
  } finally {
    captured.restore();
    stub.restore();
    box.cleanup();
  }
}

const PROJECT_NODES = [
  {
    slugId: "onboarding-1a2b3c",
    name: "Onboarding",
    status: { name: "In Progress" },
    lead: { displayName: "casey" },
    targetDate: "2026-09-30",
  },
  {
    slugId: "billing-4d5e6f",
    name: "Billing",
    status: { name: "Planned" },
    lead: null,
    targetDate: null,
  },
];

const STATUSES = {
  projectStatuses: {
    nodes: [
      { id: "ps-backlog", name: "Backlog" },
      { id: "ps-planned", name: "Planned" },
      { id: "ps-progress", name: "In Progress" },
    ],
  },
};

const INITIATIVES = {
  initiatives: {
    nodes: [{ id: "in-1111-4111-8111-111111111111", slugId: "platform-9z8y7x", name: "Platform" }],
  },
};

describe("project list", () => {
  test("renders the curated columns and leaves empty cells empty", async () => {
    await run(
      projectList,
      {},
      [{ match: "LinProjectList", data: { projects: { nodes: PROJECT_NODES } } }],
      (output, stub) => {
        expect(stub.calls[0]?.operation).toBe("LinProjectList");
        expect(stub.calls[0]?.variables).toEqual({ filter: {}, first: 50, after: undefined });
        expect(output).toBe(
          "projects[2]{id,name,state,lead,target}:\n" +
            "  onboarding-1a2b3c,Onboarding,In Progress,casey,2026-09-30\n" +
            "  billing-4d5e6f,Billing,Planned,,\n",
        );
      },
    );
  });

  test("team, initiative and state become one resolved filter", async () => {
    await run(
      projectList,
      { flags: { initiative: "Platform", state: "Planned" }, config: { team: "ENG", limit: 20 } },
      [
        { match: "LinInitiativeLookup", data: INITIATIVES },
        { match: "LinProjectStatuses", data: STATUSES },
        { match: "LinProjectList", data: { projects: { nodes: [] } } },
      ],
      (output, stub) => {
        expect(stub.calls.map((call) => call.operation)).toEqual([
          "LinInitiativeLookup",
          "LinProjectStatuses",
          "LinProjectList",
        ]);
        expect(stub.calls[2]?.variables).toEqual({
          filter: {
            accessibleTeams: { some: { id: { eq: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa" } } },
            initiatives: { some: { id: { eq: "in-1111-4111-8111-111111111111" } } },
            status: { id: { eq: "ps-planned" } },
          },
          first: 20,
          after: undefined,
        });
        expect(output).toBe("projects[0]:\n");
      },
    );
  });

  test("an unknown state is exit 2 and lists the states", async () => {
    const error = await expectFailure(projectList, { flags: { state: "Shipping" } }, [
      { match: "LinProjectStatuses", data: STATUSES },
    ]);
    expect(error.exitCode).toBe(EXIT.input);
    expect(error.message).toBe('no project state "Shipping"');
    expect(error.hint).toBe("states: Backlog, Planned, In Progress");
  });
});

describe("project view", () => {
  test("record, fenced content, milestones and the last posts", async () => {
    await run(
      projectView,
      { args: ["Onboarding"] },
      [
        {
          match: "LinProjectView",
          data: {
            project: {
              slugId: "onboarding-1a2b3c",
              name: "Onboarding",
              url: "https://linear.app/acme/project/onboarding-1a2b3c",
              content: "## Goal\nGet the first ten teams live.",
              progress: 0.75,
              health: "onTrack",
              startDate: "2026-07-01",
              targetDate: "2026-09-30",
              updatedAt: "2026-07-30T09:15:00.000Z",
              status: { name: "In Progress" },
              lead: { displayName: "casey" },
              teams: { nodes: [{ key: "ENG" }, { key: "DES" }] },
              projectMilestones: {
                nodes: [
                  { id: "9f2ab41c-1111-4111-8111-111111111111", name: "Beta", targetDate: "2026-08-15", progress: 40 },
                  { id: "1c0d88ee-2222-4222-8222-222222222222", name: "GA", targetDate: null, progress: 0 },
                ],
              },
              projectUpdates: {
                nodes: [
                  {
                    createdAt: "2026-07-30T09:00:00.000Z",
                    health: "onTrack",
                    body: "Beta is out to five teams.",
                    user: { displayName: "casey" },
                  },
                ],
              },
            },
          },
        },
      ],
      (output, stub) => {
        expect(stub.calls[0]?.operation).toBe("LinProjectView");
        expect(stub.calls[0]?.variables).toEqual({ id: "cccccccc-3333-4333-8333-cccccccccccc" });
        expect(output).toBe(
          [
            "id: onboarding-1a2b3c",
            "name: Onboarding",
            "state: In Progress",
            "health: on-track",
            "lead: casey",
            "teams[2]: ENG,DES",
            "start: 2026-07-01",
            "target: 2026-09-30",
            "progress: 75%",
            "updated: 2026-07-30",
            "url: https://linear.app/acme/project/onboarding-1a2b3c",
            "---",
            "## Goal",
            "Get the first ten teams live.",
            "---",
            "milestones[2]{id,name,target,progress}:",
            "  9f2ab41c,Beta,2026-08-15,40%",
            "  1c0d88ee,GA,,0%",
            "posts[1]{date,author,health,body}:",
            "  2026-07-30,casey,on-track,Beta is out to five teams.",
            "",
          ].join("\n"),
        );
      },
    );
  });
});

describe("project create", () => {
  test("one team from config, and a create receipt", async () => {
    await run(
      projectCreate,
      { flags: { name: "Onboarding", target: "2026-09-30" }, config: { team: "ENG", limit: 50 } },
      [
        {
          match: "LinProjectCreate",
          data: {
            projectCreate: {
              project: { slugId: "onboarding-1a2b3c", url: "https://linear.app/acme/project/onboarding-1a2b3c" },
            },
          },
        },
      ],
      (output, stub) => {
        expect(stub.calls[0]?.operation).toBe("LinProjectCreate");
        expect(stub.calls[0]?.variables).toEqual({
          input: {
            name: "Onboarding",
            targetDate: "2026-09-30",
            teamIds: ["aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"],
          },
        });
        expect(output).toBe(
          "created: onboarding-1a2b3c\nurl: https://linear.app/acme/project/onboarding-1a2b3c\n",
        );
      },
    );
  });

  test("a comma-separated --team creates a multi-team project", async () => {
    await run(
      projectCreate,
      { flags: { name: "Billing" }, config: { team: "ENG,DES", limit: 50 } },
      [
        {
          match: "LinProjectCreate",
          data: {
            projectCreate: { project: { slugId: "billing-4d5e6f", url: "https://linear.app/acme/project/billing" } },
          },
        },
      ],
      (_output, stub) => {
        expect(stub.calls[0]?.variables).toEqual({
          input: {
            name: "Billing",
            teamIds: ["aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"],
          },
        });
      },
    );
  });

  test("-d @file loads the body from disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lin-body-"));
    const path = join(dir, "brief.md");
    writeFileSync(path, "# Brief\nShip it.\n", "utf8");

    try {
      await run(
        projectCreate,
        { flags: { name: "Onboarding", body: `@${path}` }, config: { team: "ENG", limit: 50 } },
        [
          {
            match: "LinProjectCreate",
            data: { projectCreate: { project: { slugId: "onboarding-1a2b3c", url: "https://x.test" } } },
          },
        ],
        (_output, stub) => {
          expect(stub.calls[0]?.variables).toMatchObject({ input: { content: "# Brief\nShip it.\n" } });
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing name is exit 2 and names the flag", async () => {
    const error = await expectFailure(projectCreate, { config: { team: "ENG", limit: 50 } }, []);
    expect(error.exitCode).toBe(EXIT.input);
    expect(error.message).toBe("project create needs a name");
    expect(error.hint).toBe('pass --name "Project name"');
  });

  test("a missing team is exit 2 and names --team", async () => {
    const error = await expectFailure(projectCreate, { flags: { name: "Onboarding" } }, []);
    expect(error.exitCode).toBe(EXIT.input);
    expect(error.message).toBe("no team given");
  });

  test("an unreadable @file is exit 2", async () => {
    const error = await expectFailure(
      projectCreate,
      { flags: { name: "Onboarding", body: "@/no/such/brief.md" }, config: { team: "ENG", limit: 50 } },
      [],
    );
    expect(error.exitCode).toBe(EXIT.input);
    expect(error.message).toBe("cannot read /no/such/brief.md");
  });
});

describe("project update", () => {
  test("the receipt shows only the fields the read-back moved", async () => {
    await run(
      projectUpdate,
      { args: ["Onboarding"], flags: { state: "In Progress", lead: "alex" } },
      [
        { match: "LinProjectStatuses", data: STATUSES },
        {
          match: "LinProjectBefore",
          data: {
            project: {
              name: "Onboarding",
              targetDate: "2026-09-30",
              status: { name: "Planned" },
              lead: null,
            },
          },
        },
        {
          match: "LinProjectUpdate",
          data: {
            projectUpdate: {
              project: {
                slugId: "onboarding-1a2b3c",
                name: "Onboarding",
                targetDate: "2026-09-30",
                status: { name: "In Progress" },
                lead: { displayName: "alex" },
              },
            },
          },
        },
      ],
      (output, stub) => {
        expect(stub.calls.map((call) => call.operation)).toEqual([
          "LinProjectStatuses",
          "LinProjectBefore",
          "LinProjectUpdate",
        ]);
        expect(stub.calls[2]?.variables).toEqual({
          id: "cccccccc-3333-4333-8333-cccccccccccc",
          input: { leadId: "22222222-2222-4222-8222-222222222222", statusId: "ps-progress" },
          withContent: false,
        });
        expect(output).toBe("onboarding-1a2b3c:\n  state: Planned -> In Progress\n  lead: none -> alex\n");
      },
    );
  });

  test("a body write is read back as a character count", async () => {
    await run(
      projectUpdate,
      { args: ["Onboarding"], flags: { body: "Ship it." } },
      [
        {
          match: "LinProjectBefore",
          data: {
            project: { name: "Onboarding", targetDate: null, status: { name: "Planned" }, lead: null, content: null },
          },
        },
        {
          match: "LinProjectUpdate",
          data: {
            projectUpdate: {
              project: {
                slugId: "onboarding-1a2b3c",
                name: "Onboarding",
                targetDate: null,
                status: { name: "Planned" },
                lead: null,
                content: "Ship it.",
              },
            },
          },
        },
      ],
      (output, stub) => {
        expect(stub.calls[0]?.variables).toEqual({ id: "cccccccc-3333-4333-8333-cccccccccccc", withContent: true });
        expect(output).toBe("onboarding-1a2b3c:\n  content: none -> 8 chars\n");
      },
    );
  });

  test("no fields is exit 2 and lists the flags", async () => {
    const error = await expectFailure(projectUpdate, { args: ["Onboarding"] }, []);
    expect(error.exitCode).toBe(EXIT.input);
    expect(error.message).toBe("project update needs at least one field");
  });
});

describe("project post / posts", () => {
  test("--health on-track becomes the onTrack enum", async () => {
    await run(
      projectPost,
      { args: ["Onboarding"], flags: { health: "on-track", message: "Beta is out." } },
      [
        {
          match: "LinProjectPost",
          data: {
            projectUpdateCreate: {
              projectUpdate: {
                slugId: "9f2ab41c",
                url: "https://linear.app/acme/project/onboarding-1a2b3c/activity#project-update-9f2ab41c",
              },
            },
          },
        },
      ],
      (output, stub) => {
        expect(stub.calls[0]?.operation).toBe("LinProjectPost");
        expect(stub.calls[0]?.variables).toEqual({
          input: { projectId: "cccccccc-3333-4333-8333-cccccccccccc", body: "Beta is out.", health: "onTrack" },
        });
        expect(output).toBe(
          "created: 9f2ab41c\n" +
            "url: https://linear.app/acme/project/onboarding-1a2b3c/activity#project-update-9f2ab41c\n",
        );
      },
    );
  });

  test("an unknown health value is exit 2 and lists the three", async () => {
    const error = await expectFailure(
      projectPost,
      { args: ["Onboarding"], flags: { health: "green", message: "hi" } },
      [],
    );
    expect(error.exitCode).toBe(EXIT.input);
    expect(error.hint).toBe("health: on-track, at-risk, off-track");
  });

  test("a missing message is exit 2", async () => {
    const error = await expectFailure(projectPost, { args: ["Onboarding"] }, []);
    expect(error.exitCode).toBe(EXIT.input);
    expect(error.message).toBe("project post needs a message");
  });

  test("posts collapse and clip the body", async () => {
    const long = `Rolled out to five teams.${" ".repeat(3)}${"x".repeat(120)}`;
    await run(
      projectPosts,
      { args: ["Onboarding"], config: { limit: 5 } },
      [
        {
          match: "LinProjectPosts",
          data: {
            project: {
              projectUpdates: {
                nodes: [
                  {
                    createdAt: "2026-07-30T09:00:00.000Z",
                    health: "atRisk",
                    body: long,
                    user: { displayName: "casey" },
                  },
                ],
              },
            },
          },
        },
      ],
      (output, stub) => {
        expect(stub.calls[0]?.variables).toEqual({ id: "cccccccc-3333-4333-8333-cccccccccccc", first: 5 });
        expect(output).toBe(
          "posts[1]{date,author,health,body}:\n" + `  2026-07-30,casey,at-risk,${clip(long)}\n`,
        );
        expect(clip(long)).toHaveLength(103);
      },
    );
  });
});

describe("helpers", () => {
  test("clip collapses whitespace and keeps short bodies whole", () => {
    expect(clip("a\n\n  b   c")).toBe("a b c");
  });

  test("health words round-trip", () => {
    expect(healthWord("offTrack")).toBe("off-track");
    expect(healthWord(null)).toBeUndefined();
  });
});
