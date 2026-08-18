// The workspace metadata cache: the small vocabularies name resolution needs.
// A first-page warm query plus follow-up pages fill every connection; a 24 hour
// TTL keeps it honest.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gql, keyFingerprint } from "./client.ts";
import { LinError } from "./out.ts";
import { missingCursor, repeatedCursor, tooManyPages, walkPages, type PageInfo } from "./page.ts";

export const TTL_MS = 24 * 60 * 60 * 1000;

export interface CachedState {
  id: string;
  name: string;
  type: string;
  position: number;
  /** Optional so caches written before state colors were captured remain valid. */
  color?: string;
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

// First-page sizes stay inside Linear's 10,000 point single-query cap
// (~3,000 points live). Remaining pages are fetched one connection at a time
// so a large workspace cannot drop entities and cannot blow the cap.
const PAGE = {
  teams: 50,
  states: 30,
  labels: 30,
  templates: 10,
  users: 100,
  projects: 100,
  orgLabels: 100,
  orgTemplates: 20,
} as const;

const PAGE_INFO = "pageInfo { hasNextPage endCursor }";

export const WARM_QUERY = `query LinWarm {
  viewer { id name displayName email organization { urlKey name } }
  teams(first: ${PAGE.teams}) {
    nodes {
      id key name
      states(first: ${PAGE.states}) { nodes { id name type position color } ${PAGE_INFO} }
      labels(first: ${PAGE.labels}) { nodes { id name color parent { name } } ${PAGE_INFO} }
      templates(first: ${PAGE.templates}) { nodes { id name type } ${PAGE_INFO} }
    }
    ${PAGE_INFO}
  }
  users(first: ${PAGE.users}) { nodes { id name displayName email active isMe } ${PAGE_INFO} }
  projects(first: ${PAGE.projects}) { nodes { id slugId name status { name } } ${PAGE_INFO} }
  organization {
    labels(first: ${PAGE.orgLabels}) { nodes { id name color parent { name } team { id } } ${PAGE_INFO} }
    templates(first: ${PAGE.orgTemplates}) { nodes { id name type } ${PAGE_INFO} }
  }
}`;

const WARM_TEAMS_QUERY = `query LinCacheTeams($after: String) {
  teams(first: ${PAGE.teams}, after: $after) {
    nodes {
      id key name
      states(first: ${PAGE.states}) { nodes { id name type position color } ${PAGE_INFO} }
      labels(first: ${PAGE.labels}) { nodes { id name color parent { name } } ${PAGE_INFO} }
      templates(first: ${PAGE.templates}) { nodes { id name type } ${PAGE_INFO} }
    }
    ${PAGE_INFO}
  }
}`;

const WARM_USERS_QUERY = `query LinCacheUsers($after: String) {
  users(first: ${PAGE.users}, after: $after) { nodes { id name displayName email active isMe } ${PAGE_INFO} }
}`;

const WARM_PROJECTS_QUERY = `query LinCacheProjects($after: String) {
  projects(first: ${PAGE.projects}, after: $after) { nodes { id slugId name status { name } } ${PAGE_INFO} }
}`;

const WARM_ORG_LABELS_QUERY = `query LinCacheOrgLabels($after: String) {
  organization { labels(first: ${PAGE.orgLabels}, after: $after) { nodes { id name color parent { name } team { id } } ${PAGE_INFO} } }
}`;

const WARM_ORG_TEMPLATES_QUERY = `query LinCacheOrgTemplates($after: String) {
  organization { templates(first: ${PAGE.orgTemplates}, after: $after) { nodes { id name type } ${PAGE_INFO} } }
}`;

const WARM_TEAM_STATES_QUERY = `query LinCacheTeamStates($id: String!, $after: String) {
  team(id: $id) { states(first: 50, after: $after) { nodes { id name type position color } ${PAGE_INFO} } }
}`;

const WARM_TEAM_LABELS_QUERY = `query LinCacheTeamLabels($id: String!, $after: String) {
  team(id: $id) { labels(first: 50, after: $after) { nodes { id name color parent { name } } ${PAGE_INFO} } }
}`;

const WARM_TEAM_TEMPLATES_QUERY = `query LinCacheTeamTemplates($id: String!, $after: String) {
  team(id: $id) { templates(first: 50, after: $after) { nodes { id name type } ${PAGE_INFO} } }
}`;

interface NestedPageInfo {
  hasNextPage?: boolean;
  endCursor?: string | null;
}

interface Connection<T> {
  nodes: T[];
  pageInfo?: NestedPageInfo;
}

interface WarmState {
  id: string;
  name: string;
  type: string;
  position: number;
  color: string;
}

interface WarmLabel {
  id: string;
  name: string;
  color: string;
  parent: { name: string } | null;
  team?: { id: string } | null;
}

interface WarmTemplate {
  id: string;
  name: string;
  type: string;
}

interface WarmTeam {
  id: string;
  key: string;
  name: string;
  states: Connection<WarmState>;
  labels: Connection<WarmLabel>;
  templates: Connection<WarmTemplate>;
}

interface WarmUser {
  id: string;
  name: string;
  displayName: string;
  email: string;
  active: boolean;
  isMe: boolean;
}

interface WarmProject {
  id: string;
  slugId: string;
  name: string;
  status: { name: string } | null;
}

interface WarmResponse {
  viewer: { id: string; name: string; displayName: string; email: string; organization: { urlKey: string; name: string } };
  teams: Connection<WarmTeam>;
  users: Connection<WarmUser>;
  projects: Connection<WarmProject>;
  organization: {
    labels: Connection<WarmLabel>;
    templates: Connection<WarmTemplate>;
  };
}

function cacheMissingCursor(): LinError {
  return missingCursor("cache pagination cursor missing", "retry lin cache warm");
}

function cacheRepeatedCursor(): LinError {
  return repeatedCursor("cache pagination cursor repeated", "retry lin cache warm");
}

function asPage<T>(connection: Connection<T>): { nodes: T[]; pageInfo: PageInfo } {
  return {
    nodes: connection.nodes,
    pageInfo: {
      hasNextPage: connection.pageInfo?.hasNextPage === true,
      endCursor: typeof connection.pageInfo?.endCursor === "string" ? connection.pageInfo.endCursor : null,
    },
  };
}

async function completeConnection<T>(
  first: Connection<T>,
  fetchPage: (after: string) => Promise<Connection<T>>,
): Promise<T[]> {
  const walked = await walkPages(
    asPage(first),
    async (after) => asPage(await fetchPage(after)),
    null,
    {
      missing: cacheMissingCursor(),
      repeated: cacheRepeatedCursor(),
      tooMany: tooManyPages("cache pagination exceeded maximum pages", "retry lin cache warm"),
    },
  );
  return walked.nodes;
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
      color: state.color,
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

async function completeTeam(team: WarmTeam, env: NodeJS.ProcessEnv): Promise<WarmTeam> {
  return {
    ...team,
    states: {
      nodes: await completeConnection(team.states, async (after) => {
        const data = await gql<{ team: { states: Connection<WarmState> } }>(
          WARM_TEAM_STATES_QUERY,
          { id: team.id, after },
          { env },
        );
        return data.team.states;
      }),
    },
    labels: {
      nodes: await completeConnection(team.labels, async (after) => {
        const data = await gql<{ team: { labels: Connection<WarmLabel> } }>(
          WARM_TEAM_LABELS_QUERY,
          { id: team.id, after },
          { env },
        );
        return data.team.labels;
      }),
    },
    templates: {
      nodes: await completeConnection(team.templates, async (after) => {
        const data = await gql<{ team: { templates: Connection<WarmTemplate> } }>(
          WARM_TEAM_TEMPLATES_QUERY,
          { id: team.id, after },
          { env },
        );
        return data.team.templates;
      }),
    },
  };
}

/** Fetch every vocabulary, following pageInfo until each connection is complete. */
async function fetchMeta(env: NodeJS.ProcessEnv): Promise<Meta> {
  const first = await gql<WarmResponse>(WARM_QUERY, undefined, { env });

  const teamPages = await completeConnection(first.teams, async (after) => {
    const data = await gql<{ teams: Connection<WarmTeam> }>(WARM_TEAMS_QUERY, { after }, { env });
    return data.teams;
  });
  const teams: WarmTeam[] = [];
  for (const team of teamPages) teams.push(await completeTeam(team, env));

  const users = await completeConnection(first.users, async (after) => {
    const data = await gql<{ users: Connection<WarmUser> }>(WARM_USERS_QUERY, { after }, { env });
    return data.users;
  });
  const projects = await completeConnection(first.projects, async (after) => {
    const data = await gql<{ projects: Connection<WarmProject> }>(WARM_PROJECTS_QUERY, { after }, { env });
    return data.projects;
  });
  const orgLabels = await completeConnection(first.organization.labels, async (after) => {
    const data = await gql<{ organization: { labels: Connection<WarmLabel> } }>(
      WARM_ORG_LABELS_QUERY,
      { after },
      { env },
    );
    return data.organization.labels;
  });
  const orgTemplates = await completeConnection(first.organization.templates, async (after) => {
    const data = await gql<{ organization: { templates: Connection<WarmTemplate> } }>(
      WARM_ORG_TEMPLATES_QUERY,
      { after },
      { env },
    );
    return data.organization.templates;
  });

  return toMeta(
    {
      viewer: first.viewer,
      teams: { nodes: teams },
      users: { nodes: users },
      projects: { nodes: projects },
      organization: { labels: { nodes: orgLabels }, templates: { nodes: orgTemplates } },
    },
    keyFingerprint(env),
  );
}

/** Refetch every vocabulary, paginating each connection, then write once. */
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
