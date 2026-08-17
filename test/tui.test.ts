import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { Meta } from "../src/cache.ts";
import { TuiApp, chipLabel, footerHint, layoutChipLabel, openChipLabel, visibleSelectOffset } from "../src/tui/app.ts";
import { KanbanBoardEvents, KanbanBoardRenderable, kanbanStates } from "../src/tui/board.ts";
import { isRemoteSession, issueOpenUrl, linearAppUrl, openCommand } from "../src/tui/open.ts";
import { groupIssuesByState, statusPresentation } from "../src/tui/issue-list.ts";
import { issueDetail, renderMermaidForWidth } from "../src/tui/markdown.ts";
import {
  loadTuiIssues, moveTuiIssue, TuiIssueStore, tuiIssueVariables, tuiStateFilter, TUI_SORTS,
  type TuiIssue, type TuiIssueQuery,
} from "../src/tui/data.ts";
import { runTui } from "../src/tui/run.ts";
import { GROK_NIGHT } from "../src/tui/theme.ts";
import { mock, sandbox, type Mock, type Sandbox } from "./harness.ts";

const issues: TuiIssue[] = [
  { id: "issue-eng-42", identifier: "ENG-42", title: "Fix login redirect", description: "Users bounce.", priority: 2,
    updatedAt: "2026-08-12T10:00:00Z", dueDate: null, url: "https://linear.app/x/ENG-42",
    state: { id: "st-doing", name: "In Progress", color: "#e0af68", type: "started" }, team: { key: "ENG", name: "Engineering" },
    project: { name: "Reliability" }, labels: { nodes: [{ name: "Bug" }] } },
  { id: "issue-app-4", identifier: "APP-4", title: "Rotate webhook secrets", description: null, priority: 3,
    updatedAt: "2026-08-11T10:00:00Z", url: "https://linear.app/x/APP-4",
    state: { id: "st-todo", name: "Todo", color: "#a8a8a8", type: "unstarted" }, team: { key: "APP", name: "Applications" }, project: null, labels: { nodes: [] } },
];

const meta: Meta = {
  fetchedAt: new Date().toISOString(), keyFingerprint: "x", workspace: { urlKey: "acme", name: "Acme" },
  teams: [
    { id: "team-eng", key: "ENG", name: "Engineering", states: [
      { id: "st-backlog", name: "Backlog", type: "backlog", position: 1 },
      { id: "st-todo", name: "Todo", type: "unstarted", position: 2 },
      { id: "st-doing", name: "In Progress", type: "started", position: 3 },
      { id: "st-done", name: "Done", type: "completed", position: 4 },
    ], labels: [] },
    { id: "team-app", key: "APP", name: "Applications", states: [], labels: [] },
  ],
  projects: [
    { id: "project-rel", slugId: "rel", name: "Reliability", state: "Active" },
    { id: "project-mobile", slugId: "mobile", name: "Mobile", state: "Active" },
  ],
  users: [], workspaceLabels: [], templates: [],
};
const baseQuery: TuiIssueQuery = { limit: 25, sort: "updated", view: "all" };
let box: Sandbox; let net: Mock;
beforeEach(() => { box = sandbox(); net = mock([{ match: "LinTuiIssues", data: { issues: { nodes: issues } } }]); });
afterEach(async () => { net.restore(); box.cleanup(); await Bun.sleep(25); });

function appOptions(onQuit?: () => void, extras: {
  remote?: boolean;
  openExternal?: (url: string) => Promise<void> | void;
  copyToClipboard?: (text: string) => boolean;
  moveIssue?: (issueId: string, stateId: string) => Promise<TuiIssue["state"]>;
} = {}) {
  return { limit: 25, meta, onQuit, remote: extras.remote ?? false, ...extras };
}

async function pressEscape(setup: Awaited<ReturnType<typeof createTestRenderer>>): Promise<void> {
  setup.mockInput.pressEscape();
  await Bun.sleep(40);
  await setup.flush();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("TUI issue data", () => {
  test("Mine/Open stay while team, project, and title compose", async () => {
    await loadTuiIssues({ limit: 25, teamId: "team-eng", projectId: "project-rel", title: " login ", sort: "created", view: "all" });
    expect(net.calls[0]?.document).toContain("state { id name color type }");
    expect(net.calls[0]?.variables).toEqual({
      first: 25,
      filter: {
        assignee: { isMe: { eq: true } }, state: { type: { nin: ["completed", "canceled"] } },
        team: { id: { eq: "team-eng" } }, project: { id: { eq: "project-rel" } },
        title: { containsIgnoreCase: "login" },
      },
      sort: [TUI_SORTS.created],
    });
  });

  test("board keeps Mine and filters out terminal canceled states", () => {
    const variables = tuiIssueVariables({ ...baseQuery, layout: "board", teamId: "team-eng" });
    expect(variables["filter"]).toEqual({
      assignee: { isMe: { eq: true } },
      state: { type: { nin: ["canceled", "duplicate"] } },
      team: { id: { eq: "team-eng" } },
    });
  });

  test("moves one board issue to a workflow state without retries", async () => {
    net.restore();
    net = mock([{ match: "LinTuiMoveIssue", data: {
      issueUpdate: { issue: { id: "issue-eng-42", identifier: "ENG-42", state: {
        id: "st-done", name: "Done", color: "#9ece6a", type: "completed",
      } } },
    } }]);
    await expect(moveTuiIssue("issue-eng-42", "st-done")).resolves.toEqual({
      id: "st-done", name: "Done", color: "#9ece6a", type: "completed",
    });
    expect(net.calls[0]?.variables).toEqual({ id: "issue-eng-42", stateId: "st-done" });
  });

  test("board moves do not retry a failed write", async () => {
    net.restore();
    net = mock([
      { match: "LinTuiMoveIssue", networkError: "offline" },
      { match: "LinTuiMoveIssue", data: { issueUpdate: { issue: { state: {
        id: "st-done", name: "Done", color: "#9ece6a", type: "completed",
      } } } } },
    ]);
    await expect(moveTuiIssue("issue-eng-42", "st-done")).rejects.toThrow("offline");
    expect(net.calls).toHaveLength(1);
  });

  test("whitespace title is omitted and all three sort shapes are exact", () => {
    for (const sort of ["updated", "created", "priority"] as const) {
      const variables = tuiIssueVariables({ ...baseQuery, title: "  ", sort });
      expect((variables["filter"] as Record<string, unknown>)["title"]).toBeUndefined();
      expect(variables["sort"]).toEqual([TUI_SORTS[sort]]);
    }
    expect(TUI_SORTS).toEqual({
      updated: { updatedAt: { order: "Descending" } },
      created: { createdAt: { order: "Descending" } },
      priority: { priority: { order: "Ascending" } },
    });
  });
});

describe("Linear status presentation", () => {
  test("maps every workflow category to one single-cell Material Design icon", () => {
    const glyphs = ["triage", "backlog", "unstarted", "started", "completed", "canceled", "duplicate"].map(
      (type) => statusPresentation(type as import("../src/tui/data.ts").TuiWorkflowStateType).glyph,
    );
    expect(glyphs.map((glyph) => glyph.codePointAt(0))).toEqual([
      0xF1853, 0xF0E95, 0xF0766, 0xF1396, 0xF05E0, 0xF0159, 0xF0159,
    ]);
    expect(glyphs.every((glyph) => [...glyph].length === 1 && Bun.stringWidth(glyph) === 1)).toBe(true);
  });

  test("groups by Linear state name and preserves server sort inside each group", () => {
    const input: TuiIssue[] = [
      { ...issues[1]!, identifier: "APP-1" },
      { ...issues[0]!, identifier: "ENG-2", state: { id: "st-review", name: "In Review", color: "#e0af68", type: "started" } },
      { ...issues[0]!, identifier: "ENG-3" },
      { ...issues[0]!, identifier: "ENG-4", state: { id: "st-review", name: "In Review", color: "#e0af68", type: "started" } },
    ];
    expect(groupIssuesByState(input).map((group) => ({
      name: group.name, type: group.type, ids: group.issues.map((issue) => issue.identifier),
    }))).toEqual([
      { name: "In Progress", type: "started", ids: ["ENG-3"] },
      { name: "In Review", type: "started", ids: ["ENG-2", "ENG-4"] },
      { name: "Todo", type: "unstarted", ids: ["APP-1"] },
    ]);
  });

  test("view filters map onto Linear workflow types", () => {
    expect(tuiStateFilter("all")).toEqual({ type: { nin: ["completed", "canceled"] } });
    expect(tuiStateFilter("started")).toEqual({ type: { eq: "started" } });
    expect(tuiStateFilter("unstarted")).toEqual({ type: { in: ["unstarted", "backlog", "triage"] } });
    expect(tuiStateFilter("completed")).toEqual({ type: { eq: "completed" } });
  });
});

describe("Grok Night", () => {
  test("uses the exact shared core palette", () => {
    expect(GROK_NIGHT).toEqual({
      base: "#0a0a0a", panel: "#141414", surface0: "#242424", surface1: "#2e2e33",
      surface2: "#363636", border: "#505058", muted: "#6c6c6c", secondary: "#a8a8a8",
      text: "#e1e1e1", accent: "#c8c8c8", lavender: "#8b9cb3", mauve: "#bb9af7", red: "#f7768e",
      green: "#9ece6a", yellow: "#e0af68", blue: "#7aa2f7", teal: "#1abc9c",
      peach: "#ff9e64",
    });
  });

  test("the TUI canvas and header controls are transparent with one row above them", async () => {
    const setup = await createTestRenderer({ width: 110, height: 30 });
    const app = new TuiApp(setup.renderer, new TuiIssueStore(async () => issues), appOptions());
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 2); await setup.flush();
      expect(app.root.backgroundColor.a).toBe(0);
      expect(app.header.backgroundColor.a).toBe(0);
      const tabs = app.root.findDescendantById("tui-tabs") as import("@opentui/core").BoxRenderable;
      expect(tabs.backgroundColor.a).toBe(0);
      expect(app.viewTabs.started.backgroundColor.a).toBe(0);
      expect(app.teamChip.backgroundColor.a).toBe(0);
      expect(app.projectChip.backgroundColor.a).toBe(0);
      expect(app.sortChip.backgroundColor.a).toBe(0);
      expect(app.openChip.backgroundColor.a).toBe(0);
      expect(app.header.screenY).toBe(app.root.screenY + 1);
      expect(app.list.backgroundColor.a).toBe(0);
      expect(app.detail.backgroundColor.a).toBe(0);
    } finally { app.quit(); setup.renderer.destroy(); }
  });
});

describe("issue detail markdown", () => {
  test("shapes the selected issue as markdown with a raw description body", () => {
    const rendered = issueDetail(issues[0]);
    expect(rendered).toContain("# Fix login redirect");
    expect(rendered).toContain("**ENG-42**");
    expect(rendered).toContain("Users bounce.");
    expect(rendered).not.toContain("https://linear.app/x/ENG-42");
    expect(issueDetail(issues[1])).toContain("*No description.*");
    expect(issueDetail(undefined)).toBe("Select an issue to view its details.");
  });

  test("renders mermaid as unicode boxes and rejects invalid source", () => {
    const ascii = renderMermaidForWidth("graph LR\n  A --> B", 80);
    expect(ascii).toContain("A");
    expect(ascii).toContain("B");
    expect(ascii).toMatch(/[┌─┐│└┘►]/);
    expect(() => renderMermaidForWidth("not a diagram", 80)).toThrow();
  });
});

describe("filters, search, mouse, and focus", () => {
  test("keyboard opens searchable Team picker and commits without widening Mine/Open", async () => {
    const setup = await createTestRenderer({ width: 110, height: 30, useMouse: true });
    const queries: TuiIssueQuery[] = [];
    const app = new TuiApp(setup.renderer, new TuiIssueStore(async (query) => { queries.push(query); return issues; }), appOptions());
    try {
      app.start(); await setup.waitFor(() => queries.length === 1);
      setup.mockInput.pressKey("t"); await setup.flush();
      expect(app.root.findDescendantById("tui-picker")).toBeDefined();
      await setup.mockInput.typeText("app"); await setup.flush();
      const picker = app.root.findDescendantById("tui-picker-list") as import("@opentui/core").SelectRenderable;
      expect(picker.options.map((option) => option.name)).toEqual(["APP  Applications"]);
      picker.focus(); setup.mockInput.pressEnter();
      await setup.waitFor(() => queries.length === 2);
      expect(queries[1]?.teamId).toBe("team-app");
      expect(app.teamText.plainText).toContain("APP");
      expect(app.teamText.plainText).toContain("Team");
    } finally { app.quit(); setup.renderer.destroy(); }
  });

  test("mouse clicks Project and Sort chips and rows", async () => {
    const setup = await createTestRenderer({ width: 110, height: 30, useMouse: true });
    const queries: TuiIssueQuery[] = [];
    const app = new TuiApp(setup.renderer, new TuiIssueStore(async (query) => { queries.push(query); return issues; }), appOptions());
    try {
      app.start(); await setup.waitFor(() => queries.length === 1); await setup.flush();
      await setup.mockMouse.click(app.projectChip.screenX + 2, app.projectChip.screenY); await setup.flush();
      let picker = app.root.findDescendantById("tui-picker-list") as import("@opentui/core").SelectRenderable;
      await setup.mockMouse.click(picker.screenX + 2, picker.screenY + 1); // Reliability, after All
      await setup.waitFor(() => queries.length === 2);
      expect(queries[1]?.projectId).toBe("project-rel");
      await setup.mockMouse.click(app.sortChip.screenX + 2, app.sortChip.screenY); await setup.flush();
      picker = app.root.findDescendantById("tui-picker-list") as import("@opentui/core").SelectRenderable;
      await setup.mockMouse.click(picker.screenX + 2, picker.screenY + 2); // Priority
      await setup.waitFor(() => queries.length === 3);
      expect(queries[2]?.sort).toBe("priority");
    } finally { app.quit(); setup.renderer.destroy(); }
  });

  test("picker input focuses on click and Escape restores detail after a mouse-opened chip", async () => {
    const setup = await createTestRenderer({ width: 110, height: 30, useMouse: true });
    const app = new TuiApp(setup.renderer, new TuiIssueStore(async () => issues), appOptions());
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 2); await setup.flush();
      app.detail.focus();
      expect(app.detail.focused).toBe(true);
      await setup.mockMouse.click(app.teamChip.screenX + 2, app.teamChip.screenY); await setup.flush();
      const input = app.root.findDescendantById("tui-picker-search") as import("@opentui/core").InputRenderable;
      const picker = app.root.findDescendantById("tui-picker-list") as import("@opentui/core").SelectRenderable & { selectionFill: string };
      picker.focus(); expect(picker.selectionFill).toBe(GROK_NIGHT.surface2);
      await setup.mockMouse.click(input.screenX + 2, input.screenY); expect(input.focused).toBe(true);
      expect(picker.selectionFill).toBe(GROK_NIGHT.surface1);
      app.closePicker(); await Promise.resolve(); expect(app.detail.focused).toBe(true);
    } finally { app.quit(); setup.renderer.destroy(); }
  });

  test("search submits server-side and q/r type normally while focused", async () => {
    const setup = await createTestRenderer({ width: 110, height: 30 });
    const queries: TuiIssueQuery[] = []; let quits = 0;
    const app = new TuiApp(setup.renderer, new TuiIssueStore(async (query) => { queries.push(query); return issues; }), appOptions(() => { quits += 1; }));
    try {
      app.start(); await setup.waitFor(() => queries.length === 1);
      setup.mockInput.pressKey("/"); await setup.mockInput.typeText("qr");
      expect(app.search.value).toBe("qr"); expect(quits).toBe(0); expect(queries.length).toBe(1);
      setup.mockInput.pressEnter(); await setup.waitFor(() => queries.length === 2);
      expect(queries[1]?.title).toBe("qr"); expect(app.list.focused).toBe(true);
      expect(app.searchStatus.plainText).toContain("/qr");
      setup.mockInput.pressKey("/"); await setup.flush(); expect(app.search.focused).toBe(true);
      await setup.mockInput.typeText(" changed");
      app.search.handleKeyPress({ name: "escape" } as import("@opentui/core").KeyEvent);
      expect(app.list.focused).toBe(true);
      expect(app.search.value).toBe("qr");
      expect(queries).toHaveLength(2);
    } finally { app.quit(); setup.renderer.destroy(); }
  });

  test("scrolled issue clicks use the visible window instead of row zero", async () => {
    const many = Array.from({ length: 20 }, (_, index): TuiIssue => ({
      ...issues[0]!, identifier: `ENG-${index + 1}`, title: `Issue ${index + 1}`,
    }));
    const setup = await createTestRenderer({ width: 100, height: 18, useMouse: true });
    const app = new TuiApp(setup.renderer, new TuiIssueStore(async () => many), appOptions());
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === many.length); await setup.flush();
      app.list.setSelectedIndex(15); await setup.flush();
      const visibleIndex = many.findIndex((issue) => {
        const row = app.list.findDescendantById(`tui-issue-row-${issue.identifier}`) as import("@opentui/core").Renderable;
        return row.screenY > app.list.screenY && row.screenY < app.list.screenY + app.list.height - 1;
      });
      const visibleRow = app.list.findDescendantById(`tui-issue-row-${many[visibleIndex]!.identifier}`) as import("@opentui/core").Renderable;
      await setup.mockMouse.click(visibleRow.screenX + 2, visibleRow.screenY);
      expect(app.list.getSelectedIndex()).toBe(visibleIndex);
      expect(app.list.getSelectedIndex()).toBeGreaterThan(0);
    } finally { app.quit(); setup.renderer.destroy(); }
  });

  test("scrolled picker clicks commit the visible option", async () => {
    const teams = Array.from({ length: 20 }, (_, index) => ({
      id: `team-${index}`, key: `T${index}`, name: `Team ${index}`, states: [], labels: [],
    }));
    const setup = await createTestRenderer({ width: 100, height: 18, useMouse: true });
    const queries: TuiIssueQuery[] = [];
    const app = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async (query) => { queries.push(query); return issues; }),
      { ...appOptions(), meta: { ...meta, teams } },
    );
    try {
      app.start(); await setup.waitFor(() => queries.length === 1); app.openPicker("team"); await setup.flush();
      const picker = app.root.findDescendantById("tui-picker-list") as import("@opentui/core").SelectRenderable;
      picker.setSelectedIndex(15); await setup.flush();
      const offset = visibleSelectOffset(15, picker.options.length, picker.height, 1);
      const expectedId = (picker.options[offset]?.value as { id: string }).id;
      await setup.mockMouse.click(picker.screenX + 2, picker.screenY);
      await setup.waitFor(() => queries.length === 2);
      expect(queries[1]?.teamId).toBe(expectedId);
      expect(queries[1]?.teamId).not.toBeUndefined();
    } finally { app.quit(); setup.renderer.destroy(); }
  });

  test("numbered view tabs refetch and invert the active tab", async () => {
    const setup = await createTestRenderer({ width: 110, height: 30, useMouse: true });
    const queries: TuiIssueQuery[] = [];
    const app = new TuiApp(setup.renderer, new TuiIssueStore(async (query) => { queries.push(query); return issues; }), appOptions());
    try {
      app.start(); await setup.waitFor(() => queries.length === 1); await setup.flush();
      expect(app.viewTabs.all.backgroundColor.equals(RGBA.fromHex(GROK_NIGHT.accent))).toBe(true);
      setup.mockInput.pressKey("2");
      await setup.waitFor(() => queries.length === 2);
      expect(queries[1]?.view).toBe("started");
      expect(app.viewTabs.started.backgroundColor.equals(RGBA.fromHex(GROK_NIGHT.accent))).toBe(true);
      expect(app.viewTabs.all.backgroundColor.a).toBe(0);
      await setup.mockMouse.click(app.viewTabs.completed.screenX + 1, app.viewTabs.completed.screenY);
      await setup.waitFor(() => queries.length === 3);
      expect(queries[2]?.view).toBe("completed");
    } finally { app.quit(); setup.renderer.destroy(); }
  });

  test("PageUp and PageDown act on the focused pane", async () => {
    const many = Array.from({ length: 20 }, (_, index): TuiIssue => ({
      ...issues[0]!, identifier: `ENG-${index + 1}`, title: `Issue ${index + 1}`,
    }));
    const setup = await createTestRenderer({ width: 100, height: 18 });
    const app = new TuiApp(setup.renderer, new TuiIssueStore(async () => many), appOptions());
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === many.length);
      setup.mockInput.pressKey("\x1b[6~");
      expect(app.list.getSelectedIndex()).toBeGreaterThan(0);
      const afterPageDown = app.list.getSelectedIndex();
      setup.mockInput.pressKey("\x1b[5~");
      expect(app.list.getSelectedIndex()).toBeLessThan(afterPageDown);
      app.detail.focus();
      const selected = app.list.getSelectedIndex();
      setup.mockInput.pressKey("\x1b[6~");
      expect(app.list.getSelectedIndex()).toBe(selected);
    } finally { app.quit(); setup.renderer.destroy(); }
  });

  test("Tab and pane clicks switch focus; list wheel scrolls without changing the open issue", async () => {
    const many = Array.from({ length: 20 }, (_, index): TuiIssue => ({
      ...issues[0]!, identifier: `ENG-${index + 1}`, title: `Issue ${index + 1}`,
    }));
    const setup = await createTestRenderer({ width: 110, height: 18, useMouse: true });
    const app = new TuiApp(setup.renderer, new TuiIssueStore(async () => many), appOptions());
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === many.length); await setup.flush();
      expect(app.list.focused).toBe(true);
      setup.mockInput.pressTab(); expect(app.detail.focused).toBe(true);
      await setup.mockMouse.click(app.list.screenX + 2, app.list.screenY + 1); expect(app.list.focused).toBe(true);
      const selected = app.list.getSelectedIndex();
      const detailTop = app.detail.scrollTop;
      const listTop = app.list.scrollTop;
      const openId = app.detail.title;
      await setup.mockMouse.scroll(app.list.screenX + 2, app.list.screenY + 1, "down");
      await setup.flush();
      expect(app.list.getSelectedIndex()).toBe(selected);
      expect(app.detail.title).toBe(openId);
      expect(app.detail.scrollTop).toBe(detailTop);
      expect(app.list.scrollTop).toBeGreaterThan(listTop);
      await setup.mockMouse.click(app.detail.screenX + 2, app.detail.screenY + 2); expect(app.detail.focused).toBe(true);
      await pressEscape(setup); expect(app.list.focused).toBe(true);
    } finally { app.quit(); setup.renderer.destroy(); }
  });

  test("j/k moves the highlight; click or Enter opens that issue", async () => {
    const setup = await createTestRenderer({ width: 110, height: 30, useMouse: true });
    const app = new TuiApp(setup.renderer, new TuiIssueStore(async () => issues), appOptions());
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 2); await setup.flush();
      expect(app.detail.title).toBe("https://linear.app/x/ENG-42");
      setup.mockInput.pressKey("j"); await setup.flush();
      expect(app.list.getSelectedIndex()).toBe(1);
      expect(app.detail.title).toBe("https://linear.app/x/ENG-42");
      const second = app.list.findDescendantById("tui-issue-row-APP-4") as import("@opentui/core").Renderable;
      await setup.mockMouse.click(second.screenX + 2, second.screenY);
      await setup.flush();
      expect(app.detail.title).toBe("https://linear.app/x/APP-4");
      expect(app.list.visible).toBe(true);
      setup.mockInput.pressKey("k"); await setup.flush();
      expect(app.list.getSelectedIndex()).toBe(0);
      expect(app.detail.title).toBe("https://linear.app/x/APP-4");
      setup.mockInput.pressEnter();
      await setup.waitFor(() => !app.list.visible && app.detail.visible && app.detail.focused);
      expect(app.detail.title).toBe("https://linear.app/x/ENG-42");
    } finally { app.quit(); setup.renderer.destroy(); }
  });
});

describe("mouse-first Kanban board", () => {
  test("columns follow workflow progression, omit terminal states, and append live states missing from cache", () => {
    const cached = [
      { id: "backlog", name: "Backlog", type: "backlog", position: 0 },
      { id: "planned", name: "Planned", type: "unstarted", position: 1 },
      { id: "progress", name: "In Progress", type: "started", position: 2 },
      { id: "done", name: "Done", type: "completed", position: 3 },
      { id: "canceled", name: "Canceled", type: "canceled", position: 4 },
      { id: "duplicate", name: "Duplicate", type: "duplicate", position: 5 },
      { id: "review", name: "In Review", type: "started", position: 1002 },
      { id: "unknown", name: "Unknown", type: "unknown", position: 1 },
    ];
    const liveIssues = [
      { ...issues[0]!, id: "blocked-issue", state: { id: "blocked", name: "Blocked", color: "#fff", type: "started" as const } },
      { ...issues[0]!, id: "canceled-issue", state: { id: "live-canceled", name: "Canceled", color: "#fff", type: "canceled" as const } },
    ];
    expect(kanbanStates(cached, liveIssues).map((state) => state.id)).toEqual([
      "backlog", "planned", "progress", "review", "blocked", "done",
    ]);
  });

  test("cards are compact and transparent, and scrollbars render only their thumb", async () => {
    const setup = await createTestRenderer({ width: 90, height: 24 });
    const board = new KanbanBoardRenderable(setup.renderer);
    setup.renderer.root.add(board);
    board.setBoard(meta.teams[0]!.states, [
      issues[0]!,
      { ...issues[0]!, id: "issue-eng-43", identifier: "ENG-43", title: "Second issue" },
    ]);
    await setup.flush();
    const first = board.findDescendantById("tui-board-card-ENG-42") as import("@opentui/core").BoxRenderable;
    const second = board.findDescendantById("tui-board-card-ENG-43") as import("@opentui/core").BoxRenderable;
    const cards = board.findDescendantById("tui-board-cards-st-doing") as import("@opentui/core").ScrollBoxRenderable;
    expect(first.height).toBe(2);
    expect(first.backgroundColor.a).toBe(0);
    expect(second.screenY - first.screenY).toBe(2);
    expect(cards.verticalScrollBar.slider.backgroundColor.a).toBe(0);
    expect(board.horizontalScrollBar.slider.backgroundColor.a).toBe(0);
    setup.renderer.destroy();
  });

  test("Board is clickable, requires a team, and keeps Team available", async () => {
    const setup = await createTestRenderer({ width: 110, height: 30, useMouse: true });
    const queries: TuiIssueQuery[] = [];
    const app = new TuiApp(setup.renderer, new TuiIssueStore(async (query) => { queries.push(query); return issues; }), appOptions());
    try {
      app.start(); await setup.waitFor(() => queries.length === 1); await setup.flush();
      expect(layoutChipLabel("list", false)).toBe("Board view");
      await setup.mockMouse.click(app.layoutChip.screenX + 1, app.layoutChip.screenY);
      await setup.flush();
      expect(app.board.visible).toBe(true);
      expect(app.teamChip.visible).toBe(true);
      expect(app.root.findDescendantById("tui-board-empty") as import("@opentui/core").TextRenderable | undefined).toBeDefined();
      expect(setup.captureCharFrame()).toContain("Choose a team to use Board");
      expect(queries).toHaveLength(1);
    } finally { app.quit(); setup.renderer.destroy(); }
  });

  test("switching teams clears stale cards before a failed refresh settles", async () => {
    const setup = await createTestRenderer({ width: 110, height: 30, useMouse: true });
    const failed = deferred<TuiIssue[]>();
    let loads = 0;
    const appMeta: Meta = {
      ...meta,
      teams: meta.teams.map((team) => team.id === "team-app" ? {
        ...team,
        states: [{ id: "app-todo", name: "Todo", type: "unstarted", position: 1 }],
      } : team),
    };
    const app = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => ++loads < 3 ? [issues[0]!] : failed.promise),
      { ...appOptions(), meta: appMeta, initialTeamId: "team-eng" },
    );
    try {
      app.start(); await setup.waitFor(() => loads === 1); await setup.flush();
      await setup.mockMouse.click(app.layoutChip.screenX + 1, app.layoutChip.screenY);
      await setup.waitFor(() => loads === 2 && app.root.findDescendantById("tui-board-card-ENG-42") !== undefined);
      app.openPicker("team");
      const picker = app.root.findDescendantById("tui-picker-list") as import("@opentui/core").SelectRenderable;
      picker.setSelectedIndex(2); picker.selectCurrent();
      await setup.waitFor(() => loads === 3); await setup.flush();
      expect(app.root.findDescendantById("tui-board-card-ENG-42")).toBeUndefined();
      expect(app.root.findDescendantById("tui-board-column-app-todo")).toBeDefined();
      failed.reject(new Error("refresh failed"));
      await setup.waitFor(() => app.footer.plainText.includes("Could not refresh")); await setup.flush();
      expect(app.root.findDescendantById("tui-board-card-ENG-42")).toBeUndefined();
    } finally { app.quit(); setup.renderer.destroy(); }
  });

  test("Board Tab keeps focus on the board until detail is open", async () => {
    const setup = await createTestRenderer({ width: 110, height: 30 });
    const app = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => [issues[0]!]),
      { ...appOptions(), initialTeamId: "team-eng" },
    );
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 1); await setup.flush();
      setup.mockInput.pressKey("b");
      await setup.waitFor(() => app.board.visible && app.root.findDescendantById("tui-board-card-ENG-42") !== undefined);
      setup.mockInput.pressTab(); await setup.flush();
      expect(app.board.focused).toBe(true);
      expect(app.detail.visible).toBe(false);
    } finally { app.quit(); setup.renderer.destroy(); }
  });

  test("rebuilding the board clears an armed drag", async () => {
    const setup = await createTestRenderer({ width: 140, height: 30, useMouse: true });
    const board = new KanbanBoardRenderable(setup.renderer);
    setup.renderer.root.add(board);
    board.setBoard(meta.teams[0]!.states, [issues[0]!]);
    const drops: unknown[] = [];
    board.on(KanbanBoardEvents.ISSUE_DROPPED, (drop) => drops.push(drop));
    await setup.flush();
    const card = board.findDescendantById("tui-board-card-ENG-42") as import("@opentui/core").BoxRenderable;
    const done = board.findDescendantById("tui-board-column-st-done") as import("@opentui/core").BoxRenderable;
    await setup.mockMouse.pressDown(card.screenX + 2, card.screenY + 1);
    await setup.mockMouse.moveTo(card.screenX + 3, card.screenY + 1);
    await setup.mockMouse.moveTo(done.screenX + 2, done.screenY + 2);
    expect(done.borderColor.equals(RGBA.fromHex(GROK_NIGHT.blue))).toBe(true);
    board.setBoard(meta.teams[0]!.states, [issues[0]!]); await setup.flush();
    const rebuiltDone = board.findDescendantById("tui-board-column-st-done") as import("@opentui/core").BoxRenderable;
    expect(rebuiltDone.borderColor.equals(RGBA.fromHex(GROK_NIGHT.border))).toBe(true);
    await setup.mockMouse.release(rebuiltDone.screenX + 2, rebuiltDone.screenY + 2); await setup.flush();
    expect(drops).toHaveLength(0);
    setup.renderer.destroy();
  });

  test("dragging at the horizontal edge scrolls toward offscreen columns", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24, useMouse: true });
    const states = Array.from({ length: 7 }, (_, index) => ({
      id: `state-${index}`, name: `State ${index}`, type: index === 0 ? "unstarted" : "started", position: index,
    }));
    const board = new KanbanBoardRenderable(setup.renderer);
    setup.renderer.root.add(board);
    board.setBoard(states, [{ ...issues[0]!, state: { ...issues[0]!.state, id: "state-0" } }]);
    await setup.flush();
    const card = board.findDescendantById("tui-board-card-ENG-42") as import("@opentui/core").BoxRenderable;
    await setup.mockMouse.pressDown(card.screenX + 2, card.screenY + 1);
    await setup.mockMouse.moveTo(card.screenX + 3, card.screenY + 1);
    await setup.mockMouse.moveTo(board.viewport.screenX + board.viewport.width - 1, card.screenY + 1);
    await setup.renderOnce();
    expect(board.scrollLeft).toBeGreaterThan(0);
    expect(board.live).toBe(true);
    board.setMoving("ENG-42");
    await setup.mockMouse.release(board.viewport.screenX + board.viewport.width - 1, card.screenY + 1);
    await setup.flush();
    expect(board.live).toBe(false);
    setup.renderer.destroy();
  });

  test("keyboard selection scrolls both the card list and horizontal board", async () => {
    const setup = await createTestRenderer({ width: 70, height: 16 });
    const states = Array.from({ length: 5 }, (_, index) => ({
      id: `state-${index}`, name: `State ${index}`, type: index === 0 ? "unstarted" : "started", position: index,
    }));
    const firstColumn = Array.from({ length: 12 }, (_, index): TuiIssue => ({
      ...issues[0]!, id: `issue-${index}`, identifier: `ENG-${index}`, state: { ...issues[0]!.state, id: "state-0" },
    }));
    const farIssue: TuiIssue = {
      ...issues[0]!, id: "far-issue", identifier: "ENG-FAR", state: { ...issues[0]!.state, id: "state-4" },
    };
    const board = new KanbanBoardRenderable(setup.renderer);
    setup.renderer.root.add(board);
    board.setBoard(states, [...firstColumn, farIssue]); board.focus(); await setup.flush();
    for (let index = 0; index < 9; index += 1) board.handleKeyPress({ name: "down" } as import("@opentui/core").KeyEvent);
    await setup.flush();
    const cards = board.findDescendantById("tui-board-cards-state-0") as import("@opentui/core").ScrollBoxRenderable;
    expect(cards.scrollTop).toBeGreaterThan(0);
    board.handleKeyPress({ name: "right" } as import("@opentui/core").KeyEvent); await setup.flush();
    expect(board.getSelectedIssue()?.identifier).toBe("ENG-FAR");
    expect(board.scrollLeft).toBeGreaterThan(0);
    setup.renderer.destroy();
  });

  test("click opens detail, while drag moves to a different column optimistically", async () => {
    const setup = await createTestRenderer({ width: 140, height: 32, useMouse: true });
    const queries: TuiIssueQuery[] = [];
    const move = deferred<TuiIssue["state"]>();
    const moves: { issueId: string; stateId: string }[] = [];
    const app = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async (query) => { queries.push(query); return [issues[0]!]; }),
      { ...appOptions(), initialTeamId: "team-eng", moveIssue: (issueId, stateId) => {
        moves.push({ issueId, stateId }); return move.promise;
      } },
    );
    try {
      app.start(); await setup.waitFor(() => queries.length === 1); await setup.flush();
      await setup.mockMouse.click(app.layoutChip.screenX + 1, app.layoutChip.screenY);
      await setup.waitFor(() => queries.length === 2 && app.board.visible); await setup.flush();
      expect(queries[1]?.layout).toBe("board");
      const backlog = app.root.findDescendantById("tui-board-column-st-backlog") as import("@opentui/core").BoxRenderable;
      const todoColumn = app.root.findDescendantById("tui-board-column-st-todo") as import("@opentui/core").BoxRenderable;
      const doingColumn = app.root.findDescendantById("tui-board-column-st-doing") as import("@opentui/core").BoxRenderable;
      expect(backlog.screenX).toBeLessThan(todoColumn.screenX);
      expect(todoColumn.screenX).toBeLessThan(doingColumn.screenX);

      let card = app.root.findDescendantById("tui-board-card-ENG-42") as import("@opentui/core").BoxRenderable;
      await setup.mockMouse.click(card.screenX + 2, card.screenY + 1);
      await setup.waitFor(() => app.detail.visible && !app.board.visible);
      await pressEscape(setup);
      expect(app.board.visible).toBe(true);

      card = app.root.findDescendantById("tui-board-card-ENG-42") as import("@opentui/core").BoxRenderable;
      const done = app.root.findDescendantById("tui-board-column-st-done") as import("@opentui/core").BoxRenderable;
      const startX = card.screenX + 2; const startY = card.screenY + 1;
      await setup.mockMouse.pressDown(startX, startY);
      await setup.mockMouse.moveTo(startX + 1, startY);
      await setup.mockMouse.moveTo(done.screenX + 2, done.screenY + 2);
      expect(done.borderColor.equals(RGBA.fromHex(GROK_NIGHT.blue))).toBe(true);
      await setup.mockMouse.release(done.screenX + 2, done.screenY + 2);
      await setup.waitFor(() => moves.length === 1); await setup.flush();
      expect(moves).toEqual([{ issueId: "issue-eng-42", stateId: "st-done" }]);
      card = app.root.findDescendantById("tui-board-card-ENG-42") as import("@opentui/core").BoxRenderable;
      expect(card.screenX).toBeGreaterThanOrEqual(done.screenX);
      expect(app.footer.plainText).toContain("Moving ENG-42 to Done");
      const todo = app.root.findDescendantById("tui-board-column-st-todo") as import("@opentui/core").BoxRenderable;
      await setup.mockMouse.drag(card.screenX + 2, card.screenY + 1, todo.screenX + 2, todo.screenY + 2);
      await setup.flush();
      expect(moves).toHaveLength(1);
      const queryCount = queries.length;
      setup.mockInput.pressKey("r"); setup.mockInput.pressKey("b"); setup.mockInput.pressKey("t"); setup.mockInput.pressKey("/");
      await setup.flush();
      expect(queries).toHaveLength(queryCount);
      expect(app.board.visible).toBe(true);
      expect(app.root.findDescendantById("tui-picker")).toBeUndefined();
      expect(app.search.focused).toBe(false);

      move.resolve({ id: "st-done", name: "Done", color: "#9ece6a", type: "completed" });
      await setup.waitFor(() => app.footer.plainText.includes("ENG-42 moved to Done"));
    } finally { app.quit(); setup.renderer.destroy(); }
  });

  test("a move invalidates an older refresh result", async () => {
    const setup = await createTestRenderer({ width: 140, height: 30 });
    const staleRefresh = deferred<TuiIssue[]>();
    const move = deferred<TuiIssue["state"]>();
    let loads = 0;
    const store = new TuiIssueStore(async () => ++loads < 3 ? [issues[0]!] : staleRefresh.promise);
    const app = new TuiApp(
      setup.renderer,
      store,
      { ...appOptions(), initialTeamId: "team-eng", moveIssue: async () => move.promise },
    );
    try {
      app.start(); await setup.waitFor(() => loads === 1); await setup.flush();
      setup.mockInput.pressKey("b");
      await setup.waitFor(() => loads === 2 && app.root.findDescendantById("tui-board-card-ENG-42") !== undefined);
      const pendingRefresh = app.refresh();
      await setup.waitFor(() => loads === 3); await setup.flush();
      expect(app.root.findDescendantById("tui-board-card-ENG-42")).toBeUndefined();
      app.board.emit(KanbanBoardEvents.ISSUE_DROPPED, {
        issue: issues[0]!,
        state: { id: "st-done", name: "Done", type: "completed", position: 4 },
      });
      await setup.waitFor(() => app.footer.plainText.includes("Moving ENG-42"));
      move.resolve({ id: "st-done", name: "Done", color: "#9ece6a", type: "completed" });
      await setup.waitFor(() => app.footer.plainText.includes("ENG-42 moved to Done"));
      staleRefresh.resolve([issues[0]!]); await pendingRefresh; await setup.flush();
      expect(store.state.issues[0]?.state.id).toBe("st-done");
      const done = app.root.findDescendantById("tui-board-column-st-done") as import("@opentui/core").BoxRenderable;
      const card = app.root.findDescendantById("tui-board-card-ENG-42") as import("@opentui/core").BoxRenderable;
      expect(card.screenX).toBeGreaterThanOrEqual(done.screenX);
    } finally { app.quit(); setup.renderer.destroy(); }
  });

  test("same-column drops are no-ops and failed moves roll back", async () => {
    const setup = await createTestRenderer({ width: 140, height: 32, useMouse: true });
    const moves: { issueId: string; stateId: string }[] = [];
    const app = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => [issues[0]!]),
      { ...appOptions(), initialTeamId: "team-eng", moveIssue: async (issueId, stateId) => {
        moves.push({ issueId, stateId }); throw new Error("network down");
      } },
    );
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 1); await setup.flush();
      await setup.mockMouse.click(app.layoutChip.screenX + 1, app.layoutChip.screenY);
      await setup.waitFor(() => app.board.visible && app.root.findDescendantById("tui-board-card-ENG-42") !== undefined);
      await setup.flush();
      let card = app.root.findDescendantById("tui-board-card-ENG-42") as import("@opentui/core").BoxRenderable;
      const doing = app.root.findDescendantById("tui-board-column-st-doing") as import("@opentui/core").BoxRenderable;
      const done = app.root.findDescendantById("tui-board-column-st-done") as import("@opentui/core").BoxRenderable;

      await setup.mockMouse.pressDown(card.screenX + 2, card.screenY + 1);
      await setup.mockMouse.moveTo(card.screenX + 3, card.screenY + 1);
      await setup.mockMouse.moveTo(doing.screenX + 2, doing.screenY + 2);
      await setup.mockMouse.release(doing.screenX + 2, doing.screenY + 2);
      await setup.flush();
      expect(moves).toHaveLength(0);

      card = app.root.findDescendantById("tui-board-card-ENG-42") as import("@opentui/core").BoxRenderable;
      await setup.mockMouse.pressDown(card.screenX + 2, card.screenY + 1);
      await setup.mockMouse.moveTo(card.screenX + 3, card.screenY + 1);
      await setup.mockMouse.moveTo(done.screenX + 2, done.screenY + 2);
      await setup.mockMouse.release(done.screenX + 2, done.screenY + 2);
      await setup.waitFor(() => app.footer.plainText.includes("Could not move ENG-42")); await setup.flush();
      expect(moves).toEqual([{ issueId: "issue-eng-42", stateId: "st-done" }]);
      card = app.root.findDescendantById("tui-board-card-ENG-42") as import("@opentui/core").BoxRenderable;
      expect(card.screenX).toBeGreaterThanOrEqual(doing.screenX);
      expect(card.screenX).toBeLessThan(doing.screenX + doing.width);
    } finally { app.quit(); setup.renderer.destroy(); }
  });
});

describe("async continuity and lifecycle", () => {
  test("selection moved during refresh survives when the winning result lands", async () => {
    const setup = await createTestRenderer({ width: 100, height: 28 });
    const refresh = deferred<TuiIssue[]>(); let loads = 0;
    const app = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => ++loads === 1 ? issues : refresh.promise),
      appOptions(),
    );
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 2);
      const pending = app.refresh();
      app.list.setSelectedIndex(1);
      refresh.resolve(issues);
      await pending;
      expect(app.list.getSelectedOption()?.name).toContain("APP-4");
    } finally { app.quit(); setup.renderer.destroy(); }
  });

  test("a slow old result cannot overwrite a newer filter", async () => {
    const setup = await createTestRenderer({ width: 100, height: 28 });
    const first = deferred<TuiIssue[]>(); let loads = 0;
    const store = new TuiIssueStore(async () => ++loads === 1 ? first.promise : [issues[1]!]);
    const app = new TuiApp(setup.renderer, store, appOptions());
    try {
      app.start(); app.openPicker("team");
      const picker = app.root.findDescendantById("tui-picker-list") as import("@opentui/core").SelectRenderable;
      picker.setSelectedIndex(2); picker.selectCurrent();
      await setup.waitFor(() => app.list.options.length === 1);
      expect(app.list.getSelectedOption()?.name).toContain("APP-4");
      first.resolve([issues[0]!]); await Promise.resolve(); await setup.flush();
      expect(app.list.getSelectedOption()?.name).toContain("APP-4");
    } finally { app.quit(); setup.renderer.destroy(); }
  });

  test("q and Ctrl-C each exit while metadata is pending", async () => {
    for (const key of ["q", "ctrl-c"] as const) {
      const setup = await createTestRenderer({ width: 100, height: 28 });
      const pendingMeta = deferred<Meta>();
      const running = runTui({ limit: 25 }, {
        createRenderer: async () => setup.renderer, loadMetadata: async () => pendingMeta.promise,
        loadIssues: async () => issues,
      });
      await Promise.resolve();
      if (key === "q") setup.mockInput.pressKey("q");
      else setup.mockInput.pressCtrlC();
      await running;
      expect(setup.renderer.isDestroyed).toBe(true);
      pendingMeta.resolve(meta);
      await Promise.resolve();
    }
  });

  test("q exits while issues are pending and late completion is inert", async () => {
    const setup = await createTestRenderer({ width: 100, height: 28 });
    const pending = deferred<TuiIssue[]>();
    const running = runTui({ limit: 25 }, {
      createRenderer: async () => setup.renderer, loadMetadata: async () => meta,
      loadIssues: async () => pending.promise,
    });
    await setup.waitFor(() => setup.renderer.root.getRenderable("tui-root") !== undefined);
    setup.mockInput.pressKey("q"); await running; expect(setup.renderer.isDestroyed).toBe(true);
    pending.resolve(issues); await Promise.resolve();
  });

  test("a configured team missing from fresh metadata gets one refresh before failure", async () => {
    const setup = await createTestRenderer({ width: 100, height: 28 });
    let refreshes = 0;
    const noTeams = { ...meta, teams: [] };
    const running = runTui({ limit: 25, team: "ENG" }, {
      createRenderer: async () => setup.renderer,
      loadMetadata: async () => noTeams,
      refreshMetadata: async () => { refreshes += 1; return meta; },
      loadIssues: async () => issues,
    });
    await setup.waitFor(() => setup.renderer.root.getRenderable("tui-root") !== undefined);
    expect(refreshes).toBe(1);
    setup.mockInput.pressKey("q");
    await running;
  });

  test("Ctrl-C exits while issues are pending", async () => {
    const setup = await createTestRenderer({ width: 100, height: 28 });
    const running = runTui({ limit: 25 }, {
      createRenderer: async () => setup.renderer, loadMetadata: async () => meta,
      loadIssues: async () => new Promise<TuiIssue[]>(() => {}),
    });
    await setup.waitFor(() => setup.renderer.root.getRenderable("tui-root") !== undefined);
    setup.mockInput.pressCtrlC(); await running;
    expect(setup.renderer.isDestroyed).toBe(true);
  });
});

describe("responsive controls", () => {
  test("Enter opens an issue and Escape returns to the list", async () => {
    const setup = await createTestRenderer({ width: 110, height: 30 });
    const app = new TuiApp(setup.renderer, new TuiIssueStore(async () => issues), appOptions());
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 2); await setup.flush();
      expect(app.list.visible).toBe(true); expect(app.detail.visible).toBe(true);
      expect(app.list.focused).toBe(true);
      expect(app.footer.plainText).toContain("/ search");
      expect(app.footer.plainText).toContain("q quit");

      setup.mockInput.pressEnter();
      await setup.waitFor(() => !app.list.visible && app.detail.visible && app.detail.focused);
      await setup.flush();
      let frame = await setup.waitForFrame((value) => value.includes("Users bounce.") && !value.includes("IN PROGRESS · 1"));
      expect(frame).toContain("Users bounce."); expect(frame).not.toContain("IN PROGRESS · 1");
      expect(frame).not.toContain("z show");
      expect(app.footer.plainText).toContain("esc back");

      await pressEscape(setup);
      await setup.waitFor(() => app.list.visible && app.detail.visible && app.list.focused);
      frame = await setup.waitForFrame((value) => value.includes("IN PROGRESS · 1") && value.includes("Users bounce."));
    } finally { app.quit(); setup.renderer.destroy(); }
  });

  test("Escape from the list does not quit", async () => {
    const setup = await createTestRenderer({ width: 110, height: 30 });
    let quits = 0;
    const app = new TuiApp(setup.renderer, new TuiIssueStore(async () => issues), appOptions(() => { quits += 1; }));
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 2); await setup.flush();
      await pressEscape(setup);
      expect(quits).toBe(0);
      expect(app.list.visible).toBe(true);
      expect(app.list.focused).toBe(true);
    } finally { app.quit(); setup.renderer.destroy(); }
  });

  test("z still toggles the list without appearing in the chrome", async () => {
    const setup = await createTestRenderer({ width: 110, height: 30 });
    const app = new TuiApp(setup.renderer, new TuiIssueStore(async () => issues), appOptions());
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 2); await setup.flush();
      setup.mockInput.pressKey("z"); await setup.flush();
      expect(app.list.visible).toBe(false); expect(app.detail.focused).toBe(true);
      expect(setup.captureCharFrame()).not.toContain("z show");
      setup.mockInput.pressKey("z"); await setup.flush();
      expect(app.list.visible).toBe(true);
    } finally { app.quit(); setup.renderer.destroy(); }
  });

  test("detail pane renders markdown headings, lists, and mermaid ASCII", async () => {
    const rich: TuiIssue = {
      ...issues[0]!,
      description: "## Context\n\nUsers bounce.\n\n- stale cookie\n\n```mermaid\ngraph LR\n  A --> B\n```\n",
    };
    const setup = await createTestRenderer({ width: 110, height: 30 });
    const app = new TuiApp(setup.renderer, new TuiIssueStore(async () => [rich]), appOptions());
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 1); await setup.flush();
      setup.mockInput.pressEnter();
      await setup.waitFor(() => !app.list.visible && app.detail.visible);
      const frame = await setup.waitForFrame((value) =>
        value.includes("Context") && value.includes("stale cookie") && /[┌─┐│└┘►]/.test(value),
      );
      expect(frame).toContain("Context");
      expect(frame).not.toContain("## Context");
      expect(frame).toContain("Users bounce.");
      expect(frame).toContain("stale cookie");
      expect(frame).toContain("A");
      expect(frame).toContain("B");
      expect(frame).toMatch(/[┌─┐│└┘►]/);
      expect(frame).not.toContain("```mermaid");
    } finally { app.quit(); setup.renderer.destroy(); }
  });

  test("z is text in search and does not hide the list", async () => {
    const setup = await createTestRenderer({ width: 110, height: 30 });
    const app = new TuiApp(setup.renderer, new TuiIssueStore(async () => issues), appOptions());
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 2);
      setup.mockInput.pressKey("/"); await setup.mockInput.typeText("z");
      expect(app.search.value).toBe("z");
      expect(app.list.visible).toBe(true); expect(app.detail.visible).toBe(true);
      app.search.handleKeyPress({ name: "escape" } as import("@opentui/core").KeyEvent);
    } finally { app.quit(); setup.renderer.destroy(); }
  });

  test("narrow tabs switch between one visible pane at a time", async () => {
    const setup = await createTestRenderer({ width: 60, height: 28, useMouse: true });
    const app = new TuiApp(setup.renderer, new TuiIssueStore(async () => issues), appOptions());
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 2); await setup.flush();
      let frame = setup.captureCharFrame();
      expect(app.list.visible).toBe(true); expect(app.detail.visible).toBe(false);
      expect(frame).toContain("IN PROGRESS · 1"); expect(frame).not.toContain("Users bounce.");
      setup.mockInput.pressTab();
      await setup.waitFor(() => !app.list.visible && app.detail.visible && app.detail.focused);
      frame = await setup.waitForFrame((value) => value.includes("Users bounce.") && !value.includes("IN PROGRESS · 1"));
      expect(app.list.visible).toBe(false); expect(app.detail.visible).toBe(true);
      expect(app.detail.focused).toBe(true); expect(frame).toContain("Users bounce.");
      expect(frame).not.toContain("IN PROGRESS · 1");
      setup.mockInput.pressTab();
      await setup.waitFor(() => app.list.visible && !app.detail.visible && app.list.focused);
      expect(app.list.visible).toBe(true); expect(app.detail.visible).toBe(false); expect(app.list.focused).toBe(true);
      setup.mockInput.pressTab(); setup.mockInput.pressKey("/");
      app.search.handleKeyPress({ name: "escape" } as import("@opentui/core").KeyEvent); await setup.flush();
      expect(app.list.visible).toBe(true); expect(app.detail.visible).toBe(false); expect(app.list.focused).toBe(true);
    } finally { app.quit(); setup.renderer.destroy(); }
  });

  test("header chips look like dropdowns and the footer lists hidden keys", async () => {
    expect(chipLabel("team", "all", false)).toBe("Team all ▾");
    expect(chipLabel("project", "Reliability", false)).toBe("Project Reliability ▾");
    expect(chipLabel("sort", "updated", false)).toBe("Sort updated ▾");
    expect(footerHint(false, false)).toBe("/ search  ·  r refresh  ·  q quit");
    expect(footerHint(true, false)).toBe("esc back  ·  / search  ·  r refresh  ·  q quit");
    expect(footerHint(false, true)).toBe("/ search  ·  q quit");
    for (const width of [110, 60, 40]) {
      const setup = await createTestRenderer({ width, height: 28 });
      const app = new TuiApp(setup.renderer, new TuiIssueStore(async () => issues), appOptions());
      try {
        app.start(); await setup.waitFor(() => app.list.options.length === 2); await setup.flush();
        const frame = setup.captureCharFrame();
        expect(app.footer.plainText).toContain("/ search");
        expect(app.footer.plainText).toContain("q quit");
        expect(frame).toContain("/ search");
        expect(frame).toContain("q quit");
        expect(frame).not.toContain("1-4 views");
        if (width >= 80) expect(app.footer.plainText).toContain("r refresh");
        if (width >= 56) {
          expect(frame).toContain("All");
          expect(frame).toContain("Started");
          expect(frame).toContain("Team all");
        }
        if (width >= 80) {
          expect(frame).toContain("Project all");
          expect(frame).toContain("Sort updated");
          expect(frame).toContain("Open ↗");
        }
      } finally { app.quit(); setup.renderer.destroy(); }
    }
  });
});

describe("open in Linear", () => {
  test("turns the https issue URL into Linear's desktop protocol", () => {
    expect(linearAppUrl("https://linear.app/acme/issue/ENG-42")).toBe("linear://linear.app/acme/issue/ENG-42");
    expect(linearAppUrl("HTTPS://linear.app/issue/ENG-123")).toBe("linear://linear.app/issue/ENG-123");
    expect(issueOpenUrl("https://linear.app/acme/issue/ENG-42", false)).toBe("linear://linear.app/acme/issue/ENG-42");
    expect(issueOpenUrl("https://linear.app/acme/issue/ENG-42", true)).toBe("https://linear.app/acme/issue/ENG-42");
    expect(isRemoteSession({ HERDR_ENV: "1" })).toBe(true);
    expect(isRemoteSession({ SSH_CONNECTION: "1 2 3 4" })).toBe(true);
    expect(isRemoteSession({})).toBe(false);
    expect(openChipLabel(false)).toBe("Open ↗");
    expect(openChipLabel(true)).toBe("↗");
    expect(openCommand("darwin")).toEqual(["open"]);
    expect(openCommand("linux")).toEqual(["xdg-open"]);
    expect(openCommand("win32")).toEqual(["cmd", "/c", "start", ""]);
  });

  test("click and o open the shown issue, not the highlighted row", async () => {
    const opened: string[] = [];
    const setup = await createTestRenderer({ width: 110, height: 30, useMouse: true });
    const app = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => issues),
      appOptions(undefined, { openExternal: (url) => { opened.push(url); } }),
    );
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 2); await setup.flush();
      expect(app.openChip.visible).toBe(true);
      expect(app.detail.title).toBe("https://linear.app/x/ENG-42");
      await setup.mockMouse.click(app.openChip.screenX, app.openChip.screenY); await setup.flush();
      expect(opened).toEqual(["linear://linear.app/x/ENG-42"]);
      setup.mockInput.pressKey("j"); await setup.flush();
      setup.mockInput.pressKey("o"); await setup.flush();
      expect(opened).toEqual(["linear://linear.app/x/ENG-42", "linear://linear.app/x/ENG-42"]);
      const second = app.list.findDescendantById("tui-issue-row-APP-4") as import("@opentui/core").Renderable;
      await setup.mockMouse.click(second.screenX + 2, second.screenY); await setup.flush();
      setup.mockInput.pressKey("o"); await setup.flush();
      expect(opened.at(-1)).toBe("linear://linear.app/x/APP-4");
    } finally { app.quit(); setup.renderer.destroy(); }
  });

  test("a failed open lands in the footer", async () => {
    const setup = await createTestRenderer({ width: 110, height: 30 });
    const app = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => issues),
      appOptions(undefined, { openExternal: () => { throw new Error("no handler"); } }),
    );
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 2);
      app.openInLinear();
      await setup.waitFor(() => app.footer.plainText.includes("Could not open Linear"));
      expect(app.footer.plainText).toContain("no handler");
    } finally { app.quit(); setup.renderer.destroy(); }
  });

  test("a remote session copies the https URL instead of opening Linear on the host", async () => {
    const copied: string[] = [];
    const opened: string[] = [];
    const setup = await createTestRenderer({ width: 110, height: 30 });
    const app = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => issues),
      appOptions(undefined, {
        remote: true,
        copyToClipboard: (text) => { copied.push(text); return true; },
        // openExternal omitted: remote path must not spawn on the host
      }),
    );
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 2);
      app.openInLinear();
      await setup.waitFor(() => app.footer.plainText.includes("copied"));
      expect(copied).toEqual(["https://linear.app/x/ENG-42"]);
      expect(opened).toEqual([]);
      expect(app.footer.plainText).toContain("ctrl-click");
    } finally { app.quit(); setup.renderer.destroy(); }
  });
});
