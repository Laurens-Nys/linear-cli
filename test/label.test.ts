import { describe, expect, test } from "bun:test";
import { toMeta, writeCached } from "../src/cache.ts";
import { keyFingerprint } from "../src/client.ts";
import { labelArchive, labelCreate, labelList, labelUpdate } from "../src/commands/label.ts";
import { EXIT, LinError } from "../src/out.ts";
import { captureStdout, mock, sandbox, type RecordedCall } from "./harness.ts";
import { WARM_DATA } from "./fixtures.ts";

/**
 * A label group is itself a label, which `WARM_DATA` only ever names through a
 * child's `parent`. `--parent` resolves the group by name, so it needs the
 * group's own node.
 */
const WARM_WITH_GROUP: Parameters<typeof toMeta>[0] = {
  ...WARM_DATA,
  teams: {
    nodes: WARM_DATA.teams.nodes.map((team) =>
      team.key === "ENG"
        ? {
            ...team,
            labels: {
              nodes: [
                ...team.labels.nodes,
                { id: "lb-priority", name: "Priority", color: "#5e6ad2", parent: null },
              ],
            },
          }
        : team,
    ),
  },
};

async function cli(
  responses: Parameters<typeof mock>[0],
  invoke: () => Promise<void> | void,
  warm: Parameters<typeof toMeta>[0] = WARM_DATA,
): Promise<{ calls: RecordedCall[]; output: string }> {
  const box = sandbox();
  writeCached(
    { ...toMeta(warm, keyFingerprint(box.env)), fetchedAt: new Date().toISOString() },
    box.env,
  );
  const stub = mock(responses);
  const captured = captureStdout();
  try {
    await invoke();
    return { calls: stub.calls, output: captured.text() };
  } finally {
    captured.restore();
    stub.restore();
    box.cleanup();
  }
}

async function cliError(
  responses: Parameters<typeof mock>[0],
  invoke: () => Promise<void> | void,
): Promise<LinError> {
  try {
    await cli(responses, invoke);
  } catch (error) {
    expect(error).toBeInstanceOf(LinError);
    return error as LinError;
  }
  throw new Error("expected a LinError, but the command succeeded");
}

const ENG = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

describe("label list", () => {
  test("a team scope asks for that team's labels plus the workspace-wide ones", async () => {
    const { calls, output } = await cli(
      [
        {
          match: "LinLabelList",
          data: {
            issueLabels: {
              nodes: [
                { name: "Bug", color: "#eb5757", parent: null },
                { name: "P0", color: "#f2994a", parent: { name: "Priority" } },
              ],
            },
          },
        },
      ],
      () => labelList.run({ args: [], flags: {}, config: { team: "ENG", limit: 50 }, command: labelList }),
    );

    expect(calls[0]?.operation).toBe("LinLabelList");
    expect(calls[0]?.variables).toEqual({
      filter: { or: [{ team: { id: { eq: ENG } } }, { team: { null: true } }] },
      first: 50,
    });
    expect(output).toBe(
      "labels[2]{name,group,color}:\n" + '  Bug,,"#eb5757"\n' + '  P0,Priority,"#f2994a"\n',
    );
  });

  test("without a team the whole workspace's labels come back unfiltered", async () => {
    const { calls } = await cli(
      [{ match: "LinLabelList", data: { issueLabels: { nodes: [] } } }],
      () => labelList.run({ args: [], flags: {}, config: { limit: 50 }, command: labelList }),
    );

    expect(calls[0]?.variables).toEqual({ first: 50 });
  });
});

describe("label create", () => {
  test("creates a team label with a color", async () => {
    const { calls, output } = await cli(
      [
        {
          match: "LinLabelCreate",
          data: { issueLabelCreate: { issueLabel: { name: "Flaky", color: "#eb5757", parent: null } } },
        },
      ],
      () =>
        labelCreate.run({
          args: [],
          flags: { name: "Flaky", color: "#eb5757" },
          config: { team: "ENG", limit: 50 },
          command: labelCreate,
        }),
    );

    expect(calls[0]?.operation).toBe("LinLabelCreate");
    expect(calls[0]?.variables).toEqual({
      input: { name: "Flaky", teamId: ENG, color: "#eb5757" },
    });
    expect(output).toBe("created: Flaky\n");
  });

  test("a workspace label inside a group carries the group in the receipt", async () => {
    const { calls, output } = await cli(
      [
        {
          match: "LinLabelCreate",
          data: {
            issueLabelCreate: {
              issueLabel: { name: "P2", color: "#f2c94c", parent: { name: "Priority" } },
            },
          },
        },
      ],
      () =>
        labelCreate.run({
          args: [],
          flags: { name: "P2", workspace: true, parent: "Priority" },
          config: { team: "ENG", limit: 50 },
          command: labelCreate,
        }),
      WARM_WITH_GROUP,
    );

    expect(calls[0]?.variables).toEqual({ input: { name: "P2", parentId: "lb-priority" } });
    expect(output).toBe("created: Priority/P2\n");
  });

  test("no scope names both ways to give one", async () => {
    const error = await cliError([], () =>
      labelCreate.run({
        args: [],
        flags: { name: "Flaky" },
        config: { limit: 50 },
        command: labelCreate,
      }),
    );

    expect(error.exitCode).toBe(EXIT.input);
    expect(error.message).toBe("no scope for the new label");
    expect(error.hint).toBe("pass --team KEY for a team label, or --workspace for a workspace label");
  });

  test("a color that is not hex names the shape it wants", async () => {
    const error = await cliError([], () =>
      labelCreate.run({
        args: [],
        flags: { name: "Flaky", color: "red" },
        config: { team: "ENG", limit: 50 },
        command: labelCreate,
      }),
    );

    expect(error.exitCode).toBe(EXIT.input);
    expect(error.message).toBe('"red" is not a hex color');
    expect(error.hint).toBe("example: --color #eb5757");
  });
});

describe("label update", () => {
  test("prints only the fields the read-back says changed", async () => {
    const { calls, output } = await cli(
      [
        {
          match: "LinLabelUpdate",
          data: {
            issueLabelUpdate: { issueLabel: { name: "Defect", color: "#eb5757", parent: null } },
          },
        },
      ],
      () =>
        labelUpdate.run({
          args: ["Bug"],
          flags: { name: "Defect" },
          config: { team: "ENG", limit: 50 },
          command: labelUpdate,
        }),
    );

    expect(calls[0]?.operation).toBe("LinLabelUpdate");
    expect(calls[0]?.variables).toEqual({ id: "lb-bug", input: { name: "Defect" } });
    expect(output).toBe("Defect:\n  name: Bug -> Defect\n");
  });

  test("regrouping reports the group move", async () => {
    const { calls, output } = await cli(
      [
        {
          match: "LinLabelUpdate",
          data: {
            issueLabelUpdate: {
              issueLabel: { name: "Bug", color: "#eb5757", parent: { name: "Priority" } },
            },
          },
        },
      ],
      () =>
        labelUpdate.run({
          args: ["Bug"],
          flags: { parent: "Priority" },
          config: { team: "ENG", limit: 50 },
          command: labelUpdate,
        }),
      WARM_WITH_GROUP,
    );

    expect(calls[0]?.variables).toEqual({ id: "lb-bug", input: { parentId: "lb-priority" } });
    expect(output).toBe("Priority/Bug:\n  group: none -> Priority\n");
  });

  test("an update with nothing to change lists the flags that would", async () => {
    const error = await cliError([], () =>
      labelUpdate.run({
        args: ["Bug"],
        flags: {},
        config: { team: "ENG", limit: 50 },
        command: labelUpdate,
      }),
    );

    expect(error.exitCode).toBe(EXIT.input);
    expect(error.message).toBe('nothing to change on label "Bug"');
    expect(error.hint).toBe("pass --name, --color, or --parent");
  });
});

describe("label archive", () => {
  test("retires the label and receipts the qualified name", async () => {
    const { calls, output } = await cli(
      [
        {
          match: "LinLabelArchive",
          data: {
            issueLabelRetire: {
              issueLabel: { name: "P0", color: "#f2994a", parent: { name: "Priority" } },
            },
          },
        },
      ],
      () =>
        labelArchive.run({
          args: ["Priority/P0"],
          flags: {},
          config: { team: "ENG", limit: 50 },
          command: labelArchive,
        }),
    );

    expect(calls[0]?.operation).toBe("LinLabelArchive");
    expect(calls[0]?.document).toContain("issueLabelRetire");
    expect(calls[0]?.variables).toEqual({ id: "lb-p0" });
    expect(output).toBe("archived: Priority/P0\n");
  });
});
