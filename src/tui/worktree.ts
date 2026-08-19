// Herdr worktree bridge. argv arrays only; Linear state is never mutated here.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { EXIT, LinError } from "../out.ts";

export const HERDR_BIN = "herdr";
export const HERDR_QUERY_TIMEOUT_MS = 15_000;
export const HERDR_MUTATE_TIMEOUT_MS = 60_000;
export const HERDR_AGENT_START_TIMEOUT_MS = 60_000;
export const HERDR_AGENT_START_WAIT_MS = HERDR_AGENT_START_TIMEOUT_MS + 10_000;

export interface WorktreeCommandOutput {
  code: number;
  stdout: string;
  stderr: string;
}

export type WorktreeCommandRunner = (
  argv: readonly string[],
  options?: { timeoutMs?: number },
) => Promise<WorktreeCommandOutput>;

export interface WorktreeIssueInput {
  identifier: string;
  title: string;
  branchName?: string | null;
}

export interface OpenIssueWorktreeInput extends WorktreeIssueInput {
  repo: string;
  agent: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  run: WorktreeCommandRunner;
}

export interface WorktreeOpenResult {
  reused: boolean;
  created: boolean;
  opened: boolean;
  workspaceId: string;
  paneId?: string;
  path: string;
  branch: string;
  agentName?: string;
}

interface HerdrWorktree {
  branch?: string | null;
  path?: string;
  open_workspace_id?: string | null;
  is_linked_worktree?: boolean;
}

interface HerdrAgent {
  name?: string;
  pane_id?: string;
  workspace_id?: string;
  cwd?: string;
  foreground_cwd?: string;
  agent?: string;
  agent_status?: string;
  interactive_ready?: boolean;
}

interface HerdrPane {
  pane_id?: string;
  workspace_id?: string;
  agent?: string;
  agent_status?: string;
  cwd?: string;
  label?: string;
}

interface HerdrForegroundProcess {
  argv0?: string;
  name?: string;
  cwd?: string;
}

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const CONTROL_RUNS = /[\u0000-\u001F\u007F]+/g;
const SHELL_NAMES = new Set(["sh", "bash", "dash", "zsh", "fish", "ksh", "csh", "tcsh"]);

export function expandHomePath(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

export function sanitizeIssueTitle(title: string): string {
  return title.replace(CONTROL_RUNS, " ").replace(/\s+/g, " ").trim();
}

export function issueWorktreeSlug(identifier: string): string {
  const slug = identifier.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(slug)) {
    throw new LinError(
      EXIT.input,
      `issue id ${identifier} is not a valid worktree name`,
      "use a Linear identifier like ENG-42",
    );
  }
  return slug;
}

export function assertGitBranchName(name: string | null | undefined): string {
  const branch = name?.trim() ?? "";
  if (!branch) {
    throw new LinError(
      EXIT.input,
      "Linear did not provide a branch name",
      "refresh the list or run lin issue branch <id>",
    );
  }
  if (CONTROL_CHARS.test(branch) || /[~^:?*[\\\s]/.test(branch)
    || branch.includes("..") || branch.includes("//") || branch.includes("@{")
    || branch.startsWith("-") || branch.startsWith("/") || branch.endsWith("/")
    || branch.endsWith(".lock") || branch === "@") {
    throw new LinError(
      EXIT.input,
      `Linear branch name is not a usable git branch: ${branch}`,
      "fix the suggested branch in Linear; lin will not invent one",
    );
  }
  return branch;
}

export function worktreePrompt(identifier: string, title: string, branchName: string): string {
  return [
    `Work on Linear issue ${identifier}: ${sanitizeIssueTitle(title)}`,
    `Suggested branch name: ${branchName}`,
    `Read the full issue and comments first with \`lin issue view ${identifier} --comments all\`.`,
  ].join(" · ").replace(CONTROL_RUNS, " ").replace(/\s+/g, " ").trim();
}

export function worktreeCheckoutPath(repo: string, identifier: string, home: string): string {
  const repoPath = resolve(expandHomePath(repo.trim(), home));
  return resolve(join(home, ".herdr", "worktrees", basename(repoPath), issueWorktreeSlug(identifier)));
}

export function herdrWorktreeListArgv(cwd: string): string[] {
  return [HERDR_BIN, "worktree", "list", "--cwd", cwd];
}

export function herdrWorktreeCreateArgv(cwd: string, branch: string, path: string, label: string): string[] {
  return [HERDR_BIN, "worktree", "create", "--cwd", cwd, "--branch", branch, "--path", path, "--label", label, "--focus"];
}

export function herdrWorktreeOpenArgv(cwd: string, path: string, branch: string, label: string): string[] {
  return [HERDR_BIN, "worktree", "open", "--cwd", cwd, "--path", path, "--branch", branch, "--label", label, "--focus"];
}

export function herdrAgentListArgv(): string[] {
  return [HERDR_BIN, "agent", "list"];
}

export function herdrPaneListArgv(workspaceId: string): string[] {
  return [HERDR_BIN, "pane", "list", "--workspace", workspaceId];
}

export function herdrPaneProcessInfoArgv(paneId: string): string[] {
  return [HERDR_BIN, "pane", "process-info", "--pane", paneId];
}

export function herdrWorkspaceFocusArgv(workspaceId: string): string[] {
  return [HERDR_BIN, "workspace", "focus", workspaceId];
}

export function herdrAgentFocusArgv(target: string): string[] {
  return [HERDR_BIN, "agent", "focus", target];
}

export function herdrAgentStartArgv(name: string, kind: string, paneId: string): string[] {
  return [HERDR_BIN, "agent", "start", name, "--kind", kind, "--pane", paneId, "--timeout", String(HERDR_AGENT_START_TIMEOUT_MS)];
}

export function herdrPaneSendTextArgv(paneId: string, text: string): string[] {
  return [HERDR_BIN, "pane", "send-text", paneId, text];
}

export function herdrPaneSendKeysArgv(paneId: string): string[] {
  return [HERDR_BIN, "pane", "send-keys", paneId, "left", "right"];
}

export function herdrCommandTimeoutMs(argv: readonly string[]): number {
  const noun = argv[1];
  const verb = argv[2];
  if (noun === "worktree" && (verb === "create" || verb === "open")) return HERDR_MUTATE_TIMEOUT_MS;
  if (noun === "agent" && verb === "start") return HERDR_AGENT_START_WAIT_MS;
  return HERDR_QUERY_TIMEOUT_MS;
}

export async function runWorktreeCommand(
  argv: readonly string[],
  options?: { timeoutMs?: number },
): Promise<WorktreeCommandOutput> {
  if (argv.length === 0) {
    throw new LinError(EXIT.input, "missing command", "pass an argv array");
  }
  const command = argv[0]!;
  const timeoutMs = options?.timeoutMs ?? HERDR_QUERY_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const proc = Bun.spawn([...argv], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      signal: controller.signal,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (controller.signal.aborted) {
      throw new LinError(EXIT.api, `${command} timed out`, "retry, or check that Herdr is responding");
    }
    return { code: code ?? 1, stdout, stderr };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new LinError(EXIT.api, `${command} timed out`, "retry, or check that Herdr is responding");
    }
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT" || /ENOENT|not found/i.test(err.message ?? "")) {
      throw new LinError(EXIT.input, `${command} is not installed`, `install ${command} or add it to PATH`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function unwrapHerdr(text: string, label: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new LinError(EXIT.api, `${label} returned no output`, "check that herdr prints JSON");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new LinError(EXIT.api, `${label} returned invalid JSON`, "check that herdr prints JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new LinError(EXIT.api, `${label} returned invalid JSON`, "check that herdr prints JSON");
  }
  const envelope = parsed as { error?: { message?: string; code?: string }; result?: unknown };
  if (envelope.error) {
    throw new LinError(
      EXIT.api,
      envelope.error.message || `${label} failed`,
      envelope.error.code ? `herdr: ${envelope.error.code}` : "check the Herdr workspace and retry",
    );
  }
  return envelope.result === undefined ? parsed : envelope.result;
}

function herdrFailure(argv: readonly string[], output: WorktreeCommandOutput): LinError {
  const text = `${output.stdout}\n${output.stderr}`.trim();
  if (text) {
    try {
      unwrapHerdr(text, argv.slice(0, 3).join(" "));
    } catch (error) {
      if (error instanceof LinError) return error;
    }
  }
  const detail = (output.stderr.trim() || output.stdout.trim() || `exit ${output.code}`).split("\n")[0] ?? `exit ${output.code}`;
  return new LinError(EXIT.api, `${argv.slice(0, 3).join(" ")} failed: ${detail}`, "check the Herdr workspace and retry");
}

async function herdrJson(run: WorktreeCommandRunner, argv: readonly string[], label: string): Promise<unknown> {
  let output: WorktreeCommandOutput;
  try {
    output = await run(argv, { timeoutMs: herdrCommandTimeoutMs(argv) });
  } catch (error) {
    if (error instanceof LinError) throw error;
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT" || /ENOENT|not found/i.test(String(error))) {
      throw new LinError(EXIT.input, `${HERDR_BIN} is not installed`, `install ${HERDR_BIN} or add it to PATH`);
    }
    throw error;
  }
  if (output.code !== 0) throw herdrFailure(argv, output);
  const text = (output.stdout || output.stderr).trim();
  if (!text) return {};
  return unwrapHerdr(text, label);
}

function requireString(value: unknown, label: string, hint: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LinError(EXIT.api, `Herdr ${label} is missing`, hint);
  }
  return value;
}

function assertAgentKind(agent: string): string {
  const kind = agent.trim();
  if (!kind) {
    throw new LinError(
      EXIT.input,
      "worktree_agent is not set",
      'set worktree_agent in .lin.toml or LIN_WORKTREE_AGENT, for example worktree_agent = "claude"',
    );
  }
  if (CONTROL_CHARS.test(kind) || /\s/.test(kind)) {
    throw new LinError(
      EXIT.input,
      "worktree_agent is not a valid Herdr agent kind",
      "use a single Herdr --kind token from lin config",
    );
  }
  return kind;
}

function assertRepo(repo: string): string {
  const value = repo.trim();
  if (!value) {
    throw new LinError(
      EXIT.input,
      "worktree_repo is not set",
      'set worktree_repo in .lin.toml or LIN_WORKTREE_REPO, for example worktree_repo = "~/src/app"',
    );
  }
  return value;
}

function findTargetWorktree(worktrees: readonly HerdrWorktree[], path: string): HerdrWorktree | undefined {
  return worktrees.find((item) => typeof item.path === "string" && samePath(item.path, path));
}

function shouldFlushBufferedPrompt(agent: HerdrAgent): boolean {
  if (agent.agent_status === "working") return false;
  return agent.agent_status === "idle" || agent.interactive_ready === true;
}

function agentAtCheckout(agents: readonly HerdrAgent[], path: string, kind: string): HerdrAgent | undefined {
  const matches = agents.filter((agent) => {
    const cwd = typeof agent.cwd === "string" ? agent.cwd : undefined;
    const foreground = typeof agent.foreground_cwd === "string" ? agent.foreground_cwd : undefined;
    const atPath = (cwd !== undefined && samePath(cwd, path))
      || (foreground !== undefined && samePath(foreground, path));
    if (!atPath) return false;
    if (agent.agent && agent.agent !== kind) return false;
    return true;
  });
  return matches.find((agent) => agent.agent === kind) ?? matches[0];
}

function candidateShellPanes(panes: readonly HerdrPane[]): HerdrPane[] {
  const shells = panes.filter((pane) => {
    if (!pane.pane_id) return false;
    if (pane.agent) return false;
    const status = pane.agent_status ?? "unknown";
    return status === "unknown" || status === "idle";
  });
  return [...shells].sort((left, right) => {
    const leftRoot = left.pane_id?.endsWith(":p1") ? 0 : 1;
    const rightRoot = right.pane_id?.endsWith(":p1") ? 0 : 1;
    return leftRoot - rightRoot;
  });
}

function processBaseName(value: string): string {
  const trimmed = value.trim();
  const bare = trimmed.startsWith("-") ? trimmed.slice(1) : trimmed;
  return (bare.split("/").pop() ?? "").toLowerCase();
}

function isSafeShellProcess(value: unknown): boolean {
  const info = (value as { process_info?: { foreground_processes?: HerdrForegroundProcess[] } } | undefined)?.process_info;
  if (!info) return false;
  const processes = Array.isArray(info.foreground_processes) ? info.foreground_processes : [];
  if (processes.length === 0) return true;
  return processes.every((process) => {
    const names = [process.name, process.argv0].filter((item): item is string => typeof item === "string" && item !== "");
    return names.some((name) => SHELL_NAMES.has(processBaseName(name)));
  });
}

async function pickProcessSafePane(
  run: WorktreeCommandRunner,
  panes: readonly HerdrPane[],
): Promise<HerdrPane> {
  const candidates = candidateShellPanes(panes);
  for (const pane of candidates) {
    try {
      const info = await herdrJson(run, herdrPaneProcessInfoArgv(pane.pane_id!), "herdr pane process-info");
      if (isSafeShellProcess(info)) return pane;
    } catch (error) {
      if (!(error instanceof LinError)) throw error;
    }
  }
  throw new LinError(
    EXIT.api,
    "no process-safe shell pane in the existing worktree",
    "focus an idle shell pane in that workspace, or close the busy pane and retry",
  );
}

function workspaceIdOf(value: unknown): string {
  const workspace = (value as { workspace?: { workspace_id?: string } } | undefined)?.workspace;
  return requireString(workspace?.workspace_id, "workspace id", "check that herdr worktree create/open returned a workspace");
}

function rootPaneIdOf(value: unknown): string {
  const pane = (value as { root_pane?: { pane_id?: string } } | undefined)?.root_pane;
  return requireString(pane?.pane_id, "root pane id", "check that herdr worktree create/open returned a root pane");
}

function startedAgentIdentity(value: unknown, fallbackName: string, fallbackPaneId: string): { name: string; paneId: string } {
  const agent = value && typeof value === "object" ? (value as { agent?: HerdrAgent }).agent : undefined;
  const name = typeof agent?.name === "string" && agent.name.trim() !== "" ? agent.name.trim() : fallbackName;
  const paneId = typeof agent?.pane_id === "string" && agent.pane_id.trim() !== "" ? agent.pane_id.trim() : fallbackPaneId;
  return { name, paneId };
}

async function startAndStage(
  input: OpenIssueWorktreeInput,
  workspaceId: string,
  paneId: string,
  slug: string,
  prompt: string,
  kind: string,
): Promise<{ paneId: string; agentName: string }> {
  const started = await herdrJson(input.run, herdrAgentStartArgv(slug, kind, paneId), "herdr agent start");
  const identity = startedAgentIdentity(started, slug, paneId);
  await herdrJson(input.run, herdrWorkspaceFocusArgv(workspaceId), "herdr workspace focus");
  await herdrJson(input.run, herdrAgentFocusArgv(identity.name), "herdr agent focus");
  await herdrJson(input.run, herdrPaneSendTextArgv(identity.paneId, prompt), "herdr pane send-text");
  await herdrJson(input.run, herdrPaneSendKeysArgv(identity.paneId), "herdr pane send-keys");
  return { paneId: identity.paneId, agentName: identity.name };
}

export async function openIssueWorktree(input: OpenIssueWorktreeInput): Promise<WorktreeOpenResult> {
  const identifier = input.identifier.trim();
  if (!identifier) {
    throw new LinError(EXIT.input, "issue identifier is missing", "select an issue first");
  }
  const slug = issueWorktreeSlug(identifier);
  const branch = assertGitBranchName(input.branchName);
  const repo = assertRepo(input.repo);
  const kind = assertAgentKind(input.agent);
  const env = input.env ?? process.env;
  if (!env.HERDR_ENV) {
    throw new LinError(
      EXIT.input,
      "Open as worktree needs a Herdr session",
      "run lin tui inside Herdr so HERDR_ENV is set",
    );
  }
  const home = input.home ?? (env.HOME && env.HOME !== "" ? env.HOME : homedir());
  const repoPath = resolve(expandHomePath(repo, home));
  if (!existsSync(join(repoPath, ".git"))) {
    throw new LinError(
      EXIT.input,
      `worktree_repo is not a git repository: ${repoPath}`,
      "point worktree_repo at a checkout that contains .git",
    );
  }
  const path = worktreeCheckoutPath(repo, identifier, home);
  if (samePath(path, repoPath)) {
    throw new LinError(
      EXIT.input,
      `worktree path collides with the primary checkout: ${path}`,
      "point worktree_repo at the main git checkout, not a linked worktree path",
    );
  }
  const prompt = worktreePrompt(identifier, input.title, branch);
  const listed = await herdrJson(input.run, herdrWorktreeListArgv(repoPath), "herdr worktree list") as {
    worktrees?: HerdrWorktree[];
  };
  const worktrees = Array.isArray(listed.worktrees) ? listed.worktrees : [];
  const existing = findTargetWorktree(worktrees, path);
  if (existing) {
    const existingBranch = existing.branch?.trim() ?? "";
    if (existingBranch && existingBranch !== branch) {
      throw new LinError(
        EXIT.input,
        `worktree ${path} is on ${existingBranch}, not ${branch}`,
        "remove that checkout or fix the Linear suggested branch before retrying",
      );
    }
    if (existing.is_linked_worktree === false) {
      throw new LinError(
        EXIT.input,
        `worktree path is the primary checkout: ${path}`,
        "lin only reuses the exact linked worktree path for this issue",
      );
    }
  }
  const existingPath = path;
  const openWorkspaceId = existing?.open_workspace_id?.trim() || undefined;

  if (existing && openWorkspaceId) {
    const listedAgents = await herdrJson(input.run, herdrAgentListArgv(), "herdr agent list") as {
      agents?: HerdrAgent[];
    };
    const agents = Array.isArray(listedAgents.agents) ? listedAgents.agents : [];
    const existingAgent = agentAtCheckout(agents, existingPath, kind);
    if (existingAgent) {
      await herdrJson(input.run, herdrWorkspaceFocusArgv(openWorkspaceId), "herdr workspace focus");
      const target = existingAgent.name?.trim() || existingAgent.pane_id?.trim();
      if (target) {
        await herdrJson(input.run, herdrAgentFocusArgv(target), "herdr agent focus");
      }
      const paneId = existingAgent.pane_id?.trim();
      if (paneId && shouldFlushBufferedPrompt(existingAgent)) {
        await herdrJson(input.run, herdrPaneSendKeysArgv(paneId), "herdr pane send-keys");
      }
      return {
        reused: true,
        created: false,
        opened: false,
        workspaceId: openWorkspaceId,
        paneId: existingAgent.pane_id,
        path: existingPath,
        branch: existing.branch ?? branch,
        agentName: existingAgent.name,
      };
    }
    const listedPanes = await herdrJson(input.run, herdrPaneListArgv(openWorkspaceId), "herdr pane list") as {
      panes?: HerdrPane[];
    };
    const pane = await pickProcessSafePane(input.run, Array.isArray(listedPanes.panes) ? listedPanes.panes : []);
    const started = await startAndStage(input, openWorkspaceId, pane.pane_id!, slug, prompt, kind);
    return {
      reused: false,
      created: false,
      opened: true,
      workspaceId: openWorkspaceId,
      paneId: started.paneId,
      path: existingPath,
      branch: existing.branch ?? branch,
      agentName: started.agentName,
    };
  }

  const mutateArgv = existing
    ? herdrWorktreeOpenArgv(repoPath, existingPath, branch, identifier)
    : herdrWorktreeCreateArgv(repoPath, branch, path, identifier);
  const mutated = await herdrJson(
    input.run,
    mutateArgv,
    existing ? "herdr worktree open" : "herdr worktree create",
  );
  const workspaceId = workspaceIdOf(mutated);
  const paneId = rootPaneIdOf(mutated);
  const started = await startAndStage(input, workspaceId, paneId, slug, prompt, kind);
  return {
    reused: false,
    created: !existing,
    opened: Boolean(existing),
    workspaceId,
    paneId: started.paneId,
    path: existingPath,
    branch,
    agentName: started.agentName,
  };
}
