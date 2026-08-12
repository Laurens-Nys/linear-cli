import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { TuiApp } from "../src/tui/app.ts";
import { loadTuiIssues, TuiIssueStore, type TuiIssue } from "../src/tui/data.ts";
import { runTui } from "../src/tui/run.ts";
import { mock, sandbox, type Mock, type Sandbox } from "./harness.ts";

const issues: TuiIssue[] = [
  {
    identifier: "ENG-42",
    title: "Fix login redirect",
    description: "Users are bounced back to login.",
    priority: 2,
    updatedAt: "2026-08-12T10:00:00Z",
    dueDate: null,
    url: "https://linear.app/acme/issue/ENG-42",
    state: { name: "In Progress", color: "#5e6ad2" },
    team: { key: "ENG", name: "Engineering" },
    project: { name: "Reliability" },
    labels: { nodes: [{ name: "Bug" }] },
  },
  {
    identifier: "ENG-41",
    title: "Rotate webhook secrets",
    description: null,
    priority: 3,
    updatedAt: "2026-08-11T10:00:00Z",
    url: "https://linear.app/acme/issue/ENG-41",
    state: { name: "Todo" },
    team: { key: "ENG", name: "Engineering" },
    project: null,
    labels: { nodes: [] },
  },
];

let box: Sandbox;
let net: Mock;

beforeEach(() => {
  box = sandbox();
  net = mock([{ match: "LinTuiIssues", data: { issues: { nodes: issues } } }]);
});

afterEach(() => {
  net.restore();
  box.cleanup();
});

describe("TUI issue data", () => {
  test("loads a bounded page of my open issues", async () => {
    expect(await loadTuiIssues(25)).toEqual(issues);
    expect(net.calls[0]?.variables).toEqual({
      first: 25,
      filter: {
        assignee: { isMe: { eq: true } },
        state: { type: { nin: ["completed", "canceled"] } },
      },
    });
  });

  test("keeps prior data visible when refresh fails", async () => {
    let count = 0;
    const store = new TuiIssueStore(async () => {
      count += 1;
      if (count === 1) return issues;
      throw new Error("offline");
    });
    expect((await store.refresh()).kind).toBe("ready");
    const state = await store.refresh();
    expect(state.kind).toBe("error");
    expect(state.issues).toEqual(issues);
  });
});

describe("OpenTUI interaction", () => {
  test("keyboard and mouse select, refresh, and quit with cleanup", async () => {
    const setup = await createTestRenderer({ width: 100, height: 28, useMouse: true });
    let loads = 0;
    let quits = 0;
    const store = new TuiIssueStore(async () => {
      loads += 1;
      return issues;
    });
    const app = new TuiApp(setup.renderer, store, { onQuit: () => { quits += 1; } });
    try {
      app.start();
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("Fix login redirect");
      expect(app.list.getSelectedIndex()).toBe(0);
      setup.mockInput.pressArrow("down");
      await setup.flush();
      expect(app.list.getSelectedIndex()).toBe(1);
      expect(app.detailText.plainText).toContain("Rotate webhook secrets");
      expect(app.detailText.plainText).toContain("No description.");

      setup.mockInput.pressKey("k");
      await setup.flush();
      expect(app.list.getSelectedIndex()).toBe(0);

      await setup.mockMouse.click(app.list.screenX + 3, app.list.screenY + 2);
      await setup.flush();
      expect(app.list.getSelectedIndex()).toBe(1);

      setup.mockInput.pressKey("r");
      await setup.waitFor(() => loads === 2);
      expect(loads).toBe(2);
      expect(app.list.getSelectedIndex()).toBe(1);
      setup.mockInput.pressKey("q");
      expect(quits).toBe(1);
    } finally {
      setup.renderer.destroy();
    }
    expect(setup.renderer.isDestroyed).toBe(true);
  });

  test("late refresh completion does not mutate destroyed renderables", async () => {
    const setup = await createTestRenderer({ width: 100, height: 28 });
    let resolveLoad: ((value: TuiIssue[]) => void) | undefined;
    const pending = new Promise<TuiIssue[]>((resolve) => { resolveLoad = resolve; });
    const app = new TuiApp(setup.renderer, new TuiIssueStore(async () => pending));
    app.start();
    await setup.flush();
    expect(app.status.plainText).toBe("Refreshing your open issues…");
    const contentBeforeDestroy = app.status.content;
    app.quit();
    setup.renderer.destroy();
    resolveLoad?.(issues);
    await app.refresh();
    expect(app.status.content).toBe(contentBeforeDestroy);
  });

  test("narrow layouts keep refresh and quit controls visible", async () => {
    const setup = await createTestRenderer({ width: 60, height: 24 });
    const store = new TuiIssueStore(async () => issues);
    const app = new TuiApp(setup.renderer, store);
    try {
      app.start();
      await setup.waitFor(() => store.state.kind === "ready");
      await setup.flush();
      expect(app.footer.plainText).toBe("↑/↓ select   r refresh   q quit");
      expect(app.list.width).toBe(60 - 2);
    } finally {
      app.quit();
      setup.renderer.destroy();
    }
  });
});

describe("production TUI lifecycle", () => {
  test("q tears down promptly while the initial load is still pending", async () => {
    const setup = await createTestRenderer({ width: 100, height: 28 });
    let resolveLoad: ((value: TuiIssue[]) => void) | undefined;
    const pending = new Promise<TuiIssue[]>((resolve) => { resolveLoad = resolve; });
    const running = runTui(25, {
      createRenderer: async () => setup.renderer,
      loadIssues: async () => pending,
    });
    await setup.waitFor(() => setup.renderer.root.getRenderable("tui-root") !== undefined);
    setup.mockInput.pressKey("q");
    await running;
    expect(setup.renderer.isDestroyed).toBe(true);
    resolveLoad?.(issues);
    await Promise.resolve();
  });

  test("Ctrl-C tears down promptly while the initial load is still pending", async () => {
    const setup = await createTestRenderer({ width: 100, height: 28 });
    const running = runTui(25, {
      createRenderer: async () => setup.renderer,
      loadIssues: async () => new Promise<TuiIssue[]>(() => {}),
    });
    await setup.waitFor(() => setup.renderer.root.getRenderable("tui-root") !== undefined);
    setup.mockInput.pressKey("c", { ctrl: true });
    await running;
    expect(setup.renderer.isDestroyed).toBe(true);
  });

  test("renderer destruction releases the app wait and teardown stays idempotent", async () => {
    const setup = await createTestRenderer({ width: 100, height: 28 });
    const running = runTui(25, {
      createRenderer: async () => setup.renderer,
      loadIssues: async () => new Promise<TuiIssue[]>(() => {}),
    });
    await setup.waitFor(() => setup.renderer.root.getRenderable("tui-root") !== undefined);
    setup.renderer.destroy();
    await running;
    expect(setup.renderer.isDestroyed).toBe(true);
  });
});
