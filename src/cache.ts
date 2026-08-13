// The workspace metadata cache: the small vocabularies name resolution needs.
// One request fills it; a 24 hour TTL keeps it honest.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gql, keyFingerprint } from "./client.ts";

export const TTL_MS = 24 * 60 * 60 * 1000;

export interface CachedState {
  id: string;
  name: string;
  type: string;
  position: number;
}

export interface CachedLabel {
  id: string;
  name: string;
  color: string;
  parent: string | null;
}

export interface CachedTeam {
  id: string;
  key: string;
  name: string;
  states: CachedState[];
  labels: CachedLabel[];
}

export interface CachedUser {
  id: string;
  name: string;
  displayName: string;
  email: string;
  active: boolean;
  isMe: boolean;
}

export interface CachedProject {
  id: string;
  slugId: string;
  name: string;
  state: string;
}

export interface CachedTemplate {
  id: string;
  name: string;
  teamId: string | null;
  type: string;
}

export interface Meta {
  fetchedAt: string;
  /**
   * One-way fingerprint of the API key that filled this cache. Two workspaces
   * on one machine must never hand each other's UUIDs to a mutation.
   */
  keyFingerprint: string;
  workspace: { urlKey: string; name: string };
  teams: CachedTeam[];
  users: CachedUser[];
  projects: CachedProject[];
  workspaceLabels: CachedLabel[];
  templates: CachedTemplate[];
}

// --- paths ------------------------------------------------------------------

export function cacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env["XDG_CACHE_HOME"];
  const base = xdg && xdg !== "" ? xdg : join(env["HOME"] ?? homedir(), ".cache");
  return join(base, "lin");
}

export function metaPath(urlKey: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(cacheRoot(env), urlKey, "meta.json");
}

export function isFresh(meta: Meta, now: number = Date.now()): boolean {
  const fetchedAt = Date.parse(meta.fetchedAt);
  return Number.isFinite(fetchedAt) && now - fetchedAt < TTL_MS;
}

// --- reading ----------------------------------------------------------------

function readMeta(path: string): Meta | null {
  try {
    const meta = JSON.parse(readFileSync(path, "utf8")) as Meta;
    return meta.workspace?.urlKey ? meta : null;
  } catch {
    return null;
  }
}

/**
 * The cache path is keyed by workspace, which we do not know until we have
 * asked. Scan instead, and keep only the entry belonging to the current key.
 */
export function readCached(env: NodeJS.ProcessEnv = process.env): Meta | null {
  const root = cacheRoot(env);
  if (!existsSync(root)) return null;

  let fingerprint: string;
  try {
    fingerprint = keyFingerprint(env);
  } catch {
    return null; // no key: nothing to match against
  }

  let newest: Meta | null = null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const meta = readMeta(join(root, entry.name, "meta.json"));
    if (!meta || meta.keyFingerprint !== fingerprint) continue;
    if (!newest || Date.parse(meta.fetchedAt) > Date.parse(newest.fetchedAt)) newest = meta;
  }
  return newest;
}

export function writeCached(meta: Meta, env: NodeJS.ProcessEnv = process.env): string {
  const path = metaPath(meta.workspace.urlKey, env);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  return path;
}

/** Removes every cached workspace. Returns the directories deleted. */
export function clear(env: NodeJS.ProcessEnv = process.env): string[] {
  const root = cacheRoot(env);
  if (!existsSync(root)) return [];

  const removed: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  return removed;
}

// --- warming ----------------------------------------------------------------

// Page sizes are tuned against Linear's 10,000 point single-query complexity
// cap, measured live: this shape costs ~3,000 points. Raising `labels` to 50 or
// `templates` to 20 pushes the estimate over the cap and the request is
// rejected outright, so grow these only with a live check.
export const WARM_QUERY = `query LinWarm {
  viewer { id name displayName email organization { urlKey name } }
  teams(first: 50) {
    nodes {
      id key name
      states(first: 30) { nodes { id name type position } }
      labels(first: 30) { nodes { id name color parent { name } } }
      templates(first: 10) { nodes { id name type } }
    }
  }
  users(first: 100) { nodes { id name displayName email active isMe } }
  projects(first: 100) { nodes { id slugId name status { name } } }
  organization {
    labels(first: 100) { nodes { id name color parent { name } team { id } } }
    templates(first: 20) { nodes { id name type } }
  }
}`;

interface WarmResponse {
  viewer: { id: string; name: string; displayName: string; email: string; organization: { urlKey: string; name: string } };
  teams: {
    nodes: {
      id: string;
      key: string;
      name: string;
      states: { nodes: { id: string; name: string; type: string; position: number }[] };
      labels: { nodes: { id: string; name: string; color: string; parent: { name: string } | null }[] };
      templates: { nodes: { id: string; name: string; type: string }[] };
    }[];
  };
  users: { nodes: { id: string; name: string; displayName: string; email: string; active: boolean; isMe: boolean }[] };
  projects: { nodes: { id: string; slugId: string; name: string; status: { name: string } | null }[] };
  organization: {
    labels: { nodes: { id: string; name: string; color: string; parent: { name: string } | null; team: { id: string } | null }[] };
    templates: { nodes: { id: string; name: string; type: string }[] };
  };
}

export function toMeta(data: WarmResponse, fingerprint: string, now: Date = new Date()): Meta {
  const teams: CachedTeam[] = data.teams.nodes.map((team) => ({
    id: team.id,
    key: team.key,
    name: team.name,
    states: team.states.nodes.map((state) => ({
      id: state.id,
      name: state.name,
      type: state.type,
      position: state.position,
    })),
    labels: team.labels.nodes.map((label) => ({
      id: label.id,
      name: label.name,
      color: label.color,
      parent: label.parent?.name ?? null,
    })),
  }));

  const templates: CachedTemplate[] = [
    ...data.teams.nodes.flatMap((team) =>
      team.templates.nodes.map((template) => ({
        id: template.id,
        name: template.name,
        teamId: team.id,
        type: template.type,
      })),
    ),
    ...data.organization.templates.nodes.map((template) => ({
      id: template.id,
      name: template.name,
      teamId: null,
      type: template.type,
    })),
  ];

  return {
    fetchedAt: now.toISOString(),
    keyFingerprint: fingerprint,
    workspace: data.viewer.organization,
    teams,
    users: data.users.nodes.map((user) => ({
      id: user.id,
      name: user.name,
      displayName: user.displayName,
      email: user.email,
      active: user.active,
      isMe: user.isMe,
    })),
    projects: data.projects.nodes.map((project) => ({
      id: project.id,
      slugId: project.slugId,
      name: project.name,
      // `Project.state` is deprecated in the SDL; `status.name` is the live field.
      state: project.status?.name ?? "",
    })),
    workspaceLabels: data.organization.labels.nodes
      .filter((label) => label.team === null)
      .map((label) => ({
        id: label.id,
        name: label.name,
        color: label.color,
        parent: label.parent?.name ?? null,
      })),
    templates,
  };
}

/** Fetch every vocabulary in one request. Does not write the cache. */
async function fetchMeta(env: NodeJS.ProcessEnv): Promise<Meta> {
  const data = await gql<WarmResponse>(WARM_QUERY, undefined, { env });
  return toMeta(data, keyFingerprint(env));
}

/** Refetch every vocabulary in one request and write it to disk. */
export async function warm(env: NodeJS.ProcessEnv = process.env): Promise<Meta> {
  const meta = await fetchMeta(env);
  writeCached(meta, env);
  return meta;
}

export interface LoadOptions {
  /** `--no-cache`: always refetch. */
  noCache?: boolean;
  env?: NodeJS.ProcessEnv;
}

/** Cached metadata when fresh, otherwise a fresh fetch. */
export async function load(options: LoadOptions = {}): Promise<Meta> {
  const env = options.env ?? process.env;
  if (!options.noCache) {
    const cached = readCached(env);
    if (cached && isFresh(cached)) return cached;
  }
  const meta = await fetchMeta(env);
  try {
    writeCached(meta, env);
  } catch {
    // Sandboxes such as Infisical agent-proxy deny ~/.cache; the fetch still stands.
  }
  return meta;
}
