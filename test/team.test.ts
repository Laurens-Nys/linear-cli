import { describe, expect, test } from "bun:test";
import { toMeta, writeCached } from "../src/cache.ts";
import { keyFingerprint } from "../src/client.ts";
import { teamList, teamStates, teamView } from "../src/commands/team.ts";
import { EXIT, LinError } from "../src/out.ts";
import { captureStdout, mock, sandbox, type RecordedCall } from "./harness.ts";
import { WARM_DATA } from "./fixtures.ts";

/** Run a command against stubbed responses with a seeded metadata cache. */
async function cli(
  responses: Parameters<typeof mock>[0],
  invoke: () => Promise<void> | void,
): Promise<{ calls: RecordedCall[]; output: string }> {
  const box = sandbox();
  writeCached(
    { ...toMeta(WARM_DATA, keyFingerprint(box.env)), fetchedAt: new Date().toISOString() },
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

const ENG = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

describe("team list", () => {
  test("lists teams with their cycle setting and issue count", async () => {
    const { calls, output } = await cli(
      [
        {
          match: "LinTeamList",
          data: {
            teams: {
              nodes: [
                { key: "ENG", name: "Engineering", cyclesEnabled: true, issueCount: 12 },
                { key: "DES", name: "Design", cyclesEnabled: false, issueCount: 3 },
              ],
            },
          },
        },
      ],
      () => teamList.run({ args: [], flags: {}, config: { limit: 50 }, command: teamList }),
    );

    expect(calls[0]?.operation).toBe("LinTeamList");
    expect(calls[0]?.variables).toEqual({ first: 50 });
    expect(output).toBe(
      "teams[2]{key,name,cycles,issues}:\n" + "  ENG,Engineering,true,12\n" + "  DES,Design,false,3\n",
    );
  });

  test("an empty workspace prints a header and nothing else", async () => {
    const { output } = await cli(
      [{ match: "LinTeamList", data: { teams: { nodes: [] } } }],
      () => teamList.run({ args: [], flags: {}, config: { limit: 50 }, command: teamList }),
    );

    expect(output).toBe("teams[0]:\n");
  });
});

describe("team view", () => {
  test("renders the team record with its states, labels, and members", async () => {
    const { calls, output } = await cli(
      [
        {
          match: "LinTeamView",
          data: {
            team: {
              key: "ENG",
              name: "Engineering",
              description: "Ships the product",
              cyclesEnabled: true,
              issueCount: 12,
              states: {
                nodes: [
                  { name: "In Progress", type: "started", position: 3 },
                  { name: "Todo", type: "unstarted", position: 2 },
                ],
              },
              labels: {
                nodes: [
                  { name: "Bug", color: "#eb5757", parent: null },
                  { name: "P0", color: "#f2994a", parent: { name: "Priority" } },
                ],
              },
              members: {
                nodes: [
                  { name: "Casey Jordan", email: "casey@acme.test" },
                  { name: "Alex Rivera", email: "alex@acme.test" },
                ],
              },
            },
          },
        },
      ],
      () => teamView.run({ args: ["ENG"], flags: {}, config: { limit: 50 }, command: teamView }),
    );

    expect(calls[0]?.operation).toBe("LinTeamView");
    expect(calls[0]?.variables).toEqual({ id: ENG });
    expect(output).toBe(
      [
        "key: ENG",
        "name: Engineering",
        "description: Ships the product",
        "cycles: true",
        "issues: 12",
        "states[2]{name,type,position}:",
        "  Todo,unstarted,2",
        "  In Progress,started,3",
        "labels[2]{name,group,color}:",
        '  Bug,,"#eb5757"',
        '  P0,Priority,"#f2994a"',
        "members[2]{name,email}:",
        "  Casey Jordan,casey@acme.test",
        "  Alex Rivera,alex@acme.test",
        "",
      ].join("\n"),
    );
  });

  test("falls back to the configured team when no key is given", async () => {
    const { calls } = await cli(
      [
        {
          match: "LinTeamView",
          data: {
            team: {
              key: "ENG",
              name: "Engineering",
              description: null,
              cyclesEnabled: true,
              issueCount: 0,
              states: { nodes: [] },
              labels: { nodes: [] },
              members: { nodes: [] },
            },
          },
        },
      ],
      () => teamView.run({ args: [], flags: {}, config: { team: "ENG", limit: 50 }, command: teamView }),
    );

    expect(calls[0]?.variables).toEqual({ id: ENG });
  });
});

describe("team states", () => {
  test("serves the cached write-path vocabulary in board order, without a request", async () => {
    const { calls, output } = await cli(
      [],
      () => teamStates.run({ args: ["eng"], flags: {}, config: { limit: 50 }, command: teamStates }),
    );

    expect(calls).toHaveLength(0);
    expect(output).toBe(
      [
        "states[7]{name,type,position}:",
        "  Triage,triage,0",
        "  Backlog,backlog,1",
        "  Todo,unstarted,2",
        "  In Progress,started,3",
        "  In Review,started,4",
        "  Done,completed,5",
        "  Canceled,canceled,6",
        "",
      ].join("\n"),
    );
  });

  test("an unknown team names the teams that exist", async () => {
    let error: unknown;
    try {
      // A miss refreshes the cache once before it gives up.
      await cli([{ match: "LinWarm", data: WARM_DATA }], () =>
        teamStates.run({ args: ["OPS"], flags: {}, config: { limit: 50 }, command: teamStates }),
      );
    } catch (thrown) {
      error = thrown;
    }

    expect(error).toBeInstanceOf(LinError);
    expect((error as LinError).exitCode).toBe(EXIT.input);
    expect((error as LinError).message).toBe('no team "OPS"');
    expect((error as LinError).hint).toBe("teams: ENG, DES");
  });
});
