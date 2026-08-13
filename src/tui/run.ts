import { CliRenderEvents, createCliRenderer, type CliRenderer, type CliRendererConfig } from "@opentui/core";
import { isFresh, load as loadMeta, readCached, type Meta } from "../cache.ts";
import { EXIT, LinError } from "../out.ts";
import { TuiApp } from "./app.ts";
import { loadTuiIssues, TuiIssueStore, type TuiIssueQuery } from "./data.ts";
import { prepareNativeRenderer } from "./native.ts";

export interface RunTuiConfig {
  limit: number;
  team?: string;
  noCache?: boolean;
}

export interface RunTuiOptions {
  createRenderer?: (config: CliRendererConfig) => Promise<CliRenderer>;
  loadIssues?: (query: TuiIssueQuery) => ReturnType<typeof loadTuiIssues>;
  loadMetadata?: () => Promise<Meta>;
  refreshMetadata?: () => Promise<Meta>;
}

function findTeam(meta: Meta, ref: string | undefined): Meta["teams"][number] | undefined {
  if (!ref) return undefined;
  const lower = ref.toLowerCase();
  return meta.teams.find((team) => team.key.toLowerCase() === lower || team.name.toLowerCase() === lower);
}

export async function runTui(config: RunTuiConfig, options: RunTuiOptions = {}): Promise<void> {
  let renderer: CliRenderer | undefined;
  let finish = (): void => {};
  const stopped = new Promise<void>((resolve) => { finish = resolve; });

  try {
    const rendererConfig: CliRendererConfig = {
      exitOnCtrlC: false, screenMode: "alternate-screen", clearOnShutdown: true,
      useMouse: true, enableMouseMovement: true, autoFocus: true,
    };
    if (options.createRenderer) {
      renderer = await options.createRenderer(rendererConfig);
    } else {
      await prepareNativeRenderer();
      try {
        renderer = await createCliRenderer(rendererConfig);
      } catch (error) {
        if (error instanceof LinError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new LinError(
          EXIT.api,
          message,
          /libopentui|\$bunfs|dlopen|Failed to initialize OpenTUI/i.test(message)
            ? "Infisical's agent-proxy sandbox cannot dlopen the embedded native library; run lin tui outside the sandbox"
            : undefined,
        );
      }
    }
    renderer.once(CliRenderEvents.DESTROY, finish);
    if (renderer.isDestroyed) return;
    const pendingKeyHandler = (key: import("@opentui/core").KeyEvent): void => {
      if ((key.ctrl && key.name === "c") || key.name === "q") {
        key.preventDefault();
        finish();
      }
    };
    renderer.keyInput.on("keypress", pendingKeyHandler);
    const customMetadataLoader = options.loadMetadata !== undefined;
    const cachedBeforeLoad = customMetadataLoader || config.noCache ? null : readCached();
    let meta = await Promise.race([
      (options.loadMetadata?.() ?? loadMeta({ noCache: config.noCache })),
      stopped.then(() => undefined),
    ]);
    if (!meta || renderer.isDestroyed) return;
    let initialTeam = findTeam(meta, config.team);
    const shouldRefreshMissingTeam = options.refreshMetadata !== undefined
      || (!customMetadataLoader && cachedBeforeLoad !== null && isFresh(cachedBeforeLoad));
    if (config.team && !initialTeam && shouldRefreshMissingTeam) {
      meta = await Promise.race([
        (options.refreshMetadata?.() ?? loadMeta({ noCache: true })),
        stopped.then(() => undefined),
      ]);
      if (!meta || renderer.isDestroyed) return;
      initialTeam = findTeam(meta, config.team);
    }
    if (config.team && !initialTeam) {
      throw new LinError(
        EXIT.input,
        `no team "${config.team}"`,
        `teams: ${meta.teams.map((team) => team.key).join(", ")}`,
      );
    }
    renderer.keyInput.off("keypress", pendingKeyHandler);
    const issueLoader = options.loadIssues ?? loadTuiIssues;
    const store = new TuiIssueStore(issueLoader);
    const app = new TuiApp(renderer, store, {
      limit: config.limit, meta, initialTeamId: initialTeam?.id, onQuit: finish,
    });
    app.start();
    await stopped;
  } finally {
    renderer?.destroy();
  }
}
