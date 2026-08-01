// cycle list / view / create / update.

import { describe, expect, test } from "bun:test";
import { toMeta, writeCached } from "../src/cache.ts";
import { keyFingerprint } from "../src/client.ts";
import { cycleCreate, cycleList, cycleUpdate, cycleView } from "../src/commands/cycle.ts";
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
      config: invocation.config ?? { team: "ENG", limit: 50 },
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
      config: invocation.config ?? { team: "ENG", limit: 50 },
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

const ENG = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const CYCLE_42 = "cy-42-4111-8111-111111111111";
const CYCLE_41 = "cy-41-4222-8222-222222222222";

/** The response resolve.resolveCycle expects from LinCycles. */
const CYCLES = {
  team: {
    activeCycle: { id: CYCLE_42, number: 42 },
    cycles: {
      nodes: [
        {
          id: CYCLE_42,
          number: 42,
          name: null,
          startsAt: "2026-08-10T00:00:00.000Z",
          endsAt: "2026-08-24T00:00:00.000Z",
        },
        {
          id: CYCLE_41,
          number: 41,
          name: "Hardening",
          startsAt: "2026-07-27T00:00:00.000Z",
          endsAt: "2026-08-10T00:00:00.000Z",
        },
      ],
    },
  },
};

describe("cycle list", () => {
  test("newest cycle first, with the active marker", async () => {
    await run(
      cycleList,
      {},
      [
        {
          match: "LinCycleList",
          data: {
            cycles: {
              nodes: [
                {
                  number: 41,
                  name: "Hardening",
                  startsAt: "2026-07-27T00:00:00.000Z",
                  endsAt: "2026-08-10T00:00:00.000Z",
                  isActive: false,
                },
                {
                  number: 42,
                  name: null,
                  startsAt: "2026-08-10T00:00:00.000Z",
                  endsAt: "2026-08-24T00:00:00.000Z",
                  isActive: true,
                },
              ],
            },
          },
        },
      ],
      (output, stub) => {
        expect(stub.calls[0]?.operation).toBe("LinCycleList");
        expect(stub.calls[0]?.variables).toEqual({
          filter: { team: { id: { eq: ENG } } },
          first: 50,
          after: undefined,
        });
        expect(output).toBe(
          "cycles[2]{n,name,start,end,active}:\n" +
            "  42,,2026-08-10,2026-08-24,true\n" +
            "  41,Hardening,2026-07-27,2026-08-10,false\n",
        );
      },
    );
  });

  test("no team anywhere is exit 2 and names --team", async () => {
    const error = await expectFailure(cycleList, { config: { limit: 50 } }, []);
    expect(error.exitCode).toBe(EXIT.input);
    expect(error.message).toBe("no team given");
  });
});

describe("cycle view", () => {
  test("current resolves through the team's active cycle", async () => {
    await run(
      cycleView,
      { args: ["current"] },
      [
        { match: "LinCycles", data: CYCLES },
        {
          match: "LinCycleView",
          data: {
            cycle: {
              isActive: true,
              progress: 0.7013888888888888,
              currentProgress: {
                scopeCount: 36,
                completedIssueCount: 23,
                startedIssueCount: 9,
                unstartedIssueCount: 4,
              },
              team: { key: "ENG" },
            },
          },
        },
      ],
      (output, stub) => {
        expect(stub.calls.map((call) => call.operation)).toEqual(["LinCycles", "LinCycleView"]);
        expect(stub.calls[1]?.variables).toEqual({ id: CYCLE_42 });
        expect(output).toBe(
          [
            "n: 42",
            "team: ENG",
            "start: 2026-08-10",
            "end: 2026-08-24",
            "active: true",
            "progress: 70%",
            "scope: 36",
            "completed: 23",
            "started: 9",
            "unstarted: 4",
            "",
          ].join("\n"),
        );
      },
    );
  });

  test("a cycle with no burn-up yet omits the scope numbers", async () => {
    await run(
      cycleView,
      { args: ["41"] },
      [
        { match: "LinCycles", data: CYCLES },
        {
          match: "LinCycleView",
          data: { cycle: { isActive: false, progress: 0, currentProgress: {}, team: { key: "ENG" } } },
        },
      ],
      (output) => {
        expect(output).toBe(
          ["n: 41", "name: Hardening", "team: ENG", "start: 2026-07-27", "end: 2026-08-10", "active: false", "progress: 0%", ""].join(
            "\n",
          ),
        );
      },
    );
  });

  test("an unknown cycle number is exit 2 and lists the numbers", async () => {
    const error = await expectFailure(cycleView, { args: ["99"] }, [{ match: "LinCycles", data: CYCLES }]);
    expect(error.exitCode).toBe(EXIT.input);
    expect(error.message).toBe("team ENG has no cycle 99");
  });
});

describe("cycle create", () => {
  test("calendar dates become midnight UTC DateTimes", async () => {
    await run(
      cycleCreate,
      { flags: { start: "2026-08-10", end: "2026-08-24", name: "Hardening" } },
      [{ match: "LinCycleCreate", data: { cycleCreate: { cycle: { number: 42 } } } }],
      (output, stub) => {
        expect(stub.calls[0]?.operation).toBe("LinCycleCreate");
        expect(stub.calls[0]?.variables).toEqual({
          input: {
            teamId: ENG,
            startsAt: "2026-08-10T00:00:00.000Z",
            endsAt: "2026-08-24T00:00:00.000Z",
            name: "Hardening",
          },
        });
        expect(output).toBe('created: "42"\n');
      },
    );
  });

  test("a missing end date is exit 2 and shows both flags", async () => {
    const error = await expectFailure(cycleCreate, { flags: { start: "2026-08-10" } }, []);
    expect(error.exitCode).toBe(EXIT.input);
    expect(error.message).toBe("cycle create needs a start and an end");
    expect(error.hint).toBe("example: --start 2026-08-10 --end 2026-08-24");
  });
});

describe("cycle update", () => {
  test("the receipt diffs the read-back name", async () => {
    await run(
      cycleUpdate,
      { args: ["42"], flags: { name: "Hardening" } },
      [
        { match: "LinCycles", data: CYCLES },
        {
          match: "LinCycleBefore",
          data: {
            cycle: { name: null, startsAt: "2026-08-10T00:00:00.000Z", endsAt: "2026-08-24T00:00:00.000Z" },
          },
        },
        {
          match: "LinCycleUpdate",
          data: {
            cycleUpdate: {
              cycle: {
                number: 42,
                name: "Hardening",
                startsAt: "2026-08-10T00:00:00.000Z",
                endsAt: "2026-08-24T00:00:00.000Z",
              },
            },
          },
        },
      ],
      (output, stub) => {
        expect(stub.calls[2]?.variables).toEqual({ id: CYCLE_42, input: { name: "Hardening" } });
        expect(output).toBe("42:\n  name: none -> Hardening\n");
      },
    );
  });

  test("no fields is exit 2 and lists the flags", async () => {
    const error = await expectFailure(cycleUpdate, { args: ["42"] }, []);
    expect(error.exitCode).toBe(EXIT.input);
    expect(error.message).toBe("cycle update needs at least one field");
  });
});
