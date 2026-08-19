import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestRenderer, MouseButtons } from "@opentui/core/testing";
import type { Meta } from "../src/cache.ts";
import { TuiApp, type TuiAppOptions } from "../src/tui/app.ts";
import { KanbanBoardEvents, KanbanBoardRenderable } from "../src/tui/board.ts";
import {
  TUI_MOVE_DOCUMENT,
  TuiIssueStore,
  type TuiIssue,
  type TuiIssueDetail,
} from "../src/tui/data.ts";
import { bindGenerationScrollRestore, IssueListRenderable } from "../src/tui/issue-list.ts";
import { mock, sandbox, type Mock, type Sandbox } from "./harness.ts";

const issues: TuiIssue[] = [
  { id: "issue-eng-42", identifier: "ENG-42", title: "Fix login redirect", priority: 2,
    updatedAt: "2026-08-12T10:00:00Z", dueDate: null, url: "https://linear.app/x/ENG-42",
    state: { id: "st-todo", name: "Todo", color: "#a8a8a8", type: "unstarted" }, team: { key: "ENG", name: "Engineering" },
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
      { id: "st-done", name: "Done", type: "completed", position: 4, color: "#9ece6a" },
    ], labels: [] },
    { id: "team-app", key: "APP", name: "Applications", states: [], labels: [] },
  ],
  projects: [], users: [], workspaceLabels: [], templates: [],
};

function appOptions(extras: Partial<TuiAppOptions> = {}): TuiAppOptions {
  return { limit: 25, meta, remote: false, undoDurationMs: 8_000, backgroundRefreshMs: 0, ...extras };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function actionNames(app: TuiApp): string[] {
  const list = app.root.findDescendantById("tui-actions-list") as import("@opentui/core").SelectRenderable | undefined;
  return list?.options.map((option) => option.name) ?? [];
}

function manyIssues(count: number): TuiIssue[] {
  return Array.from({ length: count }, (_, index): TuiIssue => ({
    ...issues[0]!,
    id: `issue-${index}`,
    identifier: `ENG-${index}`,
    title: `Scroll item ${index}`,
    state: { ...issues[0]!.state, id: index === 0 ? "st-doing" : "st-todo", name: index === 0 ? "In Progress" : "Todo", type: index === 0 ? "started" : "unstarted" },
  }));
}

let box: Sandbox;
let currentApp: TuiApp | undefined;
let net: Mock | undefined;

beforeEach(() => { box = sandbox(); });
afterEach(async () => {
  currentApp?.quit(); currentApp = undefined;
  net?.restore(); net = undefined;
  box.cleanup(); await Bun.sleep(25);
});

describe("TUI undo", () => {
  test("Start and Done keep one undo that u reverses once", async () => {
    const moves: { issueId: string; stateId: string }[] = [];
    const setup = await createTestRenderer({ width: 110, height: 30 });
    const app = currentApp = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => [issues[0]!], async (id) => detailLoader(id)),
      appOptions({
        moveIssue: async (issueId, stateId) => {
          moves.push({ issueId, stateId });
          const state = meta.teams[0]!.states.find((item) => item.id === stateId)!;
          return { id: state.id, name: state.name, color: state.color ?? "", type: state.type as TuiIssue["state"]["type"] };
        },
      }),
    );
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 1); await setup.flush();
      setup.mockInput.pressKey("k"); await setup.flush();
      await setup.mockInput.typeText("in progress"); setup.mockInput.pressEnter();
      await setup.waitFor(() => app.footer.plainText.includes("Moved ENG-42 to In Progress · u undo"));
      expect(app.list.getSelectedIssue()?.state.id).toBe("st-doing");
      setup.mockInput.pressKey("u");
      await setup.waitFor(() => app.footer.plainText.includes("Restored ENG-42"));
      expect(app.list.getSelectedIssue()?.state.id).toBe("st-todo");
      expect(moves).toEqual([
        { issueId: "issue-eng-42", stateId: "st-doing" },
        { issueId: "issue-eng-42", stateId: "st-todo" },
      ]);
      await Bun.sleep(50); await setup.flush();
      setup.mockInput.pressKey("u"); await setup.flush();
      expect(moves).toHaveLength(2);
    } finally { setup.renderer.destroy(); }
  });

  test("a successful board drop is undone from the footer click", async () => {
    const moves: { issueId: string; stateId: string }[] = [];
    const setup = await createTestRenderer({ width: 140, height: 32, useMouse: true });
    const app = currentApp = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => [issues[0]!], async (id) => detailLoader(id)),
      appOptions({
        initialTeamId: "team-eng",
        moveIssue: async (issueId, stateId) => {
          moves.push({ issueId, stateId });
          const state = meta.teams[0]!.states.find((item) => item.id === stateId)!;
          return { id: state.id, name: state.name, color: state.color ?? "", type: state.type as TuiIssue["state"]["type"] };
        },
      }),
    );
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 1); await setup.flush();
      setup.mockInput.pressKey("b");
      await setup.waitFor(() => app.board.visible && app.root.findDescendantById("tui-board-card-ENG-42") !== undefined);
      await setup.flush();
      app.board.emit(KanbanBoardEvents.ISSUE_DROPPED, {
        issue: issues[0]!,
        state: { id: "st-done", name: "Done", type: "completed", position: 4, color: "#9ece6a" },
      });
      await setup.waitFor(() => app.footer.plainText.includes("Moved ENG-42 to Done · u undo"));
      expect(app.board.getSelectedIssue()?.state.id).toBe("st-done");
      await setup.mockMouse.click(app.footer.screenX + 2, app.footer.screenY); await setup.flush();
      await setup.waitFor(() => app.footer.plainText.includes("Restored ENG-42"));
      expect(app.board.getSelectedIssue()?.state.id).toBe("st-todo");
      expect(moves).toEqual([
        { issueId: "issue-eng-42", stateId: "st-done" },
        { issueId: "issue-eng-42", stateId: "st-todo" },
      ]);
    } finally { setup.renderer.destroy(); }
  });

  test("undo expires after the injectable window", async () => {
    const moves: string[] = [];
    const setup = await createTestRenderer({ width: 110, height: 30 });
    const app = currentApp = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => [issues[0]!], async (id) => detailLoader(id)),
      appOptions({
        undoDurationMs: 40,
        moveIssue: async (_issueId, stateId) => {
          moves.push(stateId);
          const state = meta.teams[0]!.states.find((item) => item.id === stateId)!;
          return { id: state.id, name: state.name, color: state.color ?? "", type: state.type as TuiIssue["state"]["type"] };
        },
      }),
    );
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 1); await setup.flush();
      setup.mockInput.pressKey("k"); await setup.flush();
      await setup.mockInput.typeText("in progress"); setup.mockInput.pressEnter();
      await setup.waitFor(() => app.footer.plainText.includes("u undo"));
      await Bun.sleep(60); await setup.flush();
      expect(app.footer.plainText).not.toContain("u undo");
      setup.mockInput.pressKey("u"); await setup.flush();
      expect(moves).toEqual(["st-doing"]);
      expect(app.list.getSelectedIssue()?.state.id).toBe("st-doing");
    } finally { setup.renderer.destroy(); }
  });

  test("a newer move replaces the prior undo snapshot", async () => {
    const moves: string[] = [];
    const setup = await createTestRenderer({ width: 110, height: 30 });
    const app = currentApp = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => [issues[0]!], async (id) => detailLoader(id)),
      appOptions({
        moveIssue: async (_issueId, stateId) => {
          moves.push(stateId);
          const state = meta.teams[0]!.states.find((item) => item.id === stateId)!;
          return { id: state.id, name: state.name, color: state.color ?? "", type: state.type as TuiIssue["state"]["type"] };
        },
      }),
    );
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 1); await setup.flush();
      setup.mockInput.pressKey("k"); await setup.flush();
      await setup.mockInput.typeText("in progress"); setup.mockInput.pressEnter();
      await setup.waitFor(() => app.footer.plainText.includes("In Progress · u undo"));
      setup.mockInput.pressKey("k"); await setup.flush();
      await setup.mockInput.typeText("done"); setup.mockInput.pressEnter();
      await setup.waitFor(() => app.footer.plainText.includes("Moved ENG-42 to Done · u undo"));
      setup.mockInput.pressKey("u");
      await setup.waitFor(() => app.list.getSelectedIssue()?.state.id === "st-doing" && app.footer.plainText.includes("Restored ENG-42"));
      expect(moves).toEqual(["st-doing", "st-done", "st-doing"]);
    } finally { setup.renderer.destroy(); }
  });

  test("a failed one-attempt undo keeps the current state and clears the snapshot", async () => {
    net = mock([
      { match: "LinTuiMoveIssue", data: { issueUpdate: { issue: {
        id: "issue-eng-42", identifier: "ENG-42",
        state: { id: "st-doing", name: "In Progress", color: "#e0af68", type: "started" },
      } } } },
      { match: "LinTuiMoveIssue", networkError: "offline" },
    ]);
    const setup = await createTestRenderer({ width: 110, height: 30 });
    const app = currentApp = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => [issues[0]!], async (id) => detailLoader(id)),
      appOptions(),
    );
    try {
      app.start(); await setup.waitFor(() => app.detailMarkdown.content.includes("Todo")); await setup.flush();
      setup.mockInput.pressKey("k"); await setup.flush();
      await setup.mockInput.typeText("in progress"); setup.mockInput.pressEnter();
      await setup.waitFor(() => app.footer.plainText.includes("Moved ENG-42 to In Progress · u undo"));
      expect(app.list.getSelectedIssue()?.state.id).toBe("st-doing");
      setup.mockInput.pressKey("u");
      await setup.waitFor(() => app.footer.plainText.includes("Could not undo ENG-42"));
      expect(app.list.getSelectedIssue()?.state.id).toBe("st-doing");
      expect(net.calls).toHaveLength(2);
      expect(net.calls[1]?.document).toBe(TUI_MOVE_DOCUMENT);
      expect(net.calls[1]?.variables).toEqual({ id: "issue-eng-42", stateId: "st-todo" });
      setup.mockInput.pressKey("u"); await setup.flush();
      expect(net.calls).toHaveLength(2);
      expect(app.footer.plainText).not.toContain("u undo");
    } finally { setup.renderer.destroy(); }
  });

  test("priority and comment discard an older state undo and never arm one", async () => {
    const moves: string[] = [];
    const setup = await createTestRenderer({ width: 110, height: 30 });
    const app = currentApp = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => [issues[0]!], async (id) => detailLoader(id)),
      appOptions({
        moveIssue: async (_issueId, stateId) => {
          moves.push(stateId);
          const state = meta.teams[0]!.states.find((item) => item.id === stateId)!;
          return { id: state.id, name: state.name, color: state.color ?? "", type: state.type as TuiIssue["state"]["type"] };
        },
        updatePriority: async (_issueId, priority) => priority,
        createComment: async () => ({ id: "c-new" }),
      }),
    );
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 1); await setup.flush();
      setup.mockInput.pressKey("k"); await setup.flush();
      await setup.mockInput.typeText("in progress"); setup.mockInput.pressEnter();
      await setup.waitFor(() => app.footer.plainText.includes("u undo"));

      setup.mockInput.pressKey("k"); await setup.flush();
      await setup.mockInput.typeText("priority"); setup.mockInput.pressEnter(); await setup.flush();
      await setup.mockInput.typeText("urgent"); setup.mockInput.pressEnter();
      await setup.waitFor(() => app.list.getSelectedIssue()?.priority === 1);
      expect(app.footer.plainText).not.toContain("u undo");
      setup.mockInput.pressKey("u"); await setup.flush();
      expect(moves).toEqual(["st-doing"]);

      setup.mockInput.pressKey("k"); await setup.flush();
      await setup.mockInput.typeText("done"); setup.mockInput.pressEnter();
      await setup.waitFor(() => app.footer.plainText.includes("u undo"));
      setup.mockInput.pressKey("k"); await setup.flush();
      await setup.mockInput.typeText("comment"); setup.mockInput.pressEnter(); await setup.flush();
      await setup.mockInput.typeText("Looks good."); setup.mockInput.pressEnter();
      await setup.waitFor(() => app.footer.plainText.includes("Commented on ENG-42"));
      expect(app.footer.plainText).not.toContain("u undo");
      setup.mockInput.pressKey("u"); await setup.flush();
      expect(moves).toEqual(["st-doing", "st-done"]);
    } finally { setup.renderer.destroy(); }
  });

  test("a failed follow-up move discards the prior undo so quiet refresh can run", async () => {
    let loads = 0;
    const setup = await createTestRenderer({ width: 110, height: 30 });
    const app = currentApp = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => { loads += 1; return [issues[0]!]; }, async (id) => detailLoader(id)),
      appOptions({
        moveIssue: async (_issueId, stateId) => {
          if (stateId === "st-doing") {
            return { id: "st-doing", name: "In Progress", color: "#e0af68", type: "started" };
          }
          throw new Error("offline");
        },
      }),
    );
    try {
      app.start(); await setup.waitFor(() => loads === 1 && app.list.options.length === 1); await setup.flush();
      setup.mockInput.pressKey("k"); await setup.flush();
      await setup.mockInput.typeText("in progress"); setup.mockInput.pressEnter();
      await setup.waitFor(() => app.footer.plainText.includes("Moved ENG-42 to In Progress · u undo"));
      setup.mockInput.pressKey("k"); await setup.flush();
      await setup.mockInput.typeText("done"); setup.mockInput.pressEnter();
      await setup.waitFor(() => app.footer.plainText.includes("Could not move ENG-42"));
      expect(app.list.getSelectedIssue()?.state.id).toBe("st-doing");
      expect(app.footer.plainText).not.toContain("u undo");
      setup.mockInput.pressKey("u"); await setup.flush();
      expect(app.list.getSelectedIssue()?.state.id).toBe("st-doing");
      await app.refresh({ quiet: true });
      expect(loads).toBe(2);
    } finally { setup.renderer.destroy(); }
  });
});

describe("TUI quiet refresh", () => {
  test("ticks without a Refreshing banner and preserves list identity and scroll", async () => {
    const loaded: TuiIssue[][] = [];
    const rows = manyIssues(12);
    const setup = await createTestRenderer({ width: 110, height: 24 });
    const app = currentApp = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => { loaded.push(rows); return rows; }, async (id) => detailLoader(id)),
      appOptions({ backgroundRefreshMs: 30 }),
    );
    try {
      app.start(); await setup.waitFor(() => loaded.length === 1 && app.list.options.length === 12); await setup.flush();
      app.list.scrollTop = 8;
      const selected = app.list.getSelectedIssue()?.identifier;
      const detailTitle = app.detail.title;
      await setup.waitFor(() => loaded.length >= 2);
      await setup.flush();
      expect(app.countText.plainText).not.toContain("Refreshing");
      expect(app.footer.plainText).not.toContain("Refreshing");
      expect(app.list.getSelectedIssue()?.identifier).toBe(selected);
      expect(app.detail.title).toBe(detailTitle);
      expect(app.list.scrollTop).toBe(8);
    } finally { setup.renderer.destroy(); }
  });

  test("skips while the action menu is open and never overlaps an in-flight tick", async () => {
    const loads: Array<ReturnType<typeof deferred<TuiIssue[]>>> = [];
    const setup = await createTestRenderer({ width: 110, height: 30 });
    const app = currentApp = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => {
        const next = deferred<TuiIssue[]>();
        loads.push(next);
        return next.promise;
      }, async (id) => detailLoader(id)),
      appOptions(),
    );
    try {
      app.start();
      await setup.waitFor(() => loads.length === 1);
      loads[0]!.resolve([issues[0]!]);
      await setup.waitFor(() => app.list.options.length === 1); await setup.flush();
      setup.mockInput.pressKey("k"); await setup.flush();
      expect(app.root.findDescendantById("tui-actions")).toBeDefined();
      await app.refresh({ quiet: true });
      expect(loads).toHaveLength(1);
      setup.mockInput.pressEscape(); await Bun.sleep(40); await setup.flush();
      const quiet = app.refresh({ quiet: true });
      await setup.waitFor(() => loads.length === 2);
      void app.refresh({ quiet: true });
      await Bun.sleep(20);
      expect(loads).toHaveLength(2);
      loads[1]!.resolve([issues[0]!]);
      await quiet;
      expect(loads).toHaveLength(2);
    } finally { setup.renderer.destroy(); }
  });

  test("quiet offline marks the footer without overwriting a notice, and quit cancels ticks", async () => {
    let loads = 0;
    const setup = await createTestRenderer({ width: 110, height: 30 });
    const app = currentApp = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => {
        loads += 1;
        if (loads === 1) return [issues[0]!];
        throw new Error("offline");
      }, async (id) => detailLoader(id)),
      appOptions({
        backgroundRefreshMs: 25,
        copyToClipboard: () => true,
      }),
    );
    try {
      app.start(); await setup.waitFor(() => loads === 1 && app.list.options.length === 1); await setup.flush();
      setup.mockInput.pressKey("k"); await setup.flush();
      await setup.mockInput.typeText("copy eng"); setup.mockInput.pressEnter(); await setup.flush();
      expect(app.footer.plainText).toContain("copied ENG-42");
      await setup.waitFor(() => loads >= 2);
      await Bun.sleep(20); await setup.flush();
      expect(app.footer.plainText).toContain("copied ENG-42");
      expect(app.footer.plainText).not.toContain("Could not refresh");
      expect(app.footer.plainText).not.toContain("offline");
      expect(app.countText.plainText).not.toContain("Refreshing");
      setup.mockInput.pressKey("r");
      await setup.waitFor(() => app.footer.plainText.includes("Could not refresh"));
      expect(app.countText.plainText).toBe("1");
      const afterManual = loads;
      app.quit();
      await Bun.sleep(80);
      expect(loads).toBe(afterManual);
    } finally { setup.renderer.destroy(); }
  });

  test("quiet board refresh keeps the same card and scroll", async () => {
    let loads = 0;
    const rows = manyIssues(10);
    const setup = await createTestRenderer({ width: 140, height: 24 });
    const app = currentApp = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => { loads += 1; return rows; }, async (id) => detailLoader(id)),
      appOptions({ initialTeamId: "team-eng", backgroundRefreshMs: 30 }),
    );
    try {
      app.start(); await setup.waitFor(() => loads === 1 && app.list.options.length === 10); await setup.flush();
      setup.mockInput.pressKey("b");
      await setup.waitFor(() => app.board.visible && app.root.findDescendantById("tui-board-card-ENG-0") !== undefined);
      await setup.flush();
      const card = app.root.findDescendantById("tui-board-card-ENG-0");
      const sourceCards = app.root.findDescendantById("tui-board-cards-st-todo") as import("@opentui/core").ScrollBoxRenderable;
      sourceCards.scrollTop = sourceCards.scrollHeight;
      await setup.flush();
      const vertical = sourceCards.scrollTop;
      expect(vertical).toBeGreaterThan(0);
      await setup.waitFor(() => loads >= 2); await setup.flush();
      expect(app.root.findDescendantById("tui-board-card-ENG-0")).toBe(card);
      expect(sourceCards.scrollTop).toBe(vertical);
      expect(app.board.getSelectedIssue()?.identifier).toBe("ENG-0");
      expect(app.countText.plainText).not.toContain("Refreshing");
    } finally { setup.renderer.destroy(); }
  });

  test("a quiet tick aborted by a move clears in-flight so the next tick can run", async () => {
    const loads: Array<ReturnType<typeof deferred<TuiIssue[]>>> = [];
    const setup = await createTestRenderer({ width: 110, height: 30 });
    const app = currentApp = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => {
        const next = deferred<TuiIssue[]>();
        loads.push(next);
        return next.promise;
      }, async (id) => detailLoader(id)),
      appOptions({
        moveIssue: async () => { throw new Error("offline"); },
      }),
    );
    try {
      app.start();
      await setup.waitFor(() => loads.length === 1);
      loads[0]!.resolve([issues[0]!]);
      await setup.waitFor(() => app.list.options.length === 1); await setup.flush();
      const quiet = app.refresh({ quiet: true });
      await setup.waitFor(() => loads.length === 2);
      setup.mockInput.pressKey("k"); await setup.flush();
      await setup.mockInput.typeText("in progress"); setup.mockInput.pressEnter();
      await setup.waitFor(() => app.footer.plainText.includes("Could not move ENG-42"));
      loads[1]!.resolve([issues[0]!]);
      await quiet;
      const next = app.refresh({ quiet: true });
      await setup.waitFor(() => loads.length === 3);
      loads[2]!.resolve([issues[0]!]);
      await next;
      expect(loads).toHaveLength(3);
    } finally { setup.renderer.destroy(); }
  });

  test("an older refresh does not clear a newer overlapping manual refresh", async () => {
    const loads: Array<ReturnType<typeof deferred<TuiIssue[]>>> = [];
    const setup = await createTestRenderer({ width: 110, height: 30 });
    const app = currentApp = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => {
        const next = deferred<TuiIssue[]>();
        loads.push(next);
        return next.promise;
      }, async (id) => detailLoader(id)),
      appOptions(),
    );
    try {
      app.start();
      await setup.waitFor(() => loads.length === 1);
      loads[0]!.resolve([issues[0]!]);
      await setup.waitFor(() => app.list.options.length === 1); await setup.flush();
      const first = app.refresh();
      await setup.waitFor(() => loads.length === 2);
      const second = app.refresh();
      await setup.waitFor(() => loads.length === 3);
      loads[1]!.resolve([issues[0]!]);
      await first;
      await app.refresh({ quiet: true });
      expect(loads).toHaveLength(3);
      loads[2]!.resolve([{ ...issues[0]!, title: "After second" }]);
      await second;
      await setup.waitFor(() => app.list.getSelectedIssue()?.title === "After second");
      const quiet = app.refresh({ quiet: true });
      await setup.waitFor(() => loads.length === 4);
      loads[3]!.resolve([{ ...issues[0]!, title: "After second" }]);
      await quiet;
    } finally { setup.renderer.destroy(); }
  });

  test("quiet board refresh captures scroll after the fetch, not before", async () => {
    const loads: Array<ReturnType<typeof deferred<TuiIssue[]>>> = [];
    const rows = manyIssues(10);
    const setup = await createTestRenderer({ width: 140, height: 24 });
    const app = currentApp = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => {
        const next = deferred<TuiIssue[]>();
        loads.push(next);
        return next.promise;
      }, async (id) => detailLoader(id)),
      appOptions({ initialTeamId: "team-eng" }),
    );
    try {
      app.start();
      await setup.waitFor(() => loads.length === 1);
      loads[0]!.resolve(rows);
      await setup.waitFor(() => app.list.options.length === 10); await setup.flush();
      setup.mockInput.pressKey("b");
      await setup.waitFor(() => loads.length === 2);
      loads[1]!.resolve(rows);
      await setup.waitFor(() => app.board.visible && app.root.findDescendantById("tui-board-card-ENG-0") !== undefined);
      await setup.flush();
      const sourceCards = app.root.findDescendantById("tui-board-cards-st-todo") as import("@opentui/core").ScrollBoxRenderable;
      sourceCards.scrollTop = 1;
      await setup.flush();
      const before = sourceCards.scrollTop;
      const quiet = app.refresh({ quiet: true });
      await setup.waitFor(() => loads.length === 3);
      sourceCards.scrollTop = sourceCards.scrollHeight;
      await setup.flush();
      const during = sourceCards.scrollTop;
      expect(during).toBeGreaterThan(before);
      loads[2]!.resolve(rows);
      await quiet;
      await setup.flush();
      expect(sourceCards.scrollTop).toBe(during);
    } finally { setup.renderer.destroy(); }
  });
});

describe("TUI deferred scroll restore", () => {
  test("stale resize restores do not overwrite a newer generation", () => {
    let current = 1;
    const applied: number[] = [];
    const listeners: Array<() => void> = [];
    const content = { once: (_event: "resize", listener: () => void) => { listeners.push(listener); } };
    bindGenerationScrollRestore(content, 1, () => current, () => applied.push(1));
    current = 2;
    bindGenerationScrollRestore(content, 2, () => current, () => applied.push(2));
    for (const listener of listeners) listener();
    expect(applied).toEqual([2]);
  });

  test("list and board ignore a stale preserve-scroll resize", async () => {
    const setup = await createTestRenderer({ width: 90, height: 16 });
    try {
      const list = new IssueListRenderable(setup.renderer);
      setup.renderer.root.add(list);
      list.setIssues(manyIssues(12), "ENG-0");
      await setup.flush();
      list.scrollTop = 8;
      list.setIssues(manyIssues(12), "ENG-0", { preserveScroll: true });
      list.setIssues(manyIssues(12), "ENG-10");
      await setup.flush();
      const afterList = list.scrollTop;
      list.content.emit("resize");
      await setup.flush();
      expect(list.scrollTop).toBe(afterList);
      expect(list.getSelectedIssue()?.identifier).toBe("ENG-10");

      const board = new KanbanBoardRenderable(setup.renderer);
      setup.renderer.root.add(board);
      board.setBoard(meta.teams[0]!.states, manyIssues(10));
      await setup.flush();
      const cards = setup.renderer.root.findDescendantById("tui-board-cards-st-todo") as import("@opentui/core").ScrollBoxRenderable;
      board.restoreScrollState({ horizontal: 0, columns: { "st-todo": 99 } });
      board.setBoard(meta.teams[0]!.states, manyIssues(10));
      await setup.flush();
      const afterBoard = cards.scrollTop;
      cards.content.emit("resize");
      await setup.flush();
      expect(cards.scrollTop).toBe(afterBoard);
      expect(cards.scrollTop).not.toBe(99);
    } finally { setup.renderer.destroy(); }
  });
});

describe("TUI palette and select seams", () => {
  test("selectIdentifier scrolls the list and board to the named issue", async () => {
    const setup = await createTestRenderer({ width: 90, height: 16 });
    try {
      const list = new IssueListRenderable(setup.renderer);
      setup.renderer.root.add(list);
      list.setIssues(manyIssues(12), "ENG-0");
      await setup.flush();
      expect(list.selectIdentifier("missing")).toBe(false);
      expect(list.selectIdentifier("ENG-10")).toBe(true);
      expect(list.getSelectedIssue()?.identifier).toBe("ENG-10");
      expect(list.scrollTop).toBeGreaterThan(0);

      const board = new KanbanBoardRenderable(setup.renderer);
      setup.renderer.root.add(board);
      board.setBoard(meta.teams[0]!.states, manyIssues(4));
      await setup.flush();
      expect(board.selectIdentifier("ENG-3")).toBe(true);
      expect(board.getSelectedIssue()?.identifier).toBe("ENG-3");
    } finally { setup.renderer.destroy(); }
  });

  test("keyboard k searches loaded issues and opens the chosen list row", async () => {
    const setup = await createTestRenderer({ width: 110, height: 30 });
    const app = currentApp = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => issues, async (id) => detailLoader(id)),
      appOptions(),
    );
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 2); await setup.flush();
      expect(app.list.getSelectedIssue()?.identifier).toBe("ENG-42");
      setup.mockInput.pressKey("k"); await setup.flush();
      expect(actionNames(app)).toContain("Open in Linear");
      expect(actionNames(app)).toContain("APP-4  Rotate webhook secrets");
      const input = app.root.findDescendantById("tui-actions-search") as import("@opentui/core").InputRenderable;
      input.value = "";
      await setup.mockInput.typeText("webhook"); await setup.flush();
      expect(actionNames(app)).toEqual(["APP-4  Rotate webhook secrets"]);
      setup.mockInput.pressEnter(); await setup.flush();
      expect(app.root.findDescendantById("tui-actions")).toBeUndefined();
      expect(app.list.getSelectedIssue()?.identifier).toBe("APP-4");
      expect(app.detail.title).toContain("APP-4");
    } finally { setup.renderer.destroy(); }
  });

  test("palette issue pick from the board opens that card's detail", async () => {
    const setup = await createTestRenderer({ width: 140, height: 32 });
    const app = currentApp = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => issues, async (id) => detailLoader(id)),
      appOptions({ initialTeamId: "team-eng" }),
    );
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 2); await setup.flush();
      setup.mockInput.pressKey("b");
      await setup.waitFor(() => app.board.visible && app.root.findDescendantById("tui-board-card-ENG-42") !== undefined);
      await setup.flush();
      setup.mockInput.pressKey("k"); await setup.flush();
      expect(actionNames(app)).toContain("Move to In Progress");
      expect(actionNames(app)).toContain("APP-4  Rotate webhook secrets");
      await setup.mockInput.typeText("app-4"); await setup.flush();
      setup.mockInput.pressEnter();
      await setup.waitFor(() => app.detail.visible && !app.board.visible);
      expect(app.detail.title).toContain("APP-4");
      expect(app.board.getSelectedIssue()?.identifier).toBe("APP-4");
    } finally { setup.renderer.destroy(); }
  });

  test("palette exact identifier ranks the issue ahead of Copy in the list", async () => {
    const copied: string[] = [];
    const setup = await createTestRenderer({ width: 110, height: 30 });
    const app = currentApp = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => issues, async (id) => detailLoader(id)),
      appOptions({ copyToClipboard: (text) => { copied.push(text); return true; } }),
    );
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 2); await setup.flush();
      setup.mockInput.pressKey("k"); await setup.flush();
      const input = app.root.findDescendantById("tui-actions-search") as import("@opentui/core").InputRenderable;
      input.value = "";
      await setup.mockInput.typeText("ENG-42"); await setup.flush();
      expect(actionNames(app)[0]).toBe("ENG-42  Fix login redirect");
      expect(actionNames(app)).toContain("Copy ENG-42");
      setup.mockInput.pressEnter(); await setup.flush();
      expect(copied).toEqual([]);
      expect(app.list.getSelectedIssue()?.identifier).toBe("ENG-42");
      expect(app.detail.title).toContain("ENG-42");
    } finally { setup.renderer.destroy(); }
  });

  test("palette exact identifier ranks the issue ahead of Copy on the board", async () => {
    const copied: string[] = [];
    const setup = await createTestRenderer({ width: 140, height: 32 });
    const app = currentApp = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => issues, async (id) => detailLoader(id)),
      appOptions({
        initialTeamId: "team-eng",
        copyToClipboard: (text) => { copied.push(text); return true; },
      }),
    );
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 2); await setup.flush();
      setup.mockInput.pressKey("b");
      await setup.waitFor(() => app.board.visible && app.root.findDescendantById("tui-board-card-ENG-42") !== undefined);
      await setup.flush();
      setup.mockInput.pressKey("k"); await setup.flush();
      const input = app.root.findDescendantById("tui-actions-search") as import("@opentui/core").InputRenderable;
      input.value = "";
      await setup.mockInput.typeText("ENG-42"); await setup.flush();
      expect(actionNames(app)[0]).toBe("ENG-42  Fix login redirect");
      expect(actionNames(app)).toContain("Copy ENG-42");
      setup.mockInput.pressEnter();
      await setup.waitFor(() => app.detail.visible && !app.board.visible);
      expect(copied).toEqual([]);
      expect(app.detail.title).toContain("ENG-42");
      expect(app.board.getSelectedIssue()?.identifier).toBe("ENG-42");
    } finally { setup.renderer.destroy(); }
  });

  test("right-click stays contextual and still runs actions", async () => {
    const copied: string[] = [];
    const setup = await createTestRenderer({ width: 110, height: 30, useMouse: true });
    const app = currentApp = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => issues, async (id) => detailLoader(id)),
      appOptions({ copyToClipboard: (text) => { copied.push(text); return true; } }),
    );
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 2); await setup.flush();
      const second = app.root.findDescendantById("tui-issue-row-APP-4") as import("@opentui/core").BoxRenderable;
      await setup.mockMouse.click(second.screenX + 2, second.screenY, MouseButtons.RIGHT); await setup.flush();
      expect(actionNames(app)).toEqual(["Open in Linear", "Copy APP-4", "Copy URL", "Set priority", "Add comment"]);
      expect(actionNames(app).join(" ")).not.toContain("Fix login redirect");
      await setup.mockInput.typeText("copy app"); setup.mockInput.pressEnter(); await setup.flush();
      expect(copied).toEqual(["APP-4"]);
    } finally { setup.renderer.destroy(); }
  });

  test("palette and undo stay usable on a narrow terminal", async () => {
    const moves: string[] = [];
    const setup = await createTestRenderer({ width: 60, height: 28 });
    const app = currentApp = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => issues, async (id) => detailLoader(id)),
      appOptions({
        moveIssue: async (_issueId, stateId) => {
          moves.push(stateId);
          const state = meta.teams[0]!.states.find((item) => item.id === stateId)!;
          return { id: state.id, name: state.name, color: state.color ?? "", type: state.type as TuiIssue["state"]["type"] };
        },
      }),
    );
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 2); await setup.flush();
      expect(app.list.visible).toBe(true);
      setup.mockInput.pressKey("k"); await setup.flush();
      const modal = app.root.findDescendantById("tui-actions") as import("@opentui/core").BoxRenderable;
      expect(modal.width).toBeGreaterThan(40);
      expect(app.root.findDescendantById("tui-actions-search")?.focused).toBe(true);
      await setup.mockInput.typeText("in progress"); setup.mockInput.pressEnter();
      await setup.waitFor(() => app.footer.plainText.includes("u undo"));
      setup.mockInput.pressKey("u");
      await setup.waitFor(() => moves.includes("st-todo"));
      expect(moves).toEqual(["st-doing", "st-todo"]);
      setup.mockInput.pressKey("k"); await setup.flush();
      await setup.mockInput.typeText("webhook"); setup.mockInput.pressEnter();
      await setup.waitFor(() => app.detail.visible && (app.detail.title?.includes("APP-4") ?? false));
      expect(app.list.visible).toBe(false);
    } finally { setup.renderer.destroy(); }
  });
});
