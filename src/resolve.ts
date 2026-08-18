// Exact, case-insensitive name resolution against the metadata cache.
// A miss refreshes the cache once, then fails with the candidate list — we
// never fuzzy-match silently, because a near miss becomes a wrong write.

import {
  isFresh,
  load,
  readCached,
  type CachedLabel,
  type CachedProject,
  type CachedState,
  type CachedTeam,
  type CachedTemplate,
  type CachedUser,
  type Meta,
} from "./cache.ts";
import { gql } from "./client.ts";
import { EXIT, LinError } from "./out.ts";

export interface ResolveOptions {
  noCache?: boolean;
  env?: NodeJS.ProcessEnv;
}

const MAX_CANDIDATES = 30;

function candidateHint(label: string, candidates: readonly string[]): string | undefined {
  const unique = [...new Set(candidates.filter((candidate) => candidate !== ""))];
  if (unique.length === 0) return undefined;
  const shown = unique.slice(0, MAX_CANDIDATES).join(", ");
  const extra = unique.length - MAX_CANDIDATES;
  return extra > 0 ? `${label}: ${shown} (+${extra} more)` : `${label}: ${shown}`;
}

const eq = (a: string | null | undefined, b: string): boolean =>
  typeof a === "string" && a.toLowerCase() === b.toLowerCase();

interface Selection<T> {
  matches: T[];
  candidates: string[];
}

/**
 * Run `select` against cached metadata; on an empty result refresh once and try
 * again, so a name added minutes ago still resolves.
 */
async function lookup<T>(
  select: (meta: Meta) => Selection<T>,
  problem: { missing: string; ambiguous: string; label: string },
  options: ResolveOptions,
): Promise<T> {
  const env = options.env ?? process.env;
  const cached = options.noCache ? null : readCached(env);
  const usedCache = cached !== null && isFresh(cached);

  let meta = usedCache ? (cached as Meta) : await load({ env, noCache: options.noCache });
  let selection = select(meta);

  if (selection.matches.length === 0 && usedCache) {
    meta = await load({ env, noCache: true });
    selection = select(meta);
  }

  const [first] = selection.matches;
  if (selection.matches.length === 1 && first !== undefined) return first;

  if (selection.matches.length === 0) {
    throw new LinError(EXIT.input, problem.missing, candidateHint(problem.label, selection.candidates));
  }
  throw new LinError(EXIT.input, problem.ambiguous, candidateHint("matches", selection.candidates));
}

// --- team -------------------------------------------------------------------

/** Hint for a missing default team: list teams, then flag or config. */
export const MISSING_TEAM_HINT =
  'run lin team list, then pass --team ENG or add team = "ENG" to .lin.toml';

export async function resolveTeam(ref: string | undefined, options: ResolveOptions = {}): Promise<CachedTeam> {
  if (ref === undefined || ref === "") {
    throw new LinError(EXIT.input, "no team given", MISSING_TEAM_HINT);
  }

  return lookup<CachedTeam>(
    (meta) => ({
      matches: meta.teams.filter((team) => eq(team.key, ref) || eq(team.name, ref)),
      candidates: meta.teams.map((team) => team.key),
    }),
    { missing: `no team "${ref}"`, ambiguous: `team "${ref}" is ambiguous`, label: "teams" },
    options,
  );
}

// --- workflow states --------------------------------------------------------

export async function resolveState(
  teamRef: string | undefined,
  name: string,
  options: ResolveOptions = {},
): Promise<CachedState> {
  const team = await resolveTeam(teamRef, options);
  return lookup<CachedState>(
    (meta) => {
      const current = meta.teams.find((candidate) => candidate.id === team.id) ?? team;
      return {
        matches: current.states.filter((state) => eq(state.name, name)),
        candidates: current.states.map((state) => state.name),
      };
    },
    {
      missing: `team ${team.key} has no state "${name}"`,
      ambiguous: `team ${team.key} has more than one state "${name}"`,
      label: "states",
    },
    options,
  );
}

/**
 * The first state of a workflow type, by board position. `start`, `done` and
 * `triage` key off type, never off state names, because names are per-team.
 */
export async function resolveStateByType(
  teamRef: string | undefined,
  type: string,
  options: ResolveOptions = {},
): Promise<CachedState> {
  const team = await resolveTeam(teamRef, options);
  return lookup<CachedState>(
    (meta) => {
      const current = meta.teams.find((candidate) => candidate.id === team.id) ?? team;
      const matches = current.states
        .filter((state) => eq(state.type, type))
        .sort((a, b) => a.position - b.position);
      return {
        // Several states can share a type; the lowest position is the entry point.
        matches: matches.length > 0 && matches[0] !== undefined ? [matches[0]] : [],
        candidates: [...new Set(current.states.map((state) => state.type))],
      };
    },
    {
      missing: `team ${team.key} has no state of type "${type}"`,
      ambiguous: `team ${team.key} has more than one state of type "${type}"`,
      label: "state types",
    },
    options,
  );
}

// --- users ------------------------------------------------------------------

export async function resolveUser(ref: string, options: ResolveOptions = {}): Promise<CachedUser> {
  const wantsSelf = ref.toLowerCase() === "me";

  return lookup<CachedUser>(
    (meta) => ({
      matches: wantsSelf
        ? meta.users.filter((user) => user.isMe)
        : meta.users.filter(
            (user) => eq(user.displayName, ref) || eq(user.name, ref) || eq(user.email, ref),
          ),
      candidates: meta.users.filter((user) => user.active).map((user) => user.displayName),
    }),
    {
      missing: wantsSelf ? "the API key has no matching workspace user" : `no user "${ref}"`,
      ambiguous: `user "${ref}" is ambiguous`,
      label: "users",
    },
    options,
  );
}

// --- labels -----------------------------------------------------------------

/**
 * Team labels plus workspace labels. `group/label` selects inside a label
 * group; a bare name matches on the label name alone.
 */
export async function resolveLabel(
  teamRef: string | null | undefined,
  name: string,
  options: ResolveOptions = {},
): Promise<CachedLabel> {
  const team = teamRef ? await resolveTeam(teamRef, options) : null;

  const slash = name.indexOf("/");
  const group = slash === -1 ? null : name.slice(0, slash);
  const leaf = slash === -1 ? name : name.slice(slash + 1);

  return lookup<CachedLabel>(
    (meta) => {
      const teamLabels = team
        ? (meta.teams.find((candidate) => candidate.id === team.id)?.labels ?? [])
        : meta.teams.flatMap((candidate) => candidate.labels);
      const pool = [...teamLabels, ...meta.workspaceLabels];

      return {
        matches: pool.filter(
          (label) => eq(label.name, leaf) && (group === null || eq(label.parent, group)),
        ),
        candidates: pool.map((label) => (label.parent ? `${label.parent}/${label.name}` : label.name)),
      };
    },
    {
      missing: team ? `team ${team.key} has no label "${name}"` : `no label "${name}"`,
      ambiguous: `label "${name}" is ambiguous, qualify it as group/label`,
      label: "labels",
    },
    options,
  );
}

// --- projects ---------------------------------------------------------------

export async function resolveProject(ref: string, options: ResolveOptions = {}): Promise<CachedProject> {
  return lookup<CachedProject>(
    (meta) => ({
      matches: meta.projects.filter(
        (project) => project.id === ref || eq(project.slugId, ref) || eq(project.name, ref),
      ),
      candidates: meta.projects.map((project) => project.name),
    }),
    { missing: `no project "${ref}"`, ambiguous: `project "${ref}" is ambiguous`, label: "projects" },
    options,
  );
}

// --- templates --------------------------------------------------------------

export async function resolveTemplate(
  ref: string,
  teamRef?: string | null,
  options: ResolveOptions = {},
): Promise<CachedTemplate> {
  const team = teamRef ? await resolveTeam(teamRef, options) : null;

  return lookup<CachedTemplate>(
    (meta) => {
      // Workspace templates (teamId null) are usable from any team.
      const pool = team
        ? meta.templates.filter((template) => template.teamId === team.id || template.teamId === null)
        : meta.templates;
      return {
        matches: pool.filter((template) => template.id === ref || eq(template.name, ref)),
        candidates: pool.map((template) => template.name),
      };
    },
    { missing: `no template "${ref}"`, ambiguous: `template "${ref}" is ambiguous`, label: "templates" },
    options,
  );
}

// --- cycles -----------------------------------------------------------------

export interface ResolvedCycle {
  id: string;
  number: number;
  name: string | null;
  startsAt: string;
  endsAt: string;
}

export const CYCLES_QUERY = `query LinCycles($teamId: String!) {
  team(id: $teamId) {
    activeCycle { id number }
    cycles(first: 250) { nodes { id number name startsAt endsAt } }
  }
}`;

interface CyclesResponse {
  team: {
    activeCycle: { id: string; number: number } | null;
    cycles: { nodes: ResolvedCycle[] };
  };
}

/**
 * Cycles move every week or two, so they are fetched live rather than cached.
 * `current`, `next` and `previous` are relative to the team's active cycle.
 */
export async function resolveCycle(
  teamRef: string | undefined,
  ref: string | number,
  options: ResolveOptions = {},
): Promise<ResolvedCycle> {
  const team = await resolveTeam(teamRef, options);
  const data = await gql<CyclesResponse>(CYCLES_QUERY, { teamId: team.id }, { env: options.env });
  const cycles = data.team.cycles.nodes;
  const active = data.team.activeCycle;

  const keyword = typeof ref === "string" ? ref.toLowerCase() : String(ref);
  let wanted: number;

  if (keyword === "current" || keyword === "next" || keyword === "previous") {
    if (!active) {
      throw new LinError(
        EXIT.input,
        `team ${team.key} has no active cycle`,
        "pass a cycle number instead of current/next/previous",
      );
    }
    wanted = active.number + (keyword === "next" ? 1 : keyword === "previous" ? -1 : 0);
  } else {
    const parsed = Number(ref);
    if (!Number.isFinite(parsed)) {
      throw new LinError(
        EXIT.input,
        `"${ref}" is not a cycle`,
        "use current, next, previous, or a cycle number",
      );
    }
    wanted = parsed;
  }

  const match = cycles.find((cycle) => cycle.number === wanted);
  if (!match) {
    throw new LinError(
      EXIT.input,
      `team ${team.key} has no cycle ${wanted}`,
      candidateHint("cycles", cycles.map((cycle) => String(cycle.number))),
    );
  }
  return match;
}

// --- issue identifiers ------------------------------------------------------

export const ISSUE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISSUE_URL = /^https?:\/\/(?:www\.)?linear\.app\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)/i;

/** The `ENG-42` inside an identifier or a Linear issue URL, if there is one. */
export function issueIdentifierFrom(ref: string): string | undefined {
  const fromUrl = ISSUE_URL.exec(ref)?.[1];
  if (fromUrl) return fromUrl.toUpperCase();
  return ISSUE_IDENTIFIER.test(ref) ? ref.toUpperCase() : undefined;
}

/** `[A-Z]+-\d+` taken from a git branch name, for `lin done` with no argument. */
export function issueIdentifierFromBranch(branch: string): string | undefined {
  return /([A-Za-z][A-Za-z0-9]*-\d+)/.exec(branch)?.[1]?.toUpperCase();
}

export const ISSUE_UUID_QUERY = `query LinIssueId($id: String!) {
  issue(id: $id) { id identifier }
}`;

/**
 * Mutations take UUIDs. Identifiers and URLs cost one extra lookup; a UUID
 * passes straight through.
 */
export async function resolveIssueUUID(ref: string, options: ResolveOptions = {}): Promise<string> {
  if (UUID.test(ref)) return ref;

  const identifier = issueIdentifierFrom(ref);
  if (!identifier) {
    throw new LinError(
      EXIT.input,
      `"${ref}" is not an issue identifier, URL, or UUID`,
      "use a form like ENG-42, https://linear.app/<workspace>/issue/ENG-42, or the issue UUID",
    );
  }

  const data = await gql<{ issue: { id: string } }>(
    ISSUE_UUID_QUERY,
    { id: identifier },
    { env: options.env },
  );
  return data.issue.id;
}
