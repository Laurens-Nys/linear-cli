// milestone list / create / update / delete.

import { describe, expect, test } from "bun:test";
import { toMeta, writeCached } from "../src/cache.ts";
import { keyFingerprint } from "../src/client.ts";
import {
  milestoneCreate,
  milestoneDelete,
  milestoneList,
  milestoneUpdate,
} from "../src/commands/milestone.ts";
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

const ONBOARDING = "cccccccc-3333-4333-8333-cccccccccccc";
const BETA_ID = "9f2ab41c-1111-4111-8111-111111111111";
const GA_ID = "1c0d88ee-2222-4222-8222-222222222222";

const LOOKUP = {
  project: {
    projectMilestones: {
      nodes: [
        { id: BETA_ID, name: "Beta" },
        { id: GA_ID, name: "GA" },
      ],
    },
  },
};

describe("milestone list", () => {
  test("progress renders as a percentage, a missing target as an empty cell", async () => {
    await run(
      milestoneList,
      { flags: { project: "Onboarding" }, config: { limit: 25 } },
      [
        {
          match: "LinMilestoneList",
          data: {
            project: {
              projectMilestones: {
                nodes: [
                  { id: BETA_ID, name: "Beta", targetDate: "2026-08-15", progress: 40 },
                  { id: GA_ID, name: "GA", targetDate: null, progress: 0 },
                ],
              },
            },
          },
        },
      ],
      (output, stub) => {
        expect(stub.calls[0]?.operation).toBe("LinMilestoneList");
        expect(stub.calls[0]?.variables).toEqual({ id: ONBOARDING, first: 25 });
        expect(output).toBe(
          "milestones[2]{id,name,target,progress}:\n  9f2ab41c,Beta,2026-08-15,40%\n  1c0d88ee,GA,,0%\n",
        );
      },
    );
  });

  test("no --project is exit 2 and names the flag", async () => {
    const error = await expectFailure(milestoneList, {}, []);
    expect(error.exitCode).toBe(EXIT.input);
    expect(error.message).toBe("no project given");
    expect(error.hint).toBe("pass --project <name>");
  });
});

describe("milestone create", () => {
  test("sends projectId, name and target, and receipts the short id", async () => {
    await run(
      milestoneCreate,
      { flags: { project: "Onboarding", name: "Beta", target: "2026-08-15" } },
      [{ match: "LinMilestoneCreate", data: { projectMilestoneCreate: { projectMilestone: { id: BETA_ID } } } }],
      (output, stub) => {
        expect(stub.calls[0]?.operation).toBe("LinMilestoneCreate");
        expect(stub.calls[0]?.variables).toEqual({
          input: { projectId: ONBOARDING, name: "Beta", targetDate: "2026-08-15" },
        });
        expect(output).toBe("created: 9f2ab41c\n");
      },
    );
  });

  test("a malformed --target is exit 2 with the expected form", async () => {
    const error = await expectFailure(
      milestoneCreate,
      { flags: { project: "Onboarding", name: "Beta", target: "August 15" } },
      [],
    );
    expect(error.exitCode).toBe(EXIT.input);
    expect(error.message).toBe('--target needs a YYYY-MM-DD date, got "August 15"');
  });
});

describe("milestone update", () => {
  test("a milestone name inside a project resolves to its id", async () => {
    await run(
      milestoneUpdate,
      { args: ["Beta"], flags: { project: "Onboarding", target: "2026-09-01" } },
      [
        { match: "LinMilestoneLookup", data: LOOKUP },
        { match: "LinMilestoneBefore", data: { projectMilestone: { name: "Beta", targetDate: "2026-08-15" } } },
        {
          match: "LinMilestoneUpdate",
          data: { projectMilestoneUpdate: { projectMilestone: { id: BETA_ID, name: "Beta", targetDate: "2026-09-01" } } },
        },
      ],
      (output, stub) => {
        expect(stub.calls.map((call) => call.operation)).toEqual([
          "LinMilestoneLookup",
          "LinMilestoneBefore",
          "LinMilestoneUpdate",
        ]);
        expect(stub.calls[2]?.variables).toEqual({ id: BETA_ID, input: { targetDate: "2026-09-01" } });
        expect(output).toBe("9f2ab41c:\n  target: 2026-08-15 -> 2026-09-01\n");
      },
    );
  });

  test("an unknown milestone is exit 2 and lists the project's milestones", async () => {
    const error = await expectFailure(
      milestoneUpdate,
      { args: ["Gamma"], flags: { project: "Onboarding", name: "Delta" } },
      [{ match: "LinMilestoneLookup", data: LOOKUP }],
    );
    expect(error.exitCode).toBe(EXIT.input);
    expect(error.message).toBe('project Onboarding has no milestone "Gamma"');
    expect(error.hint).toBe("milestones: Beta, GA");
  });

  test("a name without --project is exit 2", async () => {
    const error = await expectFailure(milestoneUpdate, { args: ["Beta"], flags: { name: "Beta 2" } }, []);
    expect(error.exitCode).toBe(EXIT.input);
    expect(error.message).toBe('"Beta" needs a project to resolve against');
  });
});

describe("milestone delete", () => {
  test("the 8-char id from the list resolves back to the milestone", async () => {
    await run(
      milestoneDelete,
      { args: ["9f2ab41c"], flags: { project: "Onboarding" } },
      [
        { match: "LinMilestoneLookup", data: LOOKUP },
        { match: "LinMilestoneDelete", data: { projectMilestoneDelete: { entityId: BETA_ID } } },
      ],
      (output, stub) => {
        expect(stub.calls[1]?.operation).toBe("LinMilestoneDelete");
        expect(stub.calls[1]?.variables).toEqual({ id: BETA_ID });
        expect(output).toBe("deleted: 9f2ab41c\n");
      },
    );
  });

  test("a UUID skips the lookup entirely", async () => {
    await run(
      milestoneDelete,
      { args: [GA_ID] },
      [{ match: "LinMilestoneDelete", data: { projectMilestoneDelete: { entityId: GA_ID } } }],
      (output, stub) => {
        expect(stub.calls).toHaveLength(1);
        expect(stub.calls[0]?.variables).toEqual({ id: GA_ID });
        expect(output).toBe("deleted: 1c0d88ee\n");
      },
    );
  });
});
