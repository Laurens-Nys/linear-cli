import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { Meta } from "../src/cache.ts";
import { TuiApp, chipLabel, footerHint, openChipLabel, visibleSelectOffset } from "../src/tui/app.ts";
import { isRemoteSession, issueOpenUrl, linearAppUrl, openCommand } from "../src/tui/open.ts";
import { groupIssuesByState, statusPresentation } from "../src/tui/issue-list.ts";
import { issueDetail, renderMermaidForWidth } from "../src/tui/markdown.ts";
import {
  loadTuiIssues, TuiIssueStore, tuiIssueVariables, tuiStateFilter, TUI_SORTS,
  type TuiIssue, type TuiIssueQuery,
} from "../src/tui/data.ts";
import { runTui } from "../src/tui/run.ts";
import { GROK_NIGHT } from "../src/tui/theme.ts";
import { mock, sandbox, type Mock, type Sandbox } from "./harness.ts";

const issues: TuiIssue[] = [
  { identifier: "ENG-42", title: "Fix login redirect", description: "Users bounce.", priority: 2,
    updatedAt: "2026-08-12T10:00:00Z", dueDate: null, url: "https://linear.app/x/ENG-42",
    state: { name: "In Progress", color: "#e0af68", type: "started" }, team: { key: "ENG", name: "Engineering" },
    project: { name: "Reliability" }, labels: { nodes: [{ name: "Bug" }] } },
  { identifier: "APP-4", title: "Rotate webhook secrets", description: null, priority: 3,
    updatedAt: "2026-08-11T10:00:00Z", url: "https://linear.app/x/APP-4",
    state: { name: "Todo", color: "#a8a8a8", type: "unstarted" }, team: { key: "APP", name: "Applications" }, project: null, labels: { nodes: [] } },
];

const meta: Meta = {
  fetchedAt: new Date().toISOString(), keyFingerprint: "x", workspace: { urlKey: "acme", name: "Acme" },
  teams: [
    { id: "team-eng", key: "ENG", name: "Engineering", states: [], labels: [] },
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
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("TUI issue data", () => {
  test("Mine/Open stay while team, project, and title compose", async () => {
    await loadTuiIssues({ limit: 25, teamId: "team-eng", projectId: "project-rel", title: " login ", sort: "created", view: "all" });
    expect(net.calls[0]?.document).toContain("state { name color type }");
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
  test("maps every workflow category to a single-cell status glyph", () => {
    expect(["triage", "backlog", "unstarted", "started", "completed", "canceled", "duplicate"].map(
      (type) => statusPresentation(type as import("../src/tui/data.ts").TuiWorkflowStateType).glyph,
    )).toEqual(["◌", "◍", "○", "◐", "✓", "×", "×"]);
  });

  test("groups by Linear state name and preserves server sort inside each group", () => {
    const input: TuiIssue[] = [
      { ...issues[1]!, identifier: "APP-1" },
      { ...issues[0]!, identifier: "ENG-2", state: { name: "In Review", color: "#e0af68", type: "started" } },
      { ...issues[0]!, identifier: "ENG-3" },
      { ...issues[0]!, identifier: "ENG-4", state: { name: "In Review", color: "#e0af68", type: "started" } },
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

  test("the TUI canvas is transparent so the terminal color shows through", async () => {
    const setup = await createTestRenderer({ width: 110, height: 30 });
    const app = new TuiApp(setup.renderer, new TuiIssueStore(async () => issues), appOptions());
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 2);
      expect(app.root.backgroundColor.a).toBe(0);
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
    expect(rendered).toContain("https://linear.app/x/ENG-42");
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
        return row.screenY >= app.list.screenY && row.screenY < app.list.screenY + app.list.height;
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
      expect(app.viewTabs.all.backgroundColor.equals(RGBA.fromHex(GROK_NIGHT.surface0))).toBe(true);
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
      expect(app.detail.title).toBe("ENG-42");
      setup.mockInput.pressKey("j"); await setup.flush();
      expect(app.list.getSelectedIndex()).toBe(1);
      expect(app.detail.title).toBe("ENG-42");
      const second = app.list.findDescendantById("tui-issue-row-APP-4") as import("@opentui/core").Renderable;
      await setup.mockMouse.click(second.screenX + 2, second.screenY);
      await setup.flush();
      expect(app.detail.title).toBe("APP-4");
      expect(app.list.visible).toBe(true);
      setup.mockInput.pressKey("k"); await setup.flush();
      expect(app.list.getSelectedIndex()).toBe(0);
      expect(app.detail.title).toBe("APP-4");
      setup.mockInput.pressEnter();
      await setup.waitFor(() => !app.list.visible && app.detail.visible && app.detail.focused);
      expect(app.detail.title).toBe("ENG-42");
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
