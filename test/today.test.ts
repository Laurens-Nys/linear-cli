import { afterEach, describe, expect, test } from "bun:test";
import { toMeta, writeCached } from "../src/cache.ts";
import { keyFingerprint } from "../src/client.ts";
import { todayCommand } from "../src/commands/aliases.ts";
import { run } from "../src/main.ts";
import { EXIT, resetFields, setFields } from "../src/out.ts";
import { MAX_PAGES } from "../src/page.ts";
import { getCommand } from "../src/registry.ts";
import {
  collectToday,
  compareToday,
  isOverdue,
  loadAllNodes,
  localYmd,
  todayContinuation,
  todayDate,
  todayReasons,
  toTodayRow,
  TODAY_COLUMNS,
  TODAY_PAGE_SIZE,
  truncateToday,
  type TodayIssue,
  type TodayRow,
} from "../src/today.ts";
import { WARM_DATA } from "./fixtures.ts";
import { captureStdout, mock, sandbox, type Mock, type MockResponse } from "./harness.ts";

const ENG = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const TODAY = "2026-08-18";

afterEach(() => {
  todayDate.now = () => new Date();
  resetFields();
});

function ymd(year: number, month: number, day: number, hour = 15): Date {
  return new Date(year, month - 1, day, hour, 0, 0);
}

function issue(partial: Partial<TodayIssue> & Pick<TodayIssue, "identifier">): TodayIssue {
  return {
    title: partial.title ?? partial.identifier,
    priority: partial.priority ?? 3,
    dueDate: partial.dueDate ?? null,
    updatedAt: partial.updatedAt ?? "2026-08-18T12:00:00.000Z",
    state: partial.state ?? { name: "Todo", type: "unstarted" },
    identifier: partial.identifier,
  };
}

function page(nodes: TodayIssue[], hasNextPage = false, endCursor: string | null = null) {
  return { issues: { nodes, pageInfo: { hasNextPage, endCursor } } };
}

function blockedPage(ids: string[], hasNextPage = false, endCursor: string | null = null) {
  return {
    issues: {
      nodes: ids.map((identifier) => ({ identifier })),
      pageInfo: { hasNextPage, endCursor },
    },
  };
}

function emptyBlocked(): MockResponse {
  return { match: "LinTodayBlocked", data: blockedPage([]) };
}

function row(partial: Partial<TodayRow> & Pick<TodayRow, "id">): TodayRow {
  const reasons = partial.reasons ?? [];
  return {
    title: partial.title ?? partial.id,
    state: partial.state ?? "Todo",
    priority: partial.priority ?? 3,
    due: partial.due,
    reason: partial.reason ?? reasons.join(","),
    reasons,
    updated: partial.updated ?? "2026-08-18T12:00:00.000Z",
    id: partial.id,
  };
}

interface RunOptions {
  flags?: Record<string, string | number | boolean>;
  team?: string;
  limit?: number;
}

async function runToday(
  options: RunOptions,
  responses: readonly MockResponse[],
  check: (output: string, stub: Mock) => void,
): Promise<void> {
  const box = sandbox();
  writeCached({ ...toMeta(WARM_DATA, keyFingerprint(box.env)), fetchedAt: new Date().toISOString() }, box.env);
  todayDate.now = () => ymd(2026, 8, 18);
  const stub = mock(responses);
  const captured = captureStdout();
  try {
    setFields(options.flags?.["fields"]);
    await todayCommand.run({
      args: [],
      flags: options.flags ?? {},
      config: { team: options.team, limit: options.limit ?? 50 },
      command: todayCommand,
    });
    captured.restore();
    check(captured.text(), stub);
  } finally {
    captured.restore();
    stub.restore();
    box.cleanup();
  }
}

describe("local dates", () => {
  test("localYmd is the local calendar day, not UTC", () => {
    const evening = ymd(2026, 8, 18, 23);
    expect(localYmd(evening)).toBe("2026-08-18");
    expect(localYmd(ymd(2026, 8, 18, 0))).toBe("2026-08-18");
    const utcDay = evening.toISOString().slice(0, 10);
    if (utcDay !== "2026-08-18") expect(localYmd(evening)).not.toBe(utcDay);
  });

  test("today itself is not overdue; missing due is not overdue", () => {
    expect(isOverdue("2026-08-17", TODAY)).toBe(true);
    expect(isOverdue("2026-08-18", TODAY)).toBe(false);
    expect(isOverdue("2026-08-19", TODAY)).toBe(false);
    expect(isOverdue(null, TODAY)).toBe(false);
    expect(isOverdue(undefined, TODAY)).toBe(false);
    expect(isOverdue("", TODAY)).toBe(false);
  });
});

describe("reasons", () => {
  test("each reason is independent and ordered", () => {
    expect(todayReasons({ stateType: "started", dueDate: null, priority: 3, blocked: false, today: TODAY })).toEqual([
      "started",
    ]);
    expect(todayReasons({ stateType: "unstarted", dueDate: "2026-08-17", priority: 3, blocked: false, today: TODAY })).toEqual([
      "overdue",
    ]);
    expect(todayReasons({ stateType: "unstarted", dueDate: null, priority: 1, blocked: false, today: TODAY })).toEqual([
      "urgent/high",
    ]);
    expect(todayReasons({ stateType: "unstarted", dueDate: null, priority: 2, blocked: false, today: TODAY })).toEqual([
      "urgent/high",
    ]);
    expect(todayReasons({ stateType: "unstarted", dueDate: null, priority: 3, blocked: true, today: TODAY })).toEqual([
      "blocked",
    ]);
  });

  test("multiple reasons stay in started, overdue, urgent/high, blocked order", () => {
    expect(
      todayReasons({
        stateType: "started",
        dueDate: "2026-08-01",
        priority: 1,
        blocked: true,
        today: TODAY,
      }),
    ).toEqual(["started", "overdue", "urgent/high", "blocked"]);
  });

  test("medium, due today, unstarted, unblocked is not a today issue", () => {
    expect(
      toTodayRow(issue({ identifier: "ENG-1", dueDate: TODAY, priority: 3 }), false, TODAY),
    ).toBeUndefined();
  });

  test("blocked is emitted only when observed, never as not-blocked", () => {
    const seen = toTodayRow(issue({ identifier: "ENG-2", priority: 3 }), true, TODAY);
    expect(seen?.reasons).toEqual(["blocked"]);
    const unseen = toTodayRow(issue({ identifier: "ENG-3", priority: 1 }), false, TODAY);
    expect(unseen?.reasons).toEqual(["urgent/high"]);
    expect(unseen?.reason).not.toContain("blocked");
    expect(JSON.stringify(unseen)).not.toContain("not blocked");
  });
});

describe("sort", () => {
  test("started, then overdue, urgent, high, blocked", () => {
    const started = row({ id: "ENG-1", reasons: ["started"], priority: 4, state: "In Progress" });
    const overdue = row({ id: "ENG-2", reasons: ["overdue"], due: "2026-08-01", priority: 3 });
    const urgent = row({ id: "ENG-3", reasons: ["urgent/high"], priority: 1 });
    const high = row({ id: "ENG-4", reasons: ["urgent/high"], priority: 2 });
    const blocked = row({ id: "ENG-5", reasons: ["blocked"], priority: 3 });
    const mixed = [blocked, high, overdue, urgent, started];
    mixed.sort(compareToday);
    expect(mixed.map((item) => item.id)).toEqual(["ENG-1", "ENG-2", "ENG-3", "ENG-4", "ENG-5"]);
  });

  test("ties break by priority, earlier due, newer updated, then id", () => {
    const laterDue = row({
      id: "ENG-10",
      reasons: ["started"],
      priority: 2,
      due: "2026-08-20",
      updated: "2026-08-18T10:00:00.000Z",
    });
    const earlierDue = row({
      id: "ENG-11",
      reasons: ["started"],
      priority: 2,
      due: "2026-08-10",
      updated: "2026-08-18T10:00:00.000Z",
    });
    const newer = row({
      id: "ENG-12",
      reasons: ["started"],
      priority: 2,
      due: "2026-08-10",
      updated: "2026-08-18T18:00:00.000Z",
    });
    const olderSame = row({
      id: "ENG-13",
      reasons: ["started"],
      priority: 2,
      due: "2026-08-10",
      updated: "2026-08-18T18:00:00.000Z",
    });
    const missingDue = row({
      id: "ENG-14",
      reasons: ["started"],
      priority: 2,
      updated: "2026-08-20T00:00:00.000Z",
    });
    const noneLast = row({
      id: "ENG-9",
      reasons: ["started"],
      priority: 0,
      due: "2026-08-01",
      updated: "2026-08-19T00:00:00.000Z",
    });
    const ranked = [missingDue, noneLast, laterDue, olderSame, newer, earlierDue];
    ranked.sort(compareToday);
    expect(ranked.map((item) => item.id)).toEqual(["ENG-12", "ENG-13", "ENG-11", "ENG-10", "ENG-14", "ENG-9"]);
  });
});

describe("continuation", () => {
  test("uses -n of the full ranked count and preserves --team/--fields", () => {
    expect(todayContinuation(12, {})).toBe("lin today -n 12");
    expect(todayContinuation(12, { team: "ENG", fields: "id,reason" })).toBe(
      "lin today -n 12 --team ENG --fields id,reason",
    );
    expect(truncateToday([row({ id: "A" }), row({ id: "B" }), row({ id: "C" })], 2, { team: "ENG" })).toEqual({
      shown: [row({ id: "A" }), row({ id: "B" })],
      more: { count: 1, command: "lin today -n 3 --team ENG" },
    });
  });
});

describe("loadAllNodes", () => {
  test("a missing cursor is exit 1", async () => {
    await expect(
      loadAllNodes(async () => ({ nodes: ["a"], pageInfo: { hasNextPage: true, endCursor: null } })),
    ).rejects.toMatchObject({ exitCode: EXIT.api, message: "pagination cursor missing" });
  });

  test("a repeated cursor is exit 1", async () => {
    await expect(
      loadAllNodes(async (after) =>
        after === null
          ? { nodes: ["a"], pageInfo: { hasNextPage: true, endCursor: "loop" } }
          : { nodes: ["b"], pageInfo: { hasNextPage: true, endCursor: "loop" } },
      ),
    ).rejects.toMatchObject({ exitCode: EXIT.api, message: "pagination cursor repeated" });
  });

  test("unique cursors still fail at MAX_PAGES", async () => {
    let fetched = 0;
    await expect(
      loadAllNodes(async (after) => {
        fetched += 1;
        const index = after === null ? 1 : Number(after.slice(1)) + 1;
        return { nodes: [`n${index}`], pageInfo: { hasNextPage: true, endCursor: `c${index}` } };
      }),
    ).rejects.toMatchObject({ exitCode: EXIT.api, message: "pagination exceeded maximum pages" });
    expect(fetched).toBe(MAX_PAGES);
  });
});

describe("lin today", () => {
  test("each reason prints in the default column order", async () => {
    const nodes = [
      issue({ identifier: "ENG-1", title: "Started", state: { name: "In Progress", type: "started" } }),
      issue({ identifier: "ENG-2", title: "Overdue", dueDate: "2026-08-01" }),
      issue({ identifier: "ENG-3", title: "Urgent", priority: 1 }),
      issue({ identifier: "ENG-4", title: "High", priority: 2 }),
      issue({ identifier: "ENG-5", title: "Blocked" }),
    ];
    await runToday(
      {},
      [
        { match: "LinTodayIssues", data: page(nodes) },
        { match: "LinTodayBlocked", data: blockedPage(["ENG-5"]) },
      ],
      (output, stub) => {
        expect(output).toBe(
          [
            "issues[5]{id,title,state,priority,due,reason,updated}:",
            "  ENG-1,Started,In Progress,medium,,started,2026-08-18",
            "  ENG-2,Overdue,Todo,medium,2026-08-01,overdue,2026-08-18",
            "  ENG-3,Urgent,Todo,urgent,,urgent/high,2026-08-18",
            "  ENG-4,High,Todo,high,,urgent/high,2026-08-18",
            "  ENG-5,Blocked,Todo,medium,,blocked,2026-08-18",
            "",
          ].join("\n"),
        );
        expect(stub.calls.every((call) => call.document.trimStart().startsWith("query"))).toBe(true);
        expect(stub.calls.some((call) => /\bmutation\b/.test(call.document))).toBe(false);
        const focus = stub.calls.find((call) => call.operation === "LinTodayIssues");
        expect(focus?.variables).toEqual({
          first: TODAY_PAGE_SIZE,
          after: null,
          filter: {
            assignee: { isMe: { eq: true } },
            state: { type: { nin: ["completed", "canceled"] } },
            or: [
              { state: { type: { eq: "started" } } },
              { dueDate: { lt: TODAY } },
              { priority: { in: [1, 2] } },
              { hasBlockedByRelations: { eq: true } },
            ],
          },
        });
        expect(focus?.variables).not.toMatchObject({ filter: { team: {} } });
      },
    );
  });

  test("multiple reasons stay comma-separated in contract order", async () => {
    await runToday(
      {},
      [
        {
          match: "LinTodayIssues",
          data: page([
            issue({
              identifier: "ENG-9",
              title: "All of it",
              state: { name: "In Progress", type: "started" },
              dueDate: "2026-08-01",
              priority: 1,
            }),
          ]),
        },
        { match: "LinTodayBlocked", data: blockedPage(["ENG-9"]) },
      ],
      (output) => {
        expect(output).toContain('"started,overdue,urgent/high,blocked"');
      },
    );
  });

  test("honors --team after resolving the key", async () => {
    await runToday(
      { team: "ENG", flags: { team: "ENG" } },
      [
        { match: "LinTodayIssues", data: page([]) },
        emptyBlocked(),
      ],
      (output, stub) => {
        expect(output).toBe("issues[0]:\n");
        for (const call of stub.calls) {
          expect(call.variables).toMatchObject({ filter: { team: { id: { eq: ENG } } } });
        }
      },
    );
  });

  test("walks every remaining assigned page before ranking", async () => {
    await runToday(
      { limit: 50 },
      [
        {
          match: "LinTodayIssues",
          data: page(
            [issue({ identifier: "ENG-20", title: "Later started", state: { name: "Doing", type: "started" }, priority: 4 })],
            true,
            "c1",
          ),
        },
        {
          match: "LinTodayIssues",
          data: page([
            issue({ identifier: "ENG-10", title: "Earlier started", state: { name: "Doing", type: "started" }, priority: 3 }),
          ]),
        },
        { match: "LinTodayBlocked", data: blockedPage(["ENG-99"], true, "b1") },
        { match: "LinTodayBlocked", data: blockedPage([]) },
      ],
      (output, stub) => {
        expect(stub.calls.filter((call) => call.operation === "LinTodayIssues")).toHaveLength(2);
        expect(stub.calls.filter((call) => call.operation === "LinTodayBlocked")).toHaveLength(2);
        expect(output).toBe(
          [
            "issues[2]{id,title,state,priority,due,reason,updated}:",
            "  ENG-10,Earlier started,Doing,medium,,started,2026-08-18",
            "  ENG-20,Later started,Doing,low,,started,2026-08-18",
            "",
          ].join("\n"),
        );
      },
    );
  });

  test("a missing focus cursor fails closed", async () => {
    const box = sandbox();
    todayDate.now = () => ymd(2026, 8, 18);
    const stub = mock([
      { match: "LinTodayIssues", data: page([issue({ identifier: "ENG-1" })], true, null) },
      emptyBlocked(),
    ]);
    try {
      await expect(collectToday({ today: TODAY })).rejects.toMatchObject({
        exitCode: EXIT.api,
        message: "pagination cursor missing",
      });
    } finally {
      stub.restore();
      box.cleanup();
    }
  });

  test("a repeated focus cursor fails closed", async () => {
    const box = sandbox();
    const stub = mock([
      { match: "LinTodayIssues", data: page([issue({ identifier: "ENG-1" })], true, "loop") },
      { match: "LinTodayIssues", data: page([issue({ identifier: "ENG-2" })], true, "loop") },
      emptyBlocked(),
    ]);
    try {
      await expect(collectToday({ today: TODAY })).rejects.toMatchObject({
        exitCode: EXIT.api,
        message: "pagination cursor repeated",
      });
    } finally {
      stub.restore();
      box.cleanup();
    }
  });

  test("-n applies after ranking and continues with lin today -n <total>", async () => {
    const nodes = [
      issue({ identifier: "ENG-3", title: "Blocked only" }),
      issue({ identifier: "ENG-1", title: "Started", state: { name: "In Progress", type: "started" } }),
      issue({ identifier: "ENG-2", title: "Overdue", dueDate: "2026-08-01" }),
    ];
    await runToday(
      { limit: 2, flags: { limit: 2, team: "ENG", fields: "id,reason" }, team: "ENG" },
      [
        { match: "LinTodayIssues", data: page(nodes) },
        { match: "LinTodayBlocked", data: blockedPage(["ENG-3"]) },
      ],
      (output, stub) => {
        expect(stub.calls.find((call) => call.operation === "LinTodayIssues")?.variables).toMatchObject({
          first: TODAY_PAGE_SIZE,
        });
        expect(output).toBe(
          [
            "issues[2]{id,reason}:",
            "  ENG-1,started",
            "  ENG-2,overdue",
            "# 1 more · lin today -n 3 --team ENG --fields id,reason",
            "",
          ].join("\n"),
        );
      },
    );
  });

  test("empty assigned focus is issues[0]: and exit 0", async () => {
    await runToday({ flags: { fields: "id,title" } }, [{ match: "LinTodayIssues", data: page([]) }, emptyBlocked()], (output) => {
      expect(output).toBe("issues[0]:\n");
    });
  });

  test("default bytes stay the curated columns; --fields projects them", async () => {
    expect(getCommand("today")?.fields).toEqual([...TODAY_COLUMNS]);
    expect(getCommand("today")?.allPages).toBeUndefined();
    const node = issue({
      identifier: "ENG-42",
      title: "Fix login redirect loop",
      state: { name: "In Progress", type: "started" },
      priority: 2,
      dueDate: "2026-08-01",
    });
    await runToday(
      {},
      [
        { match: "LinTodayIssues", data: page([node]) },
        { match: "LinTodayBlocked", data: blockedPage(["ENG-42"]) },
      ],
      (output) => {
        expect(output).toBe(
          [
            "issues[1]{id,title,state,priority,due,reason,updated}:",
            '  ENG-42,Fix login redirect loop,In Progress,high,2026-08-01,"started,overdue,urgent/high,blocked",2026-08-18',
            "",
          ].join("\n"),
        );
      },
    );
  });

  test("unsupported pagination flags are rejected before any request", async () => {
    const box = sandbox();
    const stub = mock([]);
    try {
      await expect(run(["today", "--all-pages"])).rejects.toMatchObject({
        exitCode: EXIT.input,
        message: "--all-pages is not supported on today",
      });
      await expect(run(["today", "--after", "cursor"])).rejects.toMatchObject({
        exitCode: EXIT.input,
        message: "--after is not supported on today",
      });
      expect(stub.calls).toHaveLength(0);
    } finally {
      stub.restore();
      box.cleanup();
    }
  });
});
