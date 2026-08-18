import { describe, expect, test } from "bun:test";
import { ageDays, eventWord, inbox, inboxArchive, inboxRead } from "../src/commands/inbox.ts";
import { run } from "../src/main.ts";
import { EXIT, LinError } from "../src/out.ts";
import { captureStdout, mock, sandbox, type RecordedCall } from "./harness.ts";

/** No inbox command reads the metadata cache. */
async function cli(
  responses: Parameters<typeof mock>[0],
  invoke: () => Promise<void> | void,
): Promise<{ calls: RecordedCall[]; output: string }> {
  const box = sandbox();
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

/** Ages are relative, so fixtures are pinned to now rather than to a date. */
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

const ASSIGNED = "be46b7e2-5f62-4ab2-b843-4d313eb68320";
const UPDATE = "db87e39d-0974-4e33-9218-870f651afff3";
const COMMENTED = "04eb4e51-4ae1-409b-a05e-18434cc6f3bc";

const NOTIFICATIONS = {
  notifications: {
    nodes: [
      {
        __typename: "IssueNotification",
        id: ASSIGNED,
        type: "issueAssignedToYou",
        createdAt: daysAgo(0),
        readAt: null,
        actor: { displayName: "casey" },
        issue: { identifier: "ENG-42" },
      },
      {
        __typename: "ProjectNotification",
        id: UPDATE,
        type: "projectUpdateCreated",
        createdAt: daysAgo(3),
        readAt: null,
        actor: { displayName: "alex" },
        project: { name: "Onboarding" },
      },
      {
        __typename: "IssueNotification",
        id: COMMENTED,
        type: "issueNewComment",
        createdAt: daysAgo(5),
        readAt: daysAgo(4),
        actor: null,
        issue: { identifier: "ENG-41" },
      },
    ],
  },
};

const REFS = {
  notifications: {
    nodes: [
      { id: ASSIGNED, readAt: null },
      { id: UPDATE, readAt: null },
      { id: COMMENTED, readAt: daysAgo(4) },
    ],
  },
};

describe("inbox", () => {
  test("shows unread notifications newest first, with the entity dropped from the type", async () => {
    const { calls, output } = await cli([{ match: "LinInbox", data: NOTIFICATIONS }], () =>
      inbox.run({ args: [], flags: {}, config: { limit: 50 }, command: inbox }),
    );

    expect(calls[0]?.operation).toBe("LinInbox");
    // Unread is filtered client-side, so the page is widened past the limit.
    expect(calls[0]?.variables).toEqual({ first: 100 });
    expect(calls[0]?.document).toContain("... on IssueNotification");
    expect(output).toBe(
      [
        "notifications[2]{ref,type,actor,target,age}:",
        "  be46b7e2,assignment,casey,ENG-42,0d",
        "  db87e39d,update,alex,Onboarding,3d",
        "",
      ].join("\n"),
    );
  });

  test("--all keeps the read ones and asks for exactly the limit", async () => {
    const { calls, output } = await cli([{ match: "LinInbox", data: NOTIFICATIONS }], () =>
      inbox.run({ args: [], flags: { all: true }, config: { limit: 50 }, command: inbox }),
    );

    expect(calls[0]?.variables).toEqual({ first: 50 });
    expect(output).toBe(
      [
        "notifications[3]{ref,type,actor,target,age}:",
        "  be46b7e2,assignment,casey,ENG-42,0d",
        "  db87e39d,update,alex,Onboarding,3d",
        "  04eb4e51,comment,,ENG-41,5d",
        "",
      ].join("\n"),
    );
  });

  test("lin inbox --all still means include-read, not pagination", async () => {
    const box = sandbox();
    const stub = mock([{ match: "LinInbox", data: NOTIFICATIONS }]);
    const captured = captureStdout();
    try {
      const code = await run(["inbox", "--all", "-n", "50"]);
      expect(code).toBe(EXIT.ok);
      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0]?.operation).toBe("LinInbox");
      expect(stub.calls[0]?.variables).toEqual({ first: 50 });
      expect(captured.text()).toContain("04eb4e51,comment,,ENG-41,5d");
      expect(captured.text()).not.toContain("# ");
    } finally {
      captured.restore();
      stub.restore();
      box.cleanup();
    }
  });

  test("an empty inbox is a header line and nothing else", async () => {
    const { output } = await cli(
      [{ match: "LinInbox", data: { notifications: { nodes: [] } } }],
      () => inbox.run({ args: [], flags: {}, config: { limit: 50 }, command: inbox }),
    );

    expect(output).toBe("notifications[0]:\n");
  });
});

describe("inbox read", () => {
  test("resolves the 8-character ref to a UUID, then marks it read", async () => {
    const { calls, output } = await cli(
      [
        { match: "LinInboxRefs", data: REFS },
        { match: "LinInboxRead", data: { notificationUpdate: { success: true } } },
      ],
      () => inboxRead.run({ args: ["be46b7e2"], flags: {}, config: { limit: 50 }, command: inboxRead }),
    );

    expect(calls.map((call) => call.operation)).toEqual(["LinInboxRefs", "LinInboxRead"]);
    expect(calls[0]?.variables).toEqual({ first: 250 });
    expect(calls[1]?.variables).toMatchObject({ id: ASSIGNED });
    const input = (calls[1]?.variables as { input: { readAt: string } }).input;
    expect(input.readAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(output).toBe("read: be46b7e2\n");
  });

  test("--all sweeps every unread notification and leaves the read ones alone", async () => {
    const { calls, output } = await cli(
      [
        { match: "LinInboxRefs", data: REFS },
        { match: "LinInboxRead", data: { notificationUpdate: { success: true } } },
      ],
      () => inboxRead.run({ args: [], flags: { all: true }, config: { limit: 50 }, command: inboxRead }),
    );

    expect(calls.map((call) => call.operation)).toEqual([
      "LinInboxRefs",
      "LinInboxRead",
      "LinInboxRead",
    ]);
    expect(calls[1]?.variables).toMatchObject({ id: ASSIGNED });
    expect(calls[2]?.variables).toMatchObject({ id: UPDATE });
    expect(output).toBe("read: be46b7e2\nread: db87e39d\n");
  });

  test("an unknown ref is not found", async () => {
    const error = await cliError([{ match: "LinInboxRefs", data: REFS }], () =>
      inboxRead.run({ args: ["deadbeef"], flags: {}, config: { limit: 50 }, command: inboxRead }),
    );

    expect(error.exitCode).toBe(EXIT.notFound);
    expect(error.message).toBe('no notification "deadbeef"');
    expect(error.hint).toBe("run lin inbox --all to list refs");
  });

  test("an ambiguous prefix lists the candidates rather than guessing", async () => {
    const error = await cliError(
      [
        {
          match: "LinInboxRefs",
          data: {
            notifications: {
              nodes: [
                { id: "aaaa1111-1111-4111-8111-111111111111", readAt: null },
                { id: "aaaa2222-2222-4222-8222-222222222222", readAt: null },
              ],
            },
          },
        },
      ],
      () => inboxRead.run({ args: ["aaaa"], flags: {}, config: { limit: 50 }, command: inboxRead }),
    );

    expect(error.exitCode).toBe(EXIT.input);
    expect(error.message).toBe('notification "aaaa" is ambiguous');
    expect(error.hint).toBe("matches: aaaa1111, aaaa2222");
  });

  test("no refs and no --all names both ways to select", async () => {
    const error = await cliError([], () =>
      inboxRead.run({ args: [], flags: {}, config: { limit: 50 }, command: inboxRead }),
    );

    expect(error.exitCode).toBe(EXIT.input);
    expect(error.message).toBe("inbox read needs a notification");
    expect(error.hint).toBe("pass one or more refs from lin inbox, or --all to read every notification");
  });
});

describe("inbox archive", () => {
  test("archives the named notification", async () => {
    const { calls, output } = await cli(
      [
        { match: "LinInboxRefs", data: REFS },
        { match: "LinInboxArchive", data: { notificationArchive: { success: true } } },
      ],
      () =>
        inboxArchive.run({
          args: ["db87e39d"],
          flags: {},
          config: { limit: 50 },
          command: inboxArchive,
        }),
    );

    expect(calls.map((call) => call.operation)).toEqual(["LinInboxRefs", "LinInboxArchive"]);
    expect(calls[1]?.variables).toEqual({ id: UPDATE });
    expect(output).toBe("archived: db87e39d\n");
  });

  test("--all clears read and unread alike", async () => {
    const { calls, output } = await cli(
      [
        { match: "LinInboxRefs", data: REFS },
        { match: "LinInboxArchive", data: { notificationArchive: { success: true } } },
      ],
      () =>
        inboxArchive.run({
          args: [],
          flags: { all: true },
          config: { limit: 50 },
          command: inboxArchive,
        }),
    );

    expect(calls.filter((call) => call.operation === "LinInboxArchive")).toHaveLength(3);
    expect(output).toBe("archived: be46b7e2\narchived: db87e39d\narchived: 04eb4e51\n");
  });
});

describe("eventWord", () => {
  test("drops the entity the target column already carries", () => {
    expect(eventWord("IssueNotification", "issueDue")).toBe("due");
    expect(eventWord("PullRequestNotification", "pullRequestChecksFailed")).toBe("checksFailed");
    expect(eventWord("CustomerNeedNotification", "customerNeedCreated")).toBe("created");
  });

  test("shortens the events Linear spells out", () => {
    expect(eventWord("IssueNotification", "issueAssignedToYou")).toBe("assignment");
    expect(eventWord("IssueNotification", "issueStatusChanged")).toBe("status");
    expect(eventWord("IssueNotification", "issueCommentMention")).toBe("mention");
    expect(eventWord("ProjectNotification", "projectUpdateCreated")).toBe("update");
  });

  test("an unrecognised shape passes through rather than being mangled", () => {
    expect(eventWord("IssueNotification", "somethingNew")).toBe("somethingNew");
    expect(eventWord("WelcomeMessageNotification", "welcomeMessage")).toBe("welcomeMessage");
  });
});

describe("ageDays", () => {
  test("counts whole days and never goes negative", () => {
    const now = Date.parse("2026-08-01T12:00:00.000Z");
    expect(ageDays("2026-07-29T12:00:00.000Z", now)).toBe("3d");
    expect(ageDays("2026-08-01T11:00:00.000Z", now)).toBe("0d");
    expect(ageDays("2026-08-02T12:00:00.000Z", now)).toBe("0d");
    expect(ageDays("not a date", now)).toBe("");
  });
});
