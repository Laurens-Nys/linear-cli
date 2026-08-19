import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestRenderer, MouseButtons } from "@opentui/core/testing";
import type { Meta } from "../src/cache.ts";
import {
  actionSelectOptions,
  filterNamedOptions,
  firstTeamState,
  issueSelectOptions,
  issueTeam,
  priorityLabel,
  prioritySelectOptions,
  tuiIssueActions,
} from "../src/tui/actions.ts";
import { TuiApp, footerHint, type TuiAppOptions } from "../src/tui/app.ts";
import {
  TUI_COMMENT_DOCUMENT,
  TUI_MOVE_DOCUMENT,
  TUI_PRIORITY_DOCUMENT,
  TuiIssueStore,
  type TuiIssue,
  type TuiIssueDetail,
} from "../src/tui/data.ts";
import { mock, sandbox, type Mock, type Sandbox } from "./harness.ts";

const issues: TuiIssue[] = [
  { id: "issue-eng-42", identifier: "ENG-42", title: "Fix login redirect", priority: 2,
    updatedAt: "2026-08-12T10:00:00Z", dueDate: null, url: "https://linear.app/x/ENG-42",
    state: { id: "st-doing", name: "In Progress", color: "#e0af68", type: "started" }, team: { key: "ENG", name: "Engineering" },
    project: { name: "Reliability" }, labels: { nodes: [{ name: "Bug" }] } },
  { id: "issue-app-4", identifier: "APP-4", title: "Rotate webhook secrets", priority: 3,
    updatedAt: "2026-08-11T10:00:00Z", url: "https://linear.app/x/APP-4",
    state: { id: "st-todo", name: "Todo", color: "#a8a8a8", type: "unstarted" }, team: { key: "APP", name: "Applications" }, project: null, labels: { nodes: [] } },
];

function detailLoader(id: string, extra: Partial<TuiIssueDetail> = {}): TuiIssueDetail {
  return {
    description: extra.description ?? (id === "issue-eng-42" ? "Users bounce." : null),
    comments: extra.comments ?? [],
    updatedAt: extra.updatedAt ?? issues.find((issue) => issue.id === id)?.updatedAt ?? "",
  };
}

const meta: Meta = {
  fetchedAt: new Date().toISOString(), keyFingerprint: "x", workspace: { urlKey: "acme", name: "Acme" },
  teams: [
    { id: "team-eng", key: "ENG", name: "Engineering", states: [
      { id: "st-backlog", name: "Backlog", type: "backlog", position: 1, color: "#6c6c6c" },
      { id: "st-todo", name: "Todo", type: "unstarted", position: 2, color: "#a8a8a8" },
      { id: "st-doing", name: "In Progress", type: "started", position: 3, color: "#e0af68" },
      { id: "st-review", name: "In Review", type: "started", position: 4, color: "#bb9af7" },
      { id: "st-done", name: "Done", type: "completed", position: 4, color: "#9ece6a" },
    ], labels: [] },
    { id: "team-app", key: "APP", name: "Applications", states: [], labels: [] },
  ],
  projects: [], users: [], workspaceLabels: [], templates: [],
};

function appOptions(extras: Partial<TuiAppOptions> = {}): TuiAppOptions {
  return { limit: 25, meta, remote: false, ...extras };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function actionNames(): string[] {
  const list = currentList();
  return list?.options.map((option) => option.name) ?? [];
}

function currentList() {
  return currentApp?.root.findDescendantById("tui-actions-list") as import("@opentui/core").SelectRenderable | undefined;
}

const todoIssue: TuiIssue = {
  ...issues[0]!,
  state: { id: "st-todo", name: "Todo", color: "#a8a8a8", type: "unstarted" },
};

let box: Sandbox;
let currentApp: TuiApp | undefined;
let net: Mock | undefined;

beforeEach(() => { box = sandbox(); });
afterEach(async () => {
  currentApp?.quit(); currentApp = undefined;
  net?.restore(); net = undefined;
  box.cleanup(); await Bun.sleep(25);
});

describe("TUI action catalog", () => {
  test("lists existing actions and omits assign-me", () => {
    const eng = tuiIssueActions(issues[0]!, issueTeam(meta, issues[0]!));
    expect(eng.map((item) => item.id)).toEqual(["open", "copy-id", "copy-url", "start", "done", "priority", "comment"]);
    expect(tuiIssueActions(issues[0]!, issueTeam(meta, issues[0]!), { worktree: true }).map((item) => item.id)).toEqual([
      "worktree", "copy-id", "copy-url", "start", "done", "priority", "comment",
    ]);
    expect(eng.map((item) => item.name).join(" ")).not.toMatch(/assign/i);
    expect(eng.find((item) => item.id === "start")?.name).toBe("Move to In Progress");
    expect(eng.find((item) => item.id === "done")?.name).toBe("Move to Done");
    const app = tuiIssueActions(issues[1]!, issueTeam(meta, issues[1]!));
    expect(app.map((item) => item.id)).toEqual(["open", "copy-id", "copy-url", "priority", "comment"]);
    expect(firstTeamState(meta.teams[0], "started")?.id).toBe("st-doing");
    expect(firstTeamState(meta.teams[0], "completed")?.id).toBe("st-done");
    expect(priorityLabel(2)).toBe("High");
    expect(filterNamedOptions(actionSelectOptions(eng), "copy").map((option) => option.name)).toEqual([
      "Copy ENG-42", "Copy URL",
    ]);
    expect(prioritySelectOptions().map((option) => option.name)).toEqual([
      "Urgent", "High", "Medium", "Low", "No priority",
    ]);
    expect(issueSelectOptions(issues).map((option) => option.name)).toEqual([
      "ENG-42  Fix login redirect", "APP-4  Rotate webhook secrets",
    ]);
    expect(filterNamedOptions([
      ...actionSelectOptions(eng),
      ...issueSelectOptions(issues),
    ], "ENG-42").map((option) => option.name)).toEqual([
      "ENG-42  Fix login redirect", "Copy ENG-42",
    ]);
    expect(filterNamedOptions(actionSelectOptions(eng), "ENG-42").map((option) => option.name)).toEqual([
      "Copy ENG-42",
    ]);
  });

  test("footer names the action key without adding chrome", () => {
    expect(footerHint(false, false)).toContain("k actions");
    expect(footerHint(false, false, false, "board")).toContain("k actions");
    expect(footerHint(true, false)).toContain("k actions");
    expect(footerHint(false, true)).not.toContain("k actions");
  });
});

describe("TUI action menu", () => {
  test("right-click opens the menu for the exact list row", async () => {
    const setup = await createTestRenderer({ width: 110, height: 30, useMouse: true });
    const app = currentApp = new TuiApp(setup.renderer, new TuiIssueStore(async () => issues, async (id) => detailLoader(id)), appOptions());
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 2); await setup.flush();
      expect(app.list.getSelectedIssue()?.identifier).toBe("ENG-42");
      const second = app.root.findDescendantById("tui-issue-row-APP-4") as import("@opentui/core").BoxRenderable;
      await setup.mockMouse.click(second.screenX + 2, second.screenY, MouseButtons.RIGHT); await setup.flush();
      const modal = app.root.findDescendantById("tui-actions") as import("@opentui/core").BoxRenderable;
      expect(modal).toBeDefined();
      expect(modal.title).toBe("APP-4");
      expect(actionNames()).toEqual(["Open in Linear", "Copy APP-4", "Copy URL", "Set priority", "Add comment"]);
      expect(app.list.getSelectedIssue()?.identifier).toBe("APP-4");
      expect(app.root.findDescendantById("tui-actions-search")?.focused).toBe(true);
    } finally { setup.renderer.destroy(); }
  });

  test("left-click does not open the menu", async () => {
    const setup = await createTestRenderer({ width: 110, height: 30, useMouse: true });
    const app = currentApp = new TuiApp(setup.renderer, new TuiIssueStore(async () => issues, async (id) => detailLoader(id)), appOptions());
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 2); await setup.flush();
      const second = app.root.findDescendantById("tui-issue-row-APP-4") as import("@opentui/core").BoxRenderable;
      await setup.mockMouse.click(second.screenX + 2, second.screenY); await setup.flush();
      expect(app.root.findDescendantById("tui-actions")).toBeUndefined();
      expect(app.detail.title).toContain("APP-4");
    } finally { setup.renderer.destroy(); }
  });

  test("right-click opens the menu for the exact Kanban card without opening detail", async () => {
    const setup = await createTestRenderer({ width: 140, height: 32, useMouse: true });
    const app = currentApp = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => issues, async (id) => detailLoader(id)),
      { ...appOptions(), initialTeamId: "team-eng" },
    );
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 2); await setup.flush();
      setup.mockInput.pressKey("b");
      await setup.waitFor(() => app.board.visible && app.root.findDescendantById("tui-board-card-ENG-42") !== undefined);
      await setup.flush();
      const card = app.root.findDescendantById("tui-board-card-ENG-42") as import("@opentui/core").BoxRenderable;
      await setup.mockMouse.click(card.screenX + 2, card.screenY, MouseButtons.RIGHT); await setup.flush();
      const modal = app.root.findDescendantById("tui-actions") as import("@opentui/core").BoxRenderable;
      expect(modal.title).toBe("ENG-42");
      expect(app.board.visible).toBe(true);
      expect(app.detail.visible).toBe(false);
      expect(actionNames()).toContain("Move to In Progress");
      expect(actionNames()).toContain("Move to Done");
    } finally { setup.renderer.destroy(); }
  });

  test("keyboard k opens a searchable menu for the selected issue", async () => {
    const setup = await createTestRenderer({ width: 110, height: 30 });
    const app = currentApp = new TuiApp(setup.renderer, new TuiIssueStore(async () => issues, async (id) => detailLoader(id)), appOptions());
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 2); await setup.flush();
      setup.mockInput.pressKey("j"); await setup.flush();
      setup.mockInput.pressKey("k"); await setup.flush();
      expect((app.root.findDescendantById("tui-actions") as import("@opentui/core").BoxRenderable).title).toBe("APP-4");
      expect(actionNames()[0]).toBe("Open in Linear");
      expect(actionNames()).toContain("ENG-42  Fix login redirect");
      expect(actionNames()).toContain("APP-4  Rotate webhook secrets");
      await setup.mockInput.typeText("copy"); await setup.flush();
      expect(actionNames()).toEqual(["Copy APP-4", "Copy URL"]);
    } finally { setup.renderer.destroy(); }
  });

  test("mouse, arrows, enter, and escape drive the menu", async () => {
    const copied: string[] = [];
    const setup = await createTestRenderer({ width: 110, height: 30, useMouse: true });
    const app = currentApp = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => issues, async (id) => detailLoader(id)),
      appOptions({ copyToClipboard: (text) => { copied.push(text); return true; } }),
    );
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 2); await setup.flush();
      app.list.focus();
      setup.mockInput.pressKey("k"); await setup.flush();
      const list = currentList()!;
      await setup.mockMouse.click(list.screenX + 2, list.screenY + 1); await setup.flush();
      expect(copied).toEqual(["ENG-42"]);
      expect(app.root.findDescendantById("tui-actions")).toBeUndefined();
      expect(app.list.focused).toBe(true);

      setup.mockInput.pressKey("k"); await setup.flush();
      const input = app.root.findDescendantById("tui-actions-search") as import("@opentui/core").InputRenderable;
      input.focus();
      setup.mockInput.pressArrow("down"); await setup.flush();
      expect(currentList()?.focused).toBe(true);
      setup.mockInput.pressArrow("down"); setup.mockInput.pressArrow("down"); setup.mockInput.pressEnter(); await setup.flush();
      expect(copied).toEqual(["ENG-42", "https://linear.app/x/ENG-42"]);

      setup.mockInput.pressKey("k"); await setup.flush();
      expect(app.root.findDescendantById("tui-actions")).toBeDefined();
      setup.mockInput.pressEscape(); await Bun.sleep(40); await setup.flush();
      expect(app.root.findDescendantById("tui-actions")).toBeUndefined();
      expect(app.list.focused).toBe(true);
    } finally { setup.renderer.destroy(); }
  });

  test("one Escape from nested Priority returns to the action menu; a second Escape closes it", async () => {
    const setup = await createTestRenderer({ width: 110, height: 30 });
    const app = currentApp = new TuiApp(setup.renderer, new TuiIssueStore(async () => issues, async (id) => detailLoader(id)), appOptions());
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 2); await setup.flush();
      setup.mockInput.pressKey("k"); await setup.flush();
      await setup.mockInput.typeText("priority"); setup.mockInput.pressEnter(); await setup.flush();
      expect((app.root.findDescendantById("tui-actions") as import("@opentui/core").BoxRenderable).title).toContain("Priority");
      expect(actionNames()).toEqual(["Urgent", "High", "Medium", "Low", "No priority"]);

      setup.mockInput.pressEscape(); await Bun.sleep(40); await setup.flush();
      const modal = app.root.findDescendantById("tui-actions") as import("@opentui/core").BoxRenderable;
      expect(modal).toBeDefined();
      expect(modal.title).toBe("ENG-42");
      expect(actionNames()).toEqual([
        "Open in Linear", "Copy ENG-42", "Copy URL", "Move to In Progress", "Move to Done", "Set priority", "Add comment",
        "ENG-42  Fix login redirect", "APP-4  Rotate webhook secrets",
      ]);
      expect(app.root.findDescendantById("tui-actions-search")?.focused).toBe(true);

      setup.mockInput.pressEscape(); await Bun.sleep(40); await setup.flush();
      expect(app.root.findDescendantById("tui-actions")).toBeUndefined();
      expect(app.list.focused).toBe(true);
    } finally { setup.renderer.destroy(); }
  });

  test("every action dispatches against the menu issue", async () => {
    const opened: string[] = [];
    const copied: string[] = [];
    const moves: { issueId: string; stateId: string }[] = [];
    const priorities: { issueId: string; priority: number }[] = [];
    const comments: { issueId: string; body: string }[] = [];
    const setup = await createTestRenderer({ width: 110, height: 30 });
    const todo = { ...issues[0]!, state: { id: "st-todo", name: "Todo", color: "#a8a8a8", type: "unstarted" as const } };
    const app = currentApp = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => [todo, issues[1]!], async (id) => detailLoader(id)),
      appOptions({
        openExternal: (url) => { opened.push(url); },
        copyToClipboard: (text) => { copied.push(text); return true; },
        moveIssue: async (issueId, stateId) => {
          moves.push({ issueId, stateId });
          const state = meta.teams[0]!.states.find((item) => item.id === stateId)!;
          return { id: state.id, name: state.name, color: state.color ?? "", type: state.type as TuiIssue["state"]["type"] };
        },
        updatePriority: async (issueId, priority) => { priorities.push({ issueId, priority }); return priority; },
        createComment: async (issueId, body) => { comments.push({ issueId, body }); return { id: "c-new" }; },
      }),
    );
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 2); await setup.flush();
      const run = async (query: string) => {
        setup.mockInput.pressKey("k"); await setup.flush();
        const input = app.root.findDescendantById("tui-actions-search") as import("@opentui/core").InputRenderable;
        input.value = "";
        await setup.mockInput.typeText(query); await setup.flush();
        setup.mockInput.pressEnter(); await setup.flush();
      };
      await run("open");
      await run("copy eng");
      await run("copy url");
      await run("in progress");
      await setup.waitFor(() => moves.length === 1 && !app.footer.plainText.includes("Moving"));
      await run("done");
      await setup.waitFor(() => moves.length === 2 && !app.footer.plainText.includes("Moving"));
      await run("priority");
      expect((app.root.findDescendantById("tui-actions") as import("@opentui/core").BoxRenderable).title).toContain("Priority");
      await setup.mockInput.typeText("high"); setup.mockInput.pressEnter();
      await setup.waitFor(() => priorities.length === 1);
      await run("comment");
      const comment = app.root.findDescendantById("tui-comment-input") as import("@opentui/core").InputRenderable;
      expect(comment.focused).toBe(true);
      await setup.mockInput.typeText("Looks good."); setup.mockInput.pressEnter();
      await setup.waitFor(() => comments.length === 1);
      expect(opened).toEqual(["linear://linear.app/x/ENG-42"]);
      expect(copied).toEqual(["ENG-42", "https://linear.app/x/ENG-42"]);
      expect(moves).toEqual([
        { issueId: "issue-eng-42", stateId: "st-doing" },
        { issueId: "issue-eng-42", stateId: "st-done" },
      ]);
      expect(priorities).toEqual([{ issueId: "issue-eng-42", priority: 2 }]);
      expect(comments).toEqual([{ issueId: "issue-eng-42", body: "Looks good." }]);
    } finally { setup.renderer.destroy(); }
  });

  test("priority updates the summary and rolls back on a one-attempt failure", async () => {
    const setup = await createTestRenderer({ width: 110, height: 30 });
    const update = deferred<number>();
    let calls = 0;
    const app = currentApp = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => issues, async (id) => detailLoader(id)),
      appOptions({
        updatePriority: async () => {
          calls += 1;
          return update.promise;
        },
      }),
    );
    try {
      app.start(); await setup.waitFor(() => app.detailMarkdown.content.includes("Priority: High")); await setup.flush();
      app.openActions(issues[0]!); await setup.flush();
      const input = app.root.findDescendantById("tui-actions-search") as import("@opentui/core").InputRenderable;
      await setup.mockInput.typeText("priority"); setup.mockInput.pressEnter(); await setup.flush();
      input.value = "";
      await setup.mockInput.typeText("urgent"); setup.mockInput.pressEnter();
      await setup.waitFor(() => app.detailMarkdown.content.includes("Priority: Urgent"));
      expect(app.footer.plainText).toContain("Setting ENG-42 to Urgent");
      expect(app.list.getSelectedIssue()?.priority).toBe(1);
      update.reject(new Error("offline"));
      await setup.waitFor(() => app.footer.plainText.includes("Could not set priority"));
      expect(app.detailMarkdown.content).toContain("Priority: High");
      expect(app.list.getSelectedIssue()?.priority).toBe(2);
      expect(calls).toBe(1);
    } finally { setup.renderer.destroy(); }
  });

  test("comment success invalidates and refetches detail; blank and failed writes stay visible", async () => {
    const setup = await createTestRenderer({ width: 110, height: 30 });
    const creates: Array<ReturnType<typeof deferred<{ id: string }>>> = [];
    let details = 0;
    let comments = 0;
    const app = currentApp = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => issues, async (id) => {
        details += 1;
        return detailLoader(id, details === 1
          ? { description: "Users bounce." }
          : { description: "Users bounce.", comments: [{ id: "c-new", createdAt: "2026-08-12T11:00:00Z", body: "Looks good.", user: { displayName: "Casey" } }] });
      }),
      appOptions({
        createComment: async () => {
          comments += 1;
          const next = deferred<{ id: string }>();
          creates.push(next);
          return next.promise;
        },
      }),
    );
    try {
      app.start(); await setup.waitFor(() => details === 1 && app.detailMarkdown.content.includes("Users bounce.")); await setup.flush();
      app.openActions(issues[0]!); await setup.flush();
      await setup.mockInput.typeText("comment"); setup.mockInput.pressEnter(); await setup.flush();
      const input = app.root.findDescendantById("tui-comment-input") as import("@opentui/core").InputRenderable;
      expect(input.focused).toBe(true);
      setup.mockInput.pressEnter(); await setup.flush();
      expect((app.root.findDescendantById("tui-comment-status") as import("@opentui/core").TextRenderable).plainText).toContain("empty");
      expect(comments).toBe(0);
      await setup.mockInput.typeText("Looks good."); setup.mockInput.pressEnter();
      await setup.waitFor(() => comments === 1);
      expect((app.root.findDescendantById("tui-comment") as import("@opentui/core").BoxRenderable).title).toContain("Saving");
      creates[0]!.reject(new Error("offline"));
      await setup.waitFor(() => app.footer.plainText.includes("Could not comment"));
      expect((app.root.findDescendantById("tui-comment-status") as import("@opentui/core").TextRenderable).plainText).toContain("offline");
      expect(app.detailMarkdown.content).not.toContain("Looks good.");
      expect(comments).toBe(1);
      setup.mockInput.pressEnter();
      await setup.waitFor(() => comments === 2);
      creates[1]!.resolve({ id: "c-new" });
      await setup.waitFor(() => app.detailMarkdown.content.includes("Looks good.") && app.footer.plainText.includes("Commented on ENG-42"));
      expect(details).toBe(2);
      expect(app.root.findDescendantById("tui-comment")).toBeUndefined();
    } finally { setup.renderer.destroy(); }
  });

  test("default priority and comment writers send one GraphQL mutation and roll back on network failure", async () => {
    net = mock([
      { match: "LinTuiSetPriority", networkError: "offline" },
      { match: "LinTuiSetPriority", data: { issueUpdate: { issue: { id: "issue-eng-42", identifier: "ENG-42", priority: 1 } } } },
      { match: "LinTuiCommentCreate", networkError: "offline" },
      { match: "LinTuiCommentCreate", data: { commentCreate: { comment: { id: "c-new" } } } },
    ]);
    const setup = await createTestRenderer({ width: 110, height: 30 });
    const app = currentApp = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => issues, async (id) => detailLoader(id)),
      appOptions(),
    );
    try {
      app.start(); await setup.waitFor(() => app.detailMarkdown.content.includes("Priority: High")); await setup.flush();
      app.openActions(issues[0]!); await setup.flush();
      await setup.mockInput.typeText("priority"); setup.mockInput.pressEnter(); await setup.flush();
      const input = app.root.findDescendantById("tui-actions-search") as import("@opentui/core").InputRenderable;
      input.value = "";
      await setup.mockInput.typeText("urgent"); setup.mockInput.pressEnter();
      await setup.waitFor(() => app.footer.plainText.includes("Could not set priority"));
      expect(app.detailMarkdown.content).toContain("Priority: High");
      expect(app.list.getSelectedIssue()?.priority).toBe(2);
      expect(net.calls).toHaveLength(1);
      expect(net.calls[0]?.operation).toBe("LinTuiSetPriority");
      expect(net.calls[0]?.document).toBe(TUI_PRIORITY_DOCUMENT);
      expect(net.calls[0]?.variables).toEqual({ id: "issue-eng-42", priority: 1 });

      app.openActions(issues[0]!); await setup.flush();
      await setup.mockInput.typeText("comment"); setup.mockInput.pressEnter(); await setup.flush();
      await setup.mockInput.typeText("Looks good."); setup.mockInput.pressEnter();
      await setup.waitFor(() => app.footer.plainText.includes("Could not comment"));
      expect(app.root.findDescendantById("tui-comment")).toBeDefined();
      expect((app.root.findDescendantById("tui-comment-status") as import("@opentui/core").TextRenderable).plainText).toContain("offline");
      expect(app.detailMarkdown.content).not.toContain("Looks good.");
      expect(net.calls).toHaveLength(2);
      expect(net.calls[1]?.operation).toBe("LinTuiCommentCreate");
      expect(net.calls[1]?.document).toBe(TUI_COMMENT_DOCUMENT);
      expect(net.calls[1]?.variables).toEqual({ input: { issueId: "issue-eng-42", body: "Looks good." } });
    } finally { setup.renderer.destroy(); }
  });

  test("start and done writes attempt once and roll back optimistic state", async () => {
    net = mock([
      { match: "LinTuiMoveIssue", networkError: "offline" },
      { match: "LinTuiMoveIssue", networkError: "offline" },
      { match: "LinTuiMoveIssue", data: { issueUpdate: { issue: {
        id: "issue-eng-42", identifier: "ENG-42",
        state: { id: "st-doing", name: "In Progress", color: "#e0af68", type: "started" },
      } } } },
    ]);
    const setup = await createTestRenderer({ width: 110, height: 30 });
    const app = currentApp = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => [todoIssue], async (id) => detailLoader(id)),
      appOptions(),
    );
    try {
      app.start(); await setup.waitFor(() => app.detailMarkdown.content.includes("Todo")); await setup.flush();
      expect(app.list.getSelectedIssue()?.state.id).toBe("st-todo");
      app.openActions(todoIssue); await setup.flush();
      await setup.mockInput.typeText("in progress"); setup.mockInput.pressEnter();
      await setup.waitFor(() => app.footer.plainText.includes("Could not move ENG-42"));
      expect(app.list.getSelectedIssue()?.state).toEqual({
        id: "st-todo", name: "Todo", color: "#a8a8a8", type: "unstarted",
      });
      expect(app.detailMarkdown.content).toContain("Todo");
      expect(net.calls).toHaveLength(1);
      expect(net.calls[0]?.operation).toBe("LinTuiMoveIssue");
      expect(net.calls[0]?.document).toBe(TUI_MOVE_DOCUMENT);
      expect(net.calls[0]?.variables).toEqual({ id: "issue-eng-42", stateId: "st-doing" });

      app.openActions(todoIssue); await setup.flush();
      await setup.mockInput.typeText("done"); setup.mockInput.pressEnter();
      await setup.waitFor(() => app.footer.plainText.includes("Could not move ENG-42"));
      expect(app.list.getSelectedIssue()?.state).toEqual({
        id: "st-todo", name: "Todo", color: "#a8a8a8", type: "unstarted",
      });
      expect(app.detailMarkdown.content).toContain("Todo");
      expect(net.calls).toHaveLength(2);
      expect(net.calls[1]?.operation).toBe("LinTuiMoveIssue");
      expect(net.calls[1]?.document).toBe(TUI_MOVE_DOCUMENT);
      expect(net.calls[1]?.variables).toEqual({ id: "issue-eng-42", stateId: "st-done" });
    } finally { setup.renderer.destroy(); }
  });

  test("modals stay focused on a narrow terminal and restore the previous pane", async () => {
    const setup = await createTestRenderer({ width: 60, height: 28 });
    const app = currentApp = new TuiApp(setup.renderer, new TuiIssueStore(async () => issues, async (id) => detailLoader(id)), appOptions());
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 2); await setup.flush();
      expect(app.list.visible).toBe(true);
      setup.mockInput.pressKey("k"); await setup.flush();
      const modal = app.root.findDescendantById("tui-actions") as import("@opentui/core").BoxRenderable;
      expect(modal).toBeDefined();
      expect(app.root.findDescendantById("tui-actions-search")?.focused).toBe(true);
      expect(modal.width).toBeGreaterThan(40);
      setup.mockInput.pressEscape(); await Bun.sleep(40); await setup.flush();
      expect(app.list.focused).toBe(true);
      app.detail.focus();
      setup.mockInput.pressKey("k"); await setup.flush();
      await setup.mockInput.typeText("comment"); setup.mockInput.pressEnter(); await setup.flush();
      expect(app.root.findDescendantById("tui-comment-input")?.focused).toBe(true);
      setup.mockInput.pressEscape(); await Bun.sleep(40); await setup.flush();
      expect(app.detail.focused).toBe(true);
    } finally { setup.renderer.destroy(); }
  });

  test("copy uses the injected clipboard and never opens a shell", async () => {
    const copied: string[] = [];
    const setup = await createTestRenderer({ width: 110, height: 30 });
    const app = currentApp = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => issues, async (id) => detailLoader(id)),
      appOptions({
        remote: true,
        copyToClipboard: (text) => { copied.push(text); return true; },
      }),
    );
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 2); await setup.flush();
      app.openActions(issues[0]!); await setup.flush();
      await setup.mockInput.typeText("open"); setup.mockInput.pressEnter(); await setup.flush();
      expect(copied).toEqual(["https://linear.app/x/ENG-42"]);
      expect(app.footer.plainText).toContain("ctrl-click");
    } finally { setup.renderer.destroy(); }
  });
});
