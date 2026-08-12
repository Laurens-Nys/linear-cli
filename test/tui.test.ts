import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { Meta } from "../src/cache.ts";
import { TuiApp, visibleSelectOffset } from "../src/tui/app.ts";
import {
  loadTuiIssues, TuiIssueStore, tuiIssueVariables, TUI_SORTS,
  type TuiIssue, type TuiIssueQuery,
} from "../src/tui/data.ts";
import { runTui } from "../src/tui/run.ts";
import { GROK_NIGHT } from "../src/tui/theme.ts";
import { mock, sandbox, type Mock, type Sandbox } from "./harness.ts";

const issues: TuiIssue[] = [
  { identifier: "ENG-42", title: "Fix login redirect", description: "Users bounce.", priority: 2,
    updatedAt: "2026-08-12T10:00:00Z", dueDate: null, url: "https://linear.app/x/ENG-42",
    state: { name: "In Progress" }, team: { key: "ENG", name: "Engineering" },
    project: { name: "Reliability" }, labels: { nodes: [{ name: "Bug" }] } },
  { identifier: "APP-4", title: "Rotate webhook secrets", description: null, priority: 3,
    updatedAt: "2026-08-11T10:00:00Z", url: "https://linear.app/x/APP-4",
    state: { name: "Todo" }, team: { key: "APP", name: "Applications" }, project: null, labels: { nodes: [] } },
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
const baseQuery: TuiIssueQuery = { limit: 25, sort: "updated" };
let box: Sandbox; let net: Mock;
beforeEach(() => { box = sandbox(); net = mock([{ match: "LinTuiIssues", data: { issues: { nodes: issues } } }]); });
afterEach(() => { net.restore(); box.cleanup(); });

function appOptions(onQuit?: () => void) { return { limit: 25, meta, onQuit }; }

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("TUI issue data", () => {
  test("Mine/Open stay while team, project, and title compose", async () => {
    await loadTuiIssues({ limit: 25, teamId: "team-eng", projectId: "project-rel", title: " login ", sort: "created" });
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

describe("Grok Night", () => {
  test("uses the exact shared core palette", () => {
    expect(GROK_NIGHT).toEqual({
      base: "#0a0a0a", panel: "#141414", surface0: "#242424", surface1: "#2e2e33",
      surface2: "#363636", border: "#505058", muted: "#6c6c6c", secondary: "#a8a8a8",
      text: "#e1e1e1", accent: "#c8c8c8", mauve: "#bb9af7", red: "#f7768e",
      green: "#9ece6a", yellow: "#e0af68", blue: "#7aa2f7", teal: "#1abc9c",
      peach: "#ff9e64",
    });
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
    } finally { app.quit(); setup.renderer.destroy(); }
  });

  test("mouse clicks Project and Sort chips and rows", async () => {
    const setup = await createTestRenderer({ width: 110, height: 30, useMouse: true });
    const queries: TuiIssueQuery[] = [];
    const app = new TuiApp(setup.renderer, new TuiIssueStore(async (query) => { queries.push(query); return issues; }), appOptions());
    try {
      app.start(); await setup.waitFor(() => queries.length === 1); await setup.flush();
      await setup.mockMouse.click(app.projectChip.screenX + 2, app.projectChip.screenY + 1); await setup.flush();
      let picker = app.root.findDescendantById("tui-picker-list") as import("@opentui/core").SelectRenderable;
      await setup.mockMouse.click(picker.screenX + 2, picker.screenY + 1); // Reliability, after All
      await setup.waitFor(() => queries.length === 2);
      expect(queries[1]?.projectId).toBe("project-rel");
      await setup.mockMouse.click(app.sortChip.screenX + 2, app.sortChip.screenY + 1); await setup.flush();
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
      await setup.mockMouse.click(app.teamChip.screenX + 2, app.teamChip.screenY + 1); await setup.flush();
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
      const offset = visibleSelectOffset(15, many.length, app.list.height, 2);
      await setup.mockMouse.click(app.list.screenX + 2, app.list.screenY);
      expect(app.list.getSelectedIndex()).toBe(offset);
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

  test("Tab and pane clicks switch focus; list wheel changes selection only", async () => {
    const setup = await createTestRenderer({ width: 110, height: 30, useMouse: true });
    const app = new TuiApp(setup.renderer, new TuiIssueStore(async () => issues), appOptions());
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 2); await setup.flush();
      setup.mockInput.pressTab(); expect(app.detail.focused).toBe(true);
      await setup.mockMouse.click(app.list.screenX + 2, app.list.screenY + 1); expect(app.list.focused).toBe(true);
      const detailTop = app.detail.scrollTop;
      await setup.mockMouse.scroll(app.list.screenX + 2, app.list.screenY + 1, "down");
      expect(app.list.getSelectedIndex()).toBe(1); expect(app.detail.scrollTop).toBe(detailTop);
      await setup.mockMouse.click(app.detail.screenX + 2, app.detail.screenY + 2); expect(app.detail.focused).toBe(true);
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
  test("wide and 60-column layouts keep chips, search, and footer usable", async () => {
    for (const width of [110, 60]) {
      const setup = await createTestRenderer({ width, height: 28 });
      const app = new TuiApp(setup.renderer, new TuiIssueStore(async () => issues), appOptions());
      try {
        app.start(); await setup.waitFor(() => app.list.options.length === 2); await setup.flush();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("Team:"); expect(frame).toContain("Project:");
        expect(frame).toContain("Sort:"); expect(frame).toContain("Search title");
        expect(frame).toContain("r refresh");
        expect(frame).toContain("q quit");
      } finally { app.quit(); setup.renderer.destroy(); }
    }
  });
});
