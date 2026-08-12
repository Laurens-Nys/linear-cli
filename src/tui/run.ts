import { CliRenderEvents, createCliRenderer, type CliRenderer, type CliRendererConfig } from "@opentui/core";
import { TuiApp } from "./app.ts";
import { loadTuiIssues, TuiIssueStore } from "./data.ts";

export interface RunTuiOptions {
  createRenderer?: (config: CliRendererConfig) => Promise<CliRenderer>;
  loadIssues?: typeof loadTuiIssues;
}

export async function runTui(limit: number, options: RunTuiOptions = {}): Promise<void> {
  let renderer: CliRenderer | undefined;
  let finish = (): void => {};
  const stopped = new Promise<void>((resolve) => {
    finish = resolve;
  });

  try {
    renderer = await (options.createRenderer ?? createCliRenderer)({
      exitOnCtrlC: false,
      screenMode: "alternate-screen",
      clearOnShutdown: true,
      useMouse: true,
      enableMouseMovement: true,
      autoFocus: true,
      backgroundColor: "#111113",
    });
    renderer.once(CliRenderEvents.DESTROY, finish);
    const loadIssues = options.loadIssues ?? loadTuiIssues;
    const store = new TuiIssueStore(() => loadIssues(limit));
    const app = new TuiApp(renderer, store, { onQuit: finish });
    app.start();
    await stopped;
  } finally {
    renderer?.destroy();
  }
}
