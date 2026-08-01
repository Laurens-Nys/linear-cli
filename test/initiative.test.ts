// initiative list / view / create / update / add-project / rm-project / post / posts.

import { describe, expect, test } from "bun:test";
import { toMeta, writeCached } from "../src/cache.ts";
import { keyFingerprint } from "../src/client.ts";
import {
  initiativeAddProject,
  initiativeCreate,
  initiativeList,
  initiativePost,
  initiativePosts,
  initiativeRmProject,
  initiativeUpdate,
  initiativeView,
} from "../src/commands/initiative.ts";
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

const PLATFORM = "in-1111-4111-8111-111111111111";
const ONBOARDING = "cccccccc-3333-4333-8333-cccccccccccc";

const LOOKUP = {
  initiatives: {
    nodes: [
      { id: PLATFORM, slugId: "platform-9z8y7x", name: "Platform" },
      { id: "in-2222-4222-8222-222222222222", slugId: "growth-3c2b1a", name: "Growth" },
    ],
  },
};

describe("initiative list", () => {
  test("renders id, name, state, owner and target", async () => {
    await run(
      initiativeList,
      {},
      [
        {
          match: "LinInitiativeList",
          data: {
            initiatives: {
              nodes: [
                {
                  slugId: "platform-9z8y7x",
                  name: "Platform",
                  status: "Active",
                  targetDate: "2026-12-31",
                  owner: { displayName: "casey" },
                },
                { slugId: "growth-3c2b1a", name: "Growth", status: "Planned", targetDate: null, owner: null },
              ],
            },
          },
        },
      ],
      (output, stub) => {
        expect(stub.calls[0]?.operation).toBe("LinInitiativeList");
        expect(stub.calls[0]?.variables).toEqual({ first: 50, after: undefined });
        expect(output).toBe(
          "initiatives[2]{id,name,state,owner,target}:\n" +
            "  platform-9z8y7x,Platform,Active,casey,2026-12-31\n" +
            "  growth-3c2b1a,Growth,Planned,,\n",
        );
      },
    );
  });
});

describe("initiative view", () => {
  test("the record carries a project rollup table", async () => {
    await run(
      initiativeView,
      { args: ["Platform"] },
      [
        { match: "LinInitiativeLookup", data: LOOKUP },
        {
          match: "LinInitiativeView",
          data: {
            initiative: {
              slugId: "platform-9z8y7x",
              name: "Platform",
              status: "Active",
              content: "## Why\nOne platform, not three.",
              health: "atRisk",
              targetDate: "2026-12-31",
              updatedAt: "2026-07-30T09:15:00.000Z",
              url: "https://linear.app/acme/initiative/platform-9z8y7x",
              owner: { displayName: "casey" },
              projects: {
                nodes: [
                  {
                    slugId: "onboarding-1a2b3c",
                    name: "Onboarding",
                    progress: 0.75,
                    health: "onTrack",
                    status: { name: "In Progress" },
                  },
                  { slugId: "billing-4d5e6f", name: "Billing", progress: 0, health: null, status: { name: "Planned" } },
                ],
              },
            },
          },
        },
      ],
      (output, stub) => {
        expect(stub.calls[1]?.variables).toEqual({ id: PLATFORM });
        expect(output).toBe(
          [
            "id: platform-9z8y7x",
            "name: Platform",
            "state: Active",
            "health: at-risk",
            "owner: casey",
            "target: 2026-12-31",
            "updated: 2026-07-30",
            "url: https://linear.app/acme/initiative/platform-9z8y7x",
            "---",
            "## Why",
            "One platform, not three.",
            "---",
            "projects[2]{id,name,state,health,progress}:",
            "  onboarding-1a2b3c,Onboarding,In Progress,on-track,75%",
            "  billing-4d5e6f,Billing,Planned,,0%",
            "",
          ].join("\n"),
        );
      },
    );
  });

  test("an unknown initiative is exit 2 and lists the names", async () => {
    const error = await expectFailure(initiativeView, { args: ["Payments"] }, [
      { match: "LinInitiativeLookup", data: LOOKUP },
    ]);
    expect(error.exitCode).toBe(EXIT.input);
    expect(error.message).toBe('no initiative "Payments"');
    expect(error.hint).toBe("initiatives: Platform, Growth");
  });
});

describe("initiative create / update", () => {
  test("--state maps onto the InitiativeStatus enum", async () => {
    await run(
      initiativeCreate,
      { flags: { name: "Platform", state: "planned", target: "2026-12-31" } },
      [
        {
          match: "LinInitiativeCreate",
          data: {
            initiativeCreate: {
              initiative: { slugId: "platform-9z8y7x", url: "https://linear.app/acme/initiative/platform-9z8y7x" },
            },
          },
        },
      ],
      (output, stub) => {
        expect(stub.calls[0]?.variables).toEqual({
          input: { name: "Platform", targetDate: "2026-12-31", status: "Planned" },
        });
        expect(output).toBe(
          "created: platform-9z8y7x\nurl: https://linear.app/acme/initiative/platform-9z8y7x\n",
        );
      },
    );
  });

  test("an unknown state is exit 2 and lists the five", async () => {
    const error = await expectFailure(initiativeCreate, { flags: { name: "Platform", state: "Shipping" } }, []);
    expect(error.exitCode).toBe(EXIT.input);
    expect(error.hint).toBe("states: Proposed, Planned, Active, Completed, Canceled");
  });

  test("the update receipt diffs the read-back status", async () => {
    await run(
      initiativeUpdate,
      { args: ["platform-9z8y7x"], flags: { state: "Active" } },
      [
        { match: "LinInitiativeLookup", data: LOOKUP },
        {
          match: "LinInitiativeBefore",
          data: { initiative: { name: "Platform", status: "Planned", targetDate: "2026-12-31" } },
        },
        {
          match: "LinInitiativeUpdate",
          data: {
            initiativeUpdate: {
              initiative: {
                slugId: "platform-9z8y7x",
                name: "Platform",
                status: "Active",
                targetDate: "2026-12-31",
              },
            },
          },
        },
      ],
      (output, stub) => {
        expect(stub.calls[2]?.variables).toEqual({
          id: PLATFORM,
          input: { status: "Active" },
          withContent: false,
        });
        expect(output).toBe("platform-9z8y7x:\n  state: Planned -> Active\n");
      },
    );
  });
});

describe("initiative membership", () => {
  test("add-project links the initiative and the project", async () => {
    await run(
      initiativeAddProject,
      { args: ["Platform", "Onboarding"] },
      [
        { match: "LinInitiativeLookup", data: LOOKUP },
        {
          match: "LinInitiativeAddProject",
          data: {
            initiativeToProjectCreate: { initiativeToProject: { project: { slugId: "onboarding-1a2b3c" } } },
          },
        },
      ],
      (output, stub) => {
        expect(stub.calls[1]?.variables).toEqual({ input: { initiativeId: PLATFORM, projectId: ONBOARDING } });
        expect(output).toBe("added: onboarding-1a2b3c\n");
      },
    );
  });

  test("rm-project finds the link record before deleting it", async () => {
    await run(
      initiativeRmProject,
      { args: ["Platform", "Onboarding"] },
      [
        { match: "LinInitiativeLookup", data: LOOKUP },
        {
          match: "LinInitiativeLinks",
          data: {
            project: {
              initiativeToProjects: {
                nodes: [
                  { id: "link-other", initiative: { id: "in-2222-4222-8222-222222222222" } },
                  { id: "link-platform", initiative: { id: PLATFORM } },
                ],
              },
            },
          },
        },
        { match: "LinInitiativeRmProject", data: { initiativeToProjectDelete: { success: true } } },
      ],
      (output, stub) => {
        expect(stub.calls.map((call) => call.operation)).toEqual([
          "LinInitiativeLookup",
          "LinInitiativeLinks",
          "LinInitiativeRmProject",
        ]);
        expect(stub.calls[2]?.variables).toEqual({ id: "link-platform" });
        expect(output).toBe("removed: onboarding-1a2b3c\n");
      },
    );
  });

  test("removing a project that is not in the initiative is exit 4", async () => {
    const error = await expectFailure(initiativeRmProject, { args: ["Platform", "Onboarding"] }, [
      { match: "LinInitiativeLookup", data: LOOKUP },
      { match: "LinInitiativeLinks", data: { project: { initiativeToProjects: { nodes: [] } } } },
    ]);
    expect(error.exitCode).toBe(EXIT.notFound);
    expect(error.message).toBe("project Onboarding is not in that initiative");
  });
});

describe("initiative post / posts", () => {
  test("post sends the initiativeId and the mapped health", async () => {
    await run(
      initiativePost,
      { args: ["Platform"], flags: { health: "off-track", message: "Slipping a week." } },
      [
        { match: "LinInitiativeLookup", data: LOOKUP },
        {
          match: "LinInitiativePost",
          data: {
            initiativeUpdateCreate: {
              initiativeUpdate: { slugId: "1c0d88ee", url: "https://linear.app/acme/initiative/platform/updates" },
            },
          },
        },
      ],
      (output, stub) => {
        expect(stub.calls[1]?.variables).toEqual({
          input: { initiativeId: PLATFORM, body: "Slipping a week.", health: "offTrack" },
        });
        expect(output).toBe(
          "created: 1c0d88ee\nurl: https://linear.app/acme/initiative/platform/updates\n",
        );
      },
    );
  });

  test("posts render the same shape as project posts", async () => {
    await run(
      initiativePosts,
      { args: ["Platform"], config: { limit: 3 } },
      [
        { match: "LinInitiativeLookup", data: LOOKUP },
        {
          match: "LinInitiativePosts",
          data: {
            initiative: {
              initiativeUpdates: {
                nodes: [
                  {
                    createdAt: "2026-07-30T09:00:00.000Z",
                    health: "offTrack",
                    body: "Slipping a week.",
                    user: { displayName: "alex" },
                  },
                ],
              },
            },
          },
        },
      ],
      (output, stub) => {
        expect(stub.calls[1]?.variables).toEqual({ id: PLATFORM, first: 3 });
        expect(output).toBe(
          "posts[1]{date,author,health,body}:\n  2026-07-30,alex,off-track,Slipping a week.\n",
        );
      },
    );
  });
});
