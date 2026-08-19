import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createTestRenderer, MouseButtons } from "@opentui/core/testing";
import type { Meta } from "../src/cache.ts";
import { TuiApp, type TuiAppOptions } from "../src/tui/app.ts";
import { tuiIssueActions, issueTeam } from "../src/tui/actions.ts";
import { TuiIssueStore, type TuiIssue, type TuiIssueDetail } from "../src/tui/data.ts";
import { runTui } from "../src/tui/run.ts";
import {
  assertGitBranchName,
  HERDR_AGENT_START_WAIT_MS,
  HERDR_MUTATE_TIMEOUT_MS,
  HERDR_QUERY_TIMEOUT_MS,
  herdrAgentFocusArgv,
  herdrAgentListArgv,
  herdrAgentStartArgv,
  herdrCommandTimeoutMs,
  herdrPaneListArgv,
  herdrPaneProcessInfoArgv,
  herdrPaneSendTextArgv,
  herdrWorktreeCreateArgv,
  herdrWorktreeListArgv,
  herdrWorktreeOpenArgv,
  herdrWorkspaceFocusArgv,
  issueWorktreeSlug,
  openIssueWorktree,
  runWorktreeCommand,
  sanitizeIssueTitle,
  worktreeCheckoutPath,
  worktreePrompt,
  type WorktreeCommandOutput,
  type WorktreeCommandRunner,
  type WorktreeOpenResult,
} from "../src/tui/worktree.ts";
import { EXIT, LinError } from "../src/out.ts";
import { sandbox, type Sandbox } from "./harness.ts";

const issue: TuiIssue = {
  id: "issue-eng-42",
  identifier: "ENG-42",
  title: "Fix login redirect",
  priority: 2,
  updatedAt: "2026-08-12T10:00:00Z",
  dueDate: null,
  url: "https://linear.app/x/ENG-42",
  branchName: "casey/eng-42-fix-login-redirect",
  state: { id: "st-doing", name: "In Progress", color: "#e0af68", type: "started" },
  team: { key: "ENG", name: "Engineering" },
  project: { name: "Reliability" },
  labels: { nodes: [{ name: "Bug" }] },
};

const otherIssue: TuiIssue = {
  id: "issue-app-4",
  identifier: "APP-4",
  title: "Rotate webhook secrets",
  priority: 3,
  updatedAt: "2026-08-11T10:00:00Z",
  url: "https://linear.app/x/APP-4",
  branchName: "casey/app-4-rotate-webhook-secrets",
  state: { id: "st-todo", name: "Todo", color: "#a8a8a8", type: "unstarted" },
  team: { key: "APP", name: "Applications" },
  project: null,
  labels: { nodes: [] },
};

const issues = [issue, otherIssue];

function detailLoader(id: string): TuiIssueDetail {
  return {
    description: id === "issue-eng-42" ? "Users bounce." : null,
    comments: [],
    updatedAt: issues.find((item) => item.id === id)?.updatedAt ?? "",
  };
}

const meta: Meta = {
  fetchedAt: new Date().toISOString(), keyFingerprint: "x", workspace: { urlKey: "acme", name: "Acme" },
  teams: [
    { id: "team-eng", key: "ENG", name: "Engineering", states: [
      { id: "st-todo", name: "Todo", type: "unstarted", position: 2, color: "#a8a8a8" },
      { id: "st-doing", name: "In Progress", type: "started", position: 3, color: "#e0af68" },
      { id: "st-done", name: "Done", type: "completed", position: 4, color: "#9ece6a" },
    ], labels: [] },
    { id: "team-app", key: "APP", name: "Applications", states: [], labels: [] },
  ],
  projects: [], users: [], workspaceLabels: [], templates: [],
};

function appOptions(extras: Partial<TuiAppOptions> = {}): TuiAppOptions {
  return { limit: 25, meta, remote: false, ...extras };
}

function actionNames(app: TuiApp): string[] {
  const list = app.root.findDescendantById("tui-actions-list") as import("@opentui/core").SelectRenderable | undefined;
  return list?.options.map((option) => option.name) ?? [];
}

function ok(result: unknown): WorktreeCommandOutput {
  return { code: 0, stdout: JSON.stringify({ id: "cli", result }), stderr: "" };
}

function listResult(worktrees: unknown[]): WorktreeCommandOutput {
  return ok({ type: "worktree_list", worktrees });
}

function mutateResult(workspaceId: string, paneId: string): WorktreeCommandOutput {
  return ok({
    type: "worktree_created",
    workspace: { workspace_id: workspaceId },
    root_pane: { pane_id: paneId },
    tab: { tab_id: `${workspaceId}:t1` },
    worktree: { path: "/tmp/unused" },
  });
}

function idleShellInfo(paneId: string): WorktreeCommandOutput {
  return ok({
    type: "pane_process_info",
    process_info: { pane_id: paneId, shell_pid: 9, foreground_processes: [] },
  });
}

function expectLinError(error: unknown): LinError {
  expect(error).toBeInstanceOf(LinError);
  return error as LinError;
}

function argvKey(argv: readonly string[]): string {
  return argv.slice(0, 3).join(" ");
}

function makeRepo(box: Sandbox, name = "demo-repo"): string {
  const repo = join(box.dir, name);
  mkdirSync(join(repo, ".git"), { recursive: true });
  return repo;
}

function baseInput(box: Sandbox, run: WorktreeCommandRunner, extras: Partial<Parameters<typeof openIssueWorktree>[0]> = {}) {
  return {
    identifier: issue.identifier,
    title: issue.title,
    branchName: issue.branchName,
    repo: makeRepo(box),
    agent: "claude",
    env: { HERDR_ENV: "1", HOME: box.dir },
    home: box.dir,
    run,
    ...extras,
  };
}

function createAndStageCalls(
  repo: string,
  path: string,
  workspaceId: string,
  paneId: string,
  agentName = "eng-42",
  sendPaneId = paneId,
): string[][] {
  return [
    herdrWorktreeListArgv(repo),
    herdrWorktreeCreateArgv(repo, issue.branchName!, path, "ENG-42"),
    herdrAgentStartArgv("eng-42", "claude", paneId),
    herdrWorkspaceFocusArgv(workspaceId),
    herdrAgentFocusArgv(agentName),
    herdrPaneSendTextArgv(sendPaneId, worktreePrompt("ENG-42", issue.title, issue.branchName!)),
  ];
}

let box: Sandbox;
let currentApp: TuiApp | undefined;

beforeEach(() => { box = sandbox(); });
afterEach(async () => {
  currentApp?.quit();
  currentApp = undefined;
  box.cleanup();
  await Bun.sleep(25);
});

describe("worktree prompt and names", () => {
  test("prompt is one physical line and sanitizes control characters in the title", () => {
    const prompt = worktreePrompt("FDE-63", "Bug: restore Firefly", "casey/fde-63-bug-restore");
    expect(prompt).toBe(
      "Work on Linear issue FDE-63: Bug: restore Firefly · Suggested branch name: casey/fde-63-bug-restore · Read the full issue and comments first with `lin issue view FDE-63 --comments all`.",
    );
    expect(prompt).not.toMatch(/[\r\n\u0000-\u001F\u007F]/);
    expect(sanitizeIssueTitle("Fix\nlogin\r\tredirect\u0007 now")).toBe("Fix login redirect now");
    expect(worktreePrompt("ENG-42", "Fix\nlogin", "casey/eng-42-fix-login")).toBe(
      "Work on Linear issue ENG-42: Fix login · Suggested branch name: casey/eng-42-fix-login · Read the full issue and comments first with `lin issue view ENG-42 --comments all`.",
    );
    expect(issueWorktreeSlug("FDE-63")).toBe("fde-63");
    expect(assertGitBranchName("casey/eng-42-fix-login-redirect")).toBe("casey/eng-42-fix-login-redirect");
  });

  test("refuses to invent a branch when Linear's name is missing or invalid", () => {
    try { assertGitBranchName(null); throw new Error("expected a LinError"); }
    catch (error) { expect(expectLinError(error).exitCode).toBe(EXIT.input); }
    try { assertGitBranchName("casey/eng-42 bad"); throw new Error("expected a LinError"); }
    catch (error) { expect(expectLinError(error).message).toContain("not a usable git branch"); }
    expect(() => issueWorktreeSlug("??")).toThrow(/not a valid worktree name/);
  });
});

describe("openIssueWorktree", () => {
  test("creates, starts the configured agent, and stages send-text without a shell", async () => {
    const calls: { argv: string[]; timeoutMs?: number }[] = [];
    const repo = makeRepo(box);
    const path = worktreeCheckoutPath(repo, "ENG-42", box.dir);
    const prompt = worktreePrompt("ENG-42", issue.title, issue.branchName!);
    expect(prompt).not.toMatch(/\n/);
    const run: WorktreeCommandRunner = async (argv, options) => {
      calls.push({ argv: [...argv], timeoutMs: options?.timeoutMs });
      expect(argv[0]).toBe("herdr");
      expect(argv.includes("-c")).toBe(false);
      expect(argv.includes("/bin/sh")).toBe(false);
      const key = argvKey(argv);
      if (key === "herdr worktree list") return listResult([]);
      if (key === "herdr worktree create") return mutateResult("w9", "w9:p1");
      if (key === "herdr agent start") return ok({ type: "agent_started" });
      if (key === "herdr pane send-text") return { code: 0, stdout: "", stderr: "" };
      if (key === "herdr workspace focus" || key === "herdr agent focus") return ok({});
      throw new Error(`unexpected ${argv.join(" ")}`);
    };
    const result = await openIssueWorktree(baseInput(box, run, { repo }));
    expect(result).toMatchObject({ created: true, reused: false, workspaceId: "w9", paneId: "w9:p1" });
    expect(calls.map((call) => call.argv)).toEqual(createAndStageCalls(repo, path, "w9", "w9:p1"));
    expect(calls[0]?.timeoutMs).toBe(HERDR_QUERY_TIMEOUT_MS);
    expect(calls[1]?.timeoutMs).toBe(HERDR_MUTATE_TIMEOUT_MS);
    expect(calls[2]?.timeoutMs).toBe(HERDR_AGENT_START_WAIT_MS);
    expect(calls[3]?.timeoutMs).toBe(HERDR_QUERY_TIMEOUT_MS);
    expect(calls.some((call) => call.argv[1] === "agent" && call.argv[2] === "prompt")).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  test("focuses the started agent before staging send-text and uses Herdr's identity", async () => {
    const calls: string[][] = [];
    const repo = makeRepo(box);
    const path = worktreeCheckoutPath(repo, "ENG-42", box.dir);
    const run: WorktreeCommandRunner = async (argv) => {
      calls.push([...argv]);
      const key = argvKey(argv);
      if (key === "herdr worktree list") return listResult([]);
      if (key === "herdr worktree create") return mutateResult("w9", "w9:p1");
      if (key === "herdr agent start") {
        return ok({ type: "agent_started", agent: { name: "grok-w9", pane_id: "w9:p7", agent: "claude" } });
      }
      if (key === "herdr pane send-text") return { code: 0, stdout: "", stderr: "" };
      if (key === "herdr workspace focus" || key === "herdr agent focus") return ok({});
      throw new Error(`unexpected ${argv.join(" ")}`);
    };
    const result = await openIssueWorktree(baseInput(box, run, { repo }));
    expect(result).toMatchObject({ created: true, reused: false, workspaceId: "w9", paneId: "w9:p7", agentName: "grok-w9" });
    expect(calls).toEqual(createAndStageCalls(repo, path, "w9", "w9:p1", "grok-w9", "w9:p7"));
    const startAt = calls.findIndex((argv) => argv[1] === "agent" && argv[2] === "start");
    expect(calls.slice(startAt).map((argv) => argv.slice(0, 3))).toEqual([
      ["herdr", "agent", "start"],
      ["herdr", "workspace", "focus"],
      ["herdr", "agent", "focus"],
      ["herdr", "pane", "send-text"],
    ]);
    expect(calls[startAt + 2]).toEqual(herdrAgentFocusArgv("grok-w9"));
    expect(calls[startAt + 3]).toEqual(herdrPaneSendTextArgv("w9:p7", worktreePrompt("ENG-42", issue.title, issue.branchName!)));
    expect(calls.some((argv) => argv[1] === "agent" && argv[2] === "prompt")).toBe(false);
  });

  test("opens a closed matching worktree instead of creating another", async () => {
    const calls: string[][] = [];
    const repo = makeRepo(box);
    const path = worktreeCheckoutPath(repo, "ENG-42", box.dir);
    const run: WorktreeCommandRunner = async (argv) => {
      calls.push([...argv]);
      const key = argvKey(argv);
      if (key === "herdr worktree list") {
        return listResult([{ branch: issue.branchName, path, open_workspace_id: null }]);
      }
      if (key === "herdr worktree open") return mutateResult("w8", "w8:p1");
      if (key === "herdr agent start") return ok({});
      if (key === "herdr pane send-text") return { code: 0, stdout: "", stderr: "" };
      if (key === "herdr workspace focus" || key === "herdr agent focus") return ok({});
      throw new Error(`unexpected ${argv.join(" ")}`);
    };
    const result = await openIssueWorktree(baseInput(box, run, { repo }));
    expect(result.opened).toBe(true);
    expect(result.created).toBe(false);
    expect(calls[1]).toEqual(herdrWorktreeOpenArgv(repo, path, issue.branchName!, "ENG-42"));
    expect(calls.slice(2)).toEqual([
      herdrAgentStartArgv("eng-42", "claude", "w8:p1"),
      herdrWorkspaceFocusArgv("w8"),
      herdrAgentFocusArgv("eng-42"),
      herdrPaneSendTextArgv("w8:p1", worktreePrompt("ENG-42", issue.title, issue.branchName!)),
    ]);
    expect(calls.some((argv) => argv[1] === "worktree" && argv[2] === "create")).toBe(false);
  });

  test("does not reuse the primary checkout when it already has the Linear branch", async () => {
    const calls: string[][] = [];
    const repo = makeRepo(box);
    const path = worktreeCheckoutPath(repo, "ENG-42", box.dir);
    const run: WorktreeCommandRunner = async (argv) => {
      calls.push([...argv]);
      const key = argvKey(argv);
      if (key === "herdr worktree list") {
        return listResult([{
          branch: issue.branchName,
          path: repo,
          open_workspace_id: "w1",
          is_linked_worktree: false,
        }]);
      }
      if (key === "herdr worktree create") return mutateResult("w9", "w9:p1");
      if (key === "herdr agent start") return ok({});
      if (key === "herdr pane send-text") return { code: 0, stdout: "", stderr: "" };
      if (key === "herdr workspace focus" || key === "herdr agent focus") return ok({});
      throw new Error(`unexpected ${argv.join(" ")}`);
    };
    const result = await openIssueWorktree(baseInput(box, run, { repo }));
    expect(result.created).toBe(true);
    expect(calls[1]).toEqual(herdrWorktreeCreateArgv(repo, issue.branchName!, path, "ENG-42"));
    expect(calls).not.toContainEqual(herdrWorkspaceFocusArgv("w1"));
    expect(calls.some((argv) => argv[2] === "open")).toBe(false);
  });

  test("does not attach to another worktree that already has the Linear branch", async () => {
    const calls: string[][] = [];
    const repo = makeRepo(box);
    const path = worktreeCheckoutPath(repo, "ENG-42", box.dir);
    const other = join(box.dir, "other-eng-42");
    const run: WorktreeCommandRunner = async (argv) => {
      calls.push([...argv]);
      const key = argvKey(argv);
      if (key === "herdr worktree list") {
        return listResult([{ branch: issue.branchName, path: other, open_workspace_id: "w1" }]);
      }
      if (key === "herdr worktree create") {
        return { code: 1, stdout: JSON.stringify({ error: { message: "branch already checked out" } }), stderr: "" };
      }
      throw new Error(`unexpected ${argv.join(" ")}`);
    };
    await expect(openIssueWorktree(baseInput(box, run, { repo }))).rejects.toThrow(/branch already checked out/);
    expect(calls).toEqual([
      herdrWorktreeListArgv(repo),
      herdrWorktreeCreateArgv(repo, issue.branchName!, path, "ENG-42"),
    ]);
    expect(calls).not.toContainEqual(herdrWorkspaceFocusArgv("w1"));
  });

  test("fails before open when the target path is already on another branch", async () => {
    const calls: string[][] = [];
    const repo = makeRepo(box);
    const path = worktreeCheckoutPath(repo, "ENG-42", box.dir);
    const run: WorktreeCommandRunner = async (argv) => {
      calls.push([...argv]);
      if (argvKey(argv) === "herdr worktree list") {
        return listResult([{ branch: "old/other-issue", path, open_workspace_id: "w3" }]);
      }
      throw new Error(`unexpected ${argv.join(" ")}`);
    };
    const error = expectLinError(await openIssueWorktree(baseInput(box, run, { repo })).catch((item) => item));
    expect(error.exitCode).toBe(EXIT.input);
    expect(error.message).toContain(path);
    expect(error.message).toContain("old/other-issue");
    expect(error.message).toContain(issue.branchName!);
    expect(calls).toEqual([herdrWorktreeListArgv(repo)]);
  });

  test("reuses an already-open worktree agent without starting or staging", async () => {
    const calls: string[][] = [];
    const repo = makeRepo(box);
    const path = worktreeCheckoutPath(repo, "ENG-42", box.dir);
    const run: WorktreeCommandRunner = async (argv) => {
      calls.push([...argv]);
      const key = argvKey(argv);
      if (key === "herdr worktree list") {
        return listResult([{ branch: issue.branchName, path, open_workspace_id: "w3" }]);
      }
      if (key === "herdr agent list") {
        return ok({ agents: [{ name: "eng-42", pane_id: "w3:p1", cwd: path, agent: "claude", agent_status: "idle" }] });
      }
      if (key === "herdr workspace focus") return ok({});
      if (key === "herdr agent focus") return ok({});
      throw new Error(`unexpected ${argv.join(" ")}`);
    };
    const result = await openIssueWorktree(baseInput(box, run, { repo }));
    expect(result.reused).toBe(true);
    expect(calls).toEqual([
      herdrWorktreeListArgv(repo),
      herdrAgentListArgv(),
      herdrWorkspaceFocusArgv("w3"),
      herdrAgentFocusArgv("eng-42"),
    ]);
    expect(calls.some((argv) => argv[2] === "create" || argv[2] === "open" || argv[2] === "start" || argv[2] === "send-text")).toBe(false);
  });

  test("matches an existing agent by foreground_cwd and configured kind", async () => {
    const calls: string[][] = [];
    const repo = makeRepo(box);
    const path = worktreeCheckoutPath(repo, "ENG-42", box.dir);
    const run: WorktreeCommandRunner = async (argv) => {
      calls.push([...argv]);
      const key = argvKey(argv);
      if (key === "herdr worktree list") {
        return listResult([{ branch: issue.branchName, path, open_workspace_id: "w3" }]);
      }
      if (key === "herdr agent list") {
        return ok({ agents: [
          { name: "other", pane_id: "w3:p2", cwd: path, agent: "codex" },
          { name: "eng-42", pane_id: "w3:p1", foreground_cwd: path, agent: "claude" },
        ] });
      }
      if (key === "herdr workspace focus" || key === "herdr agent focus") return ok({});
      throw new Error(`unexpected ${argv.join(" ")}`);
    };
    const result = await openIssueWorktree(baseInput(box, run, { repo }));
    expect(result.reused).toBe(true);
    expect(result.paneId).toBe("w3:p1");
    expect(calls).toEqual([
      herdrWorktreeListArgv(repo),
      herdrAgentListArgv(),
      herdrWorkspaceFocusArgv("w3"),
      herdrAgentFocusArgv("eng-42"),
    ]);
  });

  test("starts on a process-safe p1 shell when the matching worktree is open without an agent", async () => {
    const calls: string[][] = [];
    const repo = makeRepo(box);
    const path = worktreeCheckoutPath(repo, "ENG-42", box.dir);
    const run: WorktreeCommandRunner = async (argv) => {
      calls.push([...argv]);
      const key = argvKey(argv);
      if (key === "herdr worktree list") {
        return listResult([{ branch: issue.branchName, path, open_workspace_id: "w3" }]);
      }
      if (key === "herdr agent list") return ok({ agents: [] });
      if (key === "herdr pane list") {
        return ok({ panes: [
          { pane_id: "w3:p2", agent: "claude", agent_status: "working" },
          { pane_id: "w3:p1", agent_status: "unknown" },
        ] });
      }
      if (key === "herdr pane process-info") return idleShellInfo("w3:p1");
      if (key === "herdr agent start") return ok({});
      if (key === "herdr pane send-text") return { code: 0, stdout: "", stderr: "" };
      if (key === "herdr workspace focus" || key === "herdr agent focus") return ok({});
      throw new Error(`unexpected ${argv.join(" ")}`);
    };
    const result = await openIssueWorktree(baseInput(box, run, { repo }));
    expect(result.paneId).toBe("w3:p1");
    expect(calls).toContainEqual(herdrPaneListArgv("w3"));
    expect(calls).toContainEqual(herdrPaneProcessInfoArgv("w3:p1"));
    expect(calls).toContainEqual(herdrAgentStartArgv("eng-42", "claude", "w3:p1"));
    const startAt = calls.findIndex((argv) => argv[1] === "agent" && argv[2] === "start");
    expect(calls.slice(startAt)).toEqual([
      herdrAgentStartArgv("eng-42", "claude", "w3:p1"),
      herdrWorkspaceFocusArgv("w3"),
      herdrAgentFocusArgv("eng-42"),
      herdrPaneSendTextArgv("w3:p1", worktreePrompt("ENG-42", issue.title, issue.branchName!)),
    ]);
  });

  test("skips a busy foreground process and starts on the next process-safe shell", async () => {
    const calls: string[][] = [];
    const repo = makeRepo(box);
    const path = worktreeCheckoutPath(repo, "ENG-42", box.dir);
    const run: WorktreeCommandRunner = async (argv) => {
      calls.push([...argv]);
      const key = argvKey(argv);
      if (key === "herdr worktree list") {
        return listResult([{ branch: issue.branchName, path, open_workspace_id: "w3" }]);
      }
      if (key === "herdr agent list") {
        return ok({ agents: [{ name: "review", pane_id: "w3:p4", cwd: path, agent: "codex" }] });
      }
      if (key === "herdr pane list") {
        return ok({ panes: [
          { pane_id: "w3:p1", agent_status: "unknown" },
          { pane_id: "w3:p3", agent_status: "idle" },
        ] });
      }
      if (key === "herdr pane process-info") {
        if (argv.includes("w3:p1")) {
          return ok({
            process_info: {
              pane_id: "w3:p1",
              foreground_processes: [{ argv0: "node", name: "node", cwd: path }],
            },
          });
        }
        return ok({
          process_info: {
            pane_id: "w3:p3",
            foreground_processes: [{ argv0: "/bin/zsh", name: "zsh", cwd: path }],
          },
        });
      }
      if (key === "herdr agent start") return ok({});
      if (key === "herdr pane send-text") return { code: 0, stdout: "", stderr: "" };
      if (key === "herdr workspace focus" || key === "herdr agent focus") return ok({});
      throw new Error(`unexpected ${argv.join(" ")}`);
    };
    const result = await openIssueWorktree(baseInput(box, run, { repo }));
    expect(result.paneId).toBe("w3:p3");
    expect(calls).toContainEqual(herdrPaneProcessInfoArgv("w3:p1"));
    expect(calls).toContainEqual(herdrPaneProcessInfoArgv("w3:p3"));
    expect(calls).toContainEqual(herdrAgentStartArgv("eng-42", "claude", "w3:p3"));
    const startAt = calls.findIndex((argv) => argv[1] === "agent" && argv[2] === "start");
    expect(calls.slice(startAt)).toEqual([
      herdrAgentStartArgv("eng-42", "claude", "w3:p3"),
      herdrWorkspaceFocusArgv("w3"),
      herdrAgentFocusArgv("eng-42"),
      herdrPaneSendTextArgv("w3:p3", worktreePrompt("ENG-42", issue.title, issue.branchName!)),
    ]);
  });

  test("refuses to type into a pane whose foreground process is not a shell", async () => {
    const repo = makeRepo(box);
    const path = worktreeCheckoutPath(repo, "ENG-42", box.dir);
    const run: WorktreeCommandRunner = async (argv) => {
      const key = argvKey(argv);
      if (key === "herdr worktree list") {
        return listResult([{ branch: issue.branchName, path, open_workspace_id: "w3" }]);
      }
      if (key === "herdr agent list") return ok({ agents: [] });
      if (key === "herdr pane list") {
        return ok({ panes: [{ pane_id: "w3:p1", agent_status: "unknown" }] });
      }
      if (key === "herdr pane process-info") {
        return ok({
          process_info: {
            pane_id: "w3:p1",
            foreground_processes: [{ argv0: "vim", name: "vim" }],
          },
        });
      }
      throw new Error(`unexpected ${argv.join(" ")}`);
    };
    await expect(openIssueWorktree(baseInput(box, run, { repo }))).rejects.toThrow(/no process-safe shell pane/);
  });

  test("malformed JSON and herdr errors stay named", async () => {
    const repo = makeRepo(box);
    await expect(openIssueWorktree(baseInput(box, async () => ({ code: 0, stdout: "not-json", stderr: "" }), { repo })))
      .rejects.toThrow(/invalid JSON/);
    await expect(openIssueWorktree(baseInput(box, async () => ({
      code: 1,
      stdout: JSON.stringify({ error: { code: "boom", message: "workspace exploded" } }),
      stderr: "",
    }), { repo }))).rejects.toThrow(/workspace exploded/);
  });

  test("missing Herdr, repo, branch, agent, and remote env fail before create", async () => {
    const repo = makeRepo(box);
    const calls: string[][] = [];
    const run: WorktreeCommandRunner = async (argv) => {
      calls.push([...argv]);
      throw new LinError(EXIT.input, "herdr is not installed", "install herdr or add it to PATH");
    };
    expect(expectLinError(await openIssueWorktree(baseInput(box, run, { repo })).catch((error) => error)).message)
      .toContain("herdr is not installed");

    await expect(openIssueWorktree(baseInput(box, run, { repo: join(box.dir, "missing") })))
      .rejects.toThrow(/not a git repository/);
    await expect(openIssueWorktree(baseInput(box, run, { repo, branchName: null })))
      .rejects.toThrow(/did not provide a branch name/);
    await expect(openIssueWorktree(baseInput(box, run, { repo, agent: "" })))
      .rejects.toThrow(/worktree_agent is not set/);
    await expect(openIssueWorktree(baseInput(box, run, { repo, env: { SSH_CONNECTION: "1 2 3 4", HOME: box.dir } })))
      .rejects.toThrow(/needs a Herdr session/);
    expect(calls).toHaveLength(1);
  });

  test("agent start failure keeps the created worktree and does not send a prompt", async () => {
    const calls: string[][] = [];
    const repo = makeRepo(box);
    const run: WorktreeCommandRunner = async (argv) => {
      calls.push([...argv]);
      const key = argvKey(argv);
      if (key === "herdr worktree list") return listResult([]);
      if (key === "herdr worktree create") return mutateResult("w9", "w9:p1");
      if (key === "herdr agent start") {
        return { code: 1, stdout: JSON.stringify({ error: { message: "pane is not a shell" } }), stderr: "" };
      }
      throw new Error(`unexpected ${argv.join(" ")}`);
    };
    await expect(openIssueWorktree(baseInput(box, run, { repo }))).rejects.toThrow(/pane is not a shell/);
    expect(calls.some((argv) => argv[1] === "worktree" && argv[2] === "remove")).toBe(false);
    expect(calls.some((argv) => argv[2] === "send-text")).toBe(false);
    expect(existsSync(worktreeCheckoutPath(repo, "ENG-42", box.dir))).toBe(false);
  });
});

describe("Herdr command timeouts", () => {
  test("every command class has a bounded timeout and timeout errors stay named", async () => {
    expect(herdrCommandTimeoutMs(herdrWorktreeListArgv("/tmp"))).toBe(HERDR_QUERY_TIMEOUT_MS);
    expect(herdrCommandTimeoutMs(herdrAgentListArgv())).toBe(HERDR_QUERY_TIMEOUT_MS);
    expect(herdrCommandTimeoutMs(herdrPaneSendTextArgv("w1:p1", "hi"))).toBe(HERDR_QUERY_TIMEOUT_MS);
    expect(herdrCommandTimeoutMs(herdrWorkspaceFocusArgv("w1"))).toBe(HERDR_QUERY_TIMEOUT_MS);
    expect(herdrCommandTimeoutMs(herdrWorktreeCreateArgv("/tmp", "branch", "/tmp/x", "ENG-42"))).toBe(HERDR_MUTATE_TIMEOUT_MS);
    expect(herdrCommandTimeoutMs(herdrWorktreeOpenArgv("/tmp", "/tmp/x", "branch", "ENG-42"))).toBe(HERDR_MUTATE_TIMEOUT_MS);
    expect(herdrCommandTimeoutMs(herdrAgentStartArgv("eng-42", "claude", "w1:p1"))).toBe(HERDR_AGENT_START_WAIT_MS);

    const error = expectLinError(await runWorktreeCommand(["sleep", "5"], { timeoutMs: 80 }).catch((item) => item));
    expect(error.exitCode).toBe(EXIT.api);
    expect(error.message).toContain("timed out");
  });
});

describe("TUI Open as worktree", () => {
  test("hides the action until worktree_repo is configured", () => {
    expect(tuiIssueActions(issue, issueTeam(meta, issue)).map((item) => item.id)).toEqual([
      "open", "copy-id", "copy-url", "start", "done", "priority", "comment",
    ]);
    expect(tuiIssueActions(issue, issueTeam(meta, issue), { worktree: true }).map((item) => item.id)).toEqual([
      "worktree", "copy-id", "copy-url", "start", "done", "priority", "comment",
    ]);
    expect(tuiIssueActions(issue, issueTeam(meta, issue), { worktree: true })[0]?.name).toBe("Open as worktree");
  });

  test("runTui config plumbing exposes Open as worktree when worktree_repo and agent are set", async () => {
    const setup = await createTestRenderer({ width: 110, height: 30 });
    const running = runTui(
      { limit: 25, worktreeRepo: "~/src/app", worktreeAgent: "claude" },
      {
        createRenderer: async () => setup.renderer,
        loadMetadata: async () => meta,
        loadIssues: async () => issues,
        loadIssueDetail: async (id) => detailLoader(id),
      },
    );
    try {
      await setup.waitFor(() => setup.renderer.root.getRenderable("tui-root") !== undefined);
      const root = setup.renderer.root.getRenderable("tui-root") as import("@opentui/core").BoxRenderable;
      let names: string[] = [];
      for (let attempt = 0; attempt < 40; attempt++) {
        await setup.flush();
        const list = root.findDescendantById("tui-list") as { options?: { length: number } } | undefined;
        if ((list?.options?.length ?? 0) === 2) break;
        await Bun.sleep(25);
      }
      setup.mockInput.pressKey("k");
      await setup.flush();
      for (let attempt = 0; attempt < 20; attempt++) {
        const actions = root.findDescendantById("tui-actions-list") as import("@opentui/core").SelectRenderable | undefined;
        names = actions?.options.map((option) => option.name) ?? [];
        if (names.includes("Open as worktree")) break;
        await setup.flush();
        await Bun.sleep(20);
      }
      expect(names).toContain("Open as worktree");
      setup.mockInput.pressEscape();
      await setup.flush();
    } finally {
      setup.mockInput.pressKey("q");
      await Promise.race([
        running,
        Bun.sleep(500).then(() => {
          if (!setup.renderer.isDestroyed) setup.renderer.destroy();
        }),
      ]);
    }
  });

  test("right-click and palette dispatch the exact issue and never move Linear state", async () => {
    const opened: string[] = [];
    const moves: string[] = [];
    const setup = await createTestRenderer({ width: 110, height: 30, useMouse: true });
    const app = currentApp = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => issues, async (id) => detailLoader(id)),
      appOptions({
        worktreeRepo: "~/src/app",
        worktreeAgent: "claude",
        moveIssue: async (issueId) => {
          moves.push(issueId);
          return issue.state;
        },
        openWorktree: async (target) => {
          opened.push(target.identifier);
          return { reused: false, created: true, opened: false, workspaceId: "w9", path: "/tmp", branch: target.branchName ?? "" };
        },
      }),
    );
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 2); await setup.flush();
      const second = app.root.findDescendantById("tui-issue-row-APP-4") as import("@opentui/core").BoxRenderable;
      await setup.mockMouse.click(second.screenX + 2, second.screenY, MouseButtons.RIGHT); await setup.flush();
      expect(actionNames(app)[0]).toBe("Open as worktree");
      expect(actionNames(app)).not.toContain("Open in Linear");
      await setup.mockInput.typeText("worktree"); setup.mockInput.pressEnter();
      await setup.waitFor(() => opened.length === 1);
      expect(opened).toEqual(["APP-4"]);
      expect(app.footer.plainText).toContain("Opened APP-4 as worktree");
      expect(moves).toEqual([]);

      setup.mockInput.pressKey("k"); await setup.flush();
      expect((app.root.findDescendantById("tui-actions") as import("@opentui/core").BoxRenderable).title).toBe("APP-4");
      const input = app.root.findDescendantById("tui-actions-search") as import("@opentui/core").InputRenderable;
      input.value = "";
      await setup.mockInput.typeText("worktree"); setup.mockInput.pressEnter();
      await setup.waitFor(() => opened.length === 2);
      expect(opened).toEqual(["APP-4", "APP-4"]);
    } finally { setup.renderer.destroy(); }
  });

  test("header Worktree chip opens the shown issue and o no longer launches Linear", async () => {
    const opened: string[] = [];
    const linear: string[] = [];
    const setup = await createTestRenderer({ width: 110, height: 30, useMouse: true });
    const app = currentApp = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => issues, async (id) => detailLoader(id)),
      appOptions({
        worktreeRepo: "~/src/app",
        worktreeAgent: "claude",
        openExternal: (url) => { linear.push(url); },
        openWorktree: async (target) => {
          opened.push(target.identifier);
          return { reused: false, created: true, opened: false, workspaceId: "w9", path: "/tmp", branch: target.branchName ?? "" };
        },
      }),
    );
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 2); await setup.flush();
      expect(app.openText.plainText).toBe("Worktree ↗");
      await setup.mockMouse.click(app.openChip.screenX, app.openChip.screenY); await setup.flush();
      await setup.waitFor(() => opened.length === 1);
      expect(opened).toEqual(["ENG-42"]);
      expect(linear).toEqual([]);
      setup.mockInput.pressKey("j"); await setup.flush();
      setup.mockInput.pressKey("o"); await setup.flush();
      expect(linear).toEqual([]);
      expect(opened).toEqual(["ENG-42"]);
    } finally { setup.renderer.destroy(); }
  });

  test("footer shows Opening worktree while the opener is pending", async () => {
    let resolveOpen!: (value: WorktreeOpenResult) => void;
    const pending = new Promise<WorktreeOpenResult>((resolve) => { resolveOpen = resolve; });
    const setup = await createTestRenderer({ width: 110, height: 30 });
    const app = currentApp = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => issues, async (id) => detailLoader(id)),
      appOptions({
        worktreeRepo: "~/src/app",
        worktreeAgent: "claude",
        openWorktree: async () => pending,
      }),
    );
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 2); await setup.flush();
      app.openActions(issue); await setup.flush();
      await setup.mockInput.typeText("worktree"); setup.mockInput.pressEnter();
      await setup.waitFor(() => app.footer.plainText.includes("Opening worktree for ENG-42"));
      resolveOpen({ reused: false, created: true, opened: false, workspaceId: "w9", path: "/tmp", branch: issue.branchName ?? "" });
      await setup.waitFor(() => app.footer.plainText.includes("Opened ENG-42 as worktree"));
    } finally { setup.renderer.destroy(); }
  });

  test("remote TUI still stages through the injected opener and keeps the old actions", async () => {
    const opened: string[] = [];
    const setup = await createTestRenderer({ width: 60, height: 28 });
    const app = currentApp = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => issues, async (id) => detailLoader(id)),
      appOptions({
        remote: true,
        worktreeRepo: "~/src/app",
        openWorktree: async (target) => {
          opened.push(target.identifier);
          return { reused: true, created: false, opened: false, workspaceId: "w3", path: "/tmp", branch: target.branchName ?? "" };
        },
      }),
    );
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 2); await setup.flush();
      setup.mockInput.pressKey("k"); await setup.flush();
      const modal = app.root.findDescendantById("tui-actions") as import("@opentui/core").BoxRenderable;
      expect(modal.width).toBeGreaterThan(40);
      expect(actionNames(app)).toEqual(expect.arrayContaining([
        "Open as worktree", "Copy ENG-42", "Copy URL", "Set priority", "Add comment",
      ]));
      expect(actionNames(app)).not.toContain("Open in Linear");
      await setup.mockInput.typeText("worktree"); setup.mockInput.pressEnter();
      await setup.waitFor(() => opened.length === 1);
      expect(opened).toEqual(["ENG-42"]);
      expect(app.footer.plainText).toContain("Focused existing ENG-42 worktree");
    } finally { setup.renderer.destroy(); }
  });

  test("worktree errors land in the footer without creating a checkout", async () => {
    const setup = await createTestRenderer({ width: 110, height: 30 });
    const app = currentApp = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => issues, async (id) => detailLoader(id)),
      appOptions({
        worktreeRepo: makeRepo(box),
        worktreeAgent: "claude",
        worktreeHome: box.dir,
        worktreeEnv: { HERDR_ENV: "1", HOME: box.dir },
        runWorktreeCommand: async () => {
          throw new LinError(EXIT.input, "herdr is not installed", "install herdr or add it to PATH");
        },
      }),
    );
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 2); await setup.flush();
      app.openActions(issue); await setup.flush();
      await setup.mockInput.typeText("worktree"); setup.mockInput.pressEnter();
      await setup.waitFor(() => app.footer.plainText.includes("Could not open worktree"));
      expect(app.footer.plainText).toContain("herdr is not installed");
      expect(existsSync(worktreeCheckoutPath(join(box.dir, "demo-repo"), "ENG-42", box.dir))).toBe(false);
    } finally { setup.renderer.destroy(); }
  });

  test("real opener fails on missing HERDR_ENV without talking to Herdr", async () => {
    const calls: string[][] = [];
    const setup = await createTestRenderer({ width: 110, height: 30 });
    const app = currentApp = new TuiApp(
      setup.renderer,
      new TuiIssueStore(async () => issues, async (id) => detailLoader(id)),
      appOptions({
        worktreeRepo: makeRepo(box),
        worktreeAgent: "claude",
        worktreeHome: box.dir,
        worktreeEnv: { HOME: box.dir },
        runWorktreeCommand: async (argv) => {
          calls.push([...argv]);
          throw new Error("herdr should not run");
        },
      }),
    );
    try {
      app.start(); await setup.waitFor(() => app.list.options.length === 2); await setup.flush();
      app.openActions(issue); await setup.flush();
      await setup.mockInput.typeText("worktree"); setup.mockInput.pressEnter();
      await setup.waitFor(() => app.footer.plainText.includes("needs a Herdr session"));
      expect(app.footer.plainText).toContain("Could not open worktree for ENG-42");
      expect(calls).toEqual([]);
      expect(existsSync(worktreeCheckoutPath(join(box.dir, "demo-repo"), "ENG-42", box.dir))).toBe(false);
    } finally { setup.renderer.destroy(); }
  });
});

describe("worktree source boundary", () => {
  test("does not hardcode a user, repo, agent, or shell", async () => {
    const source = await Bun.file(new URL("../src/tui/worktree.ts", import.meta.url)).text();
    expect(source).not.toContain("sigma-labs");
    expect(source).not.toContain("grok");
    expect(source).not.toContain("/Users/");
    expect(source).not.toContain("/bin/sh");
    expect(source).not.toContain("shell: true");
    expect(source).not.toContain("agent prompt");
  });
});
