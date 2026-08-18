// owned by: project agent
// project list / view / create / update / post / posts.
//
// This file also holds the helpers the rest of the structure domain shares:
// body input, cell clipping, percentages, dates, health words, and the two
// lookups resolve.ts does not cover (initiatives and project statuses).
// milestone.ts, cycle.ts, initiative.ts and doc.ts import from here and nothing
// here imports from them, so the import graph stays acyclic.

import { readFileSync } from "node:fs";
import { gql } from "../client.ts";
import { DEFAULT_LIMIT } from "../config.ts";
import { changed, created, EXIT, LinError, record, table, type Change, type Row } from "../out.ts";
import { defineCommand, flagString, type Flags } from "../registry.ts";
import { resolveProject, resolveTeam, resolveUser } from "../resolve.ts";

// --- shared helpers ---------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(ref: string): boolean {
  return UUID.test(ref);
}

/** The 8-char handle Linear uses for status updates; ours for milestones too. */
export function shortRef(id: string): string {
  return id.slice(0, 8);
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    throw new LinError(EXIT.input, "nothing to read on stdin", "pipe the text in, or pass it inline or as @file");
  }
}

/** Body flags take inline text, `@file`, or `-` for stdin. */
export function readBody(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value === "-") return readStdin();
  if (!value.startsWith("@")) return value;

  const path = value.slice(1);
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new LinError(EXIT.input, `cannot read ${path}`, "pass inline text, @file, or - for stdin");
  }
}

const WHITESPACE = /\s+/g;

/** A table cell is one line: collapse whitespace, then clip. */
export function clip(text: string, max = 100): string {
  const flat = text.replace(WHITESPACE, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max).trimEnd()}...`;
}

/** Progress reads as a percentage. Callers scale it: Linear is inconsistent. */
export function percent(value: number): string {
  return `${Math.round(value)}%`;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Read a date flag, rejecting anything that is not YYYY-MM-DD. */
export function dateFlag(flags: Flags, name: string): string | undefined {
  const value = flagString(flags, name);
  if (value === undefined) return undefined;
  if (!DATE.test(value)) {
    throw new LinError(
      EXIT.input,
      `--${name} needs a YYYY-MM-DD date, got "${value}"`,
      `example: --${name} 2026-09-30`,
    );
  }
  return value;
}

/** Midnight UTC on a calendar date, for the DateTime fields cycles use. */
export function startOfDay(date: string): string {
  return `${date}T00:00:00.000Z`;
}

// Health is `on-track` on the command line and `onTrack` in the API. Project
// and initiative status updates share the same three values.
const HEALTH: Record<string, string> = {
  "on-track": "onTrack",
  "at-risk": "atRisk",
  "off-track": "offTrack",
};

export function healthEnum(word: string): string {
  const value = HEALTH[word.toLowerCase()];
  if (value === undefined) {
    throw new LinError(EXIT.input, `"${word}" is not a health value`, `health: ${Object.keys(HEALTH).join(", ")}`);
  }
  return value;
}

/** The inverse, so a printed health value can go straight back into --health. */
export function healthWord(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  return Object.keys(HEALTH).find((word) => HEALTH[word] === value) ?? value;
}

/** Only the fields whose read-back value actually moved. */
export function diff(before: Row, after: Row): Change[] {
  const changes: Change[] = [];
  for (const [field, from] of Object.entries(before)) {
    const to = after[field];
    if ((from ?? "") !== (to ?? "")) changes.push({ field, from, to });
  }
  return changes;
}

/** `content: none -> 340 chars` — a body diff without reprinting the body. */
export function contentChange(before: string | null, after: string | null): Change | undefined {
  const from = before ?? "";
  const to = after ?? "";
  if (from === to) return undefined;
  return {
    field: "content",
    from: from === "" ? "" : `${from.length} chars`,
    to: to === "" ? "" : `${to.length} chars`,
  };
}

export function limitOf(limit: number | undefined): number {
  return limit ?? DEFAULT_LIMIT;
}

// --- initiative lookup ------------------------------------------------------
// resolve.ts has no initiative helper. Initiatives are few, so one page answers
// by id, slug or name and supplies the candidate list on a miss.

export const INITIATIVE_LOOKUP_QUERY = `query LinInitiativeLookup($first: Int!) {
  initiatives(first: $first) { nodes { id slugId name } }
}`;

interface InitiativeLookupResponse {
  initiatives: { nodes: { id: string; slugId: string; name: string }[] };
}

export async function resolveInitiativeId(ref: string): Promise<string> {
  if (isUuid(ref)) return ref;

  const data = await gql<InitiativeLookupResponse>(INITIATIVE_LOOKUP_QUERY, { first: 100 });
  const wanted = ref.toLowerCase();
  const matches = data.initiatives.nodes.filter(
    (node) => node.slugId.toLowerCase() === wanted || node.name.toLowerCase() === wanted,
  );

  const [first] = matches;
  if (matches.length === 1 && first !== undefined) return first.id;
  if (matches.length > 1) {
    throw new LinError(
      EXIT.input,
      `initiative "${ref}" is ambiguous`,
      `matches: ${matches.map((node) => node.slugId).join(", ")}`,
    );
  }
  throw new LinError(
    EXIT.input,
    `no initiative "${ref}"`,
    `initiatives: ${data.initiatives.nodes.map((node) => node.name).join(", ")}`,
  );
}

// --- project status lookup --------------------------------------------------
// `Project.state` is deprecated: a project's state is a workspace-level
// ProjectStatus, and writes need its id.

export const PROJECT_STATUSES_QUERY = `query LinProjectStatuses {
  projectStatuses(first: 50) { nodes { id name } }
}`;

interface ProjectStatusesResponse {
  projectStatuses: { nodes: { id: string; name: string }[] };
}

export async function resolveProjectStatus(name: string): Promise<{ id: string; name: string }> {
  const data = await gql<ProjectStatusesResponse>(PROJECT_STATUSES_QUERY);
  const match = data.projectStatuses.nodes.find((status) => status.name.toLowerCase() === name.toLowerCase());
  if (!match) {
    throw new LinError(
      EXIT.input,
      `no project state "${name}"`,
      `states: ${data.projectStatuses.nodes.map((status) => status.name).join(", ")}`,
    );
  }
  return match;
}

/** Every team key a `--team` flag carries. The global flag is not repeatable. */
export function teamRefs(team: string | undefined): string[] {
  return (team ?? "")
    .split(",")
    .map((ref) => ref.trim())
    .filter((ref) => ref !== "");
}

/** The positional a command cannot run without. */
export function requireArg(args: readonly string[], index: number, message: string, hint: string): string {
  const value = args[index];
  if (value === undefined || value === "") throw new LinError(EXIT.input, message, hint);
  return value;
}

// --- project list -----------------------------------------------------------

const LIST_COLUMNS = ["id", "name", "state", "lead", "target"];

export const LIST_QUERY = `query LinProjectList($filter: ProjectFilter, $first: Int, $after: String) {
  projects(filter: $filter, first: $first, after: $after, orderBy: updatedAt) {
    nodes { slugId name status { name } lead { displayName } targetDate }
  }
}`;

interface ListResponse {
  projects: {
    nodes: {
      slugId: string;
      name: string;
      status: { name: string } | null;
      lead: { displayName: string } | null;
      targetDate: string | null;
    }[];
  };
}

export const projectList = defineCommand({
  name: "project list",
  group: "project",
  summary: "list projects",
  fields: LIST_COLUMNS,
  flags: {
    initiative: { type: "string", valueHint: "ref", doc: "only projects in this initiative" },
    state: { type: "string", valueHint: "name", doc: "only projects in this status" },
  },
  examples: ["lin project list --team ENG", "lin project list --state Planned"],
  async run({ flags, config }) {
    const filter: Row = {};

    if (config.team) {
      const team = await resolveTeam(config.team);
      filter["accessibleTeams"] = { some: { id: { eq: team.id } } };
    }

    const initiative = flagString(flags, "initiative");
    if (initiative !== undefined) {
      filter["initiatives"] = { some: { id: { eq: await resolveInitiativeId(initiative) } } };
    }

    const state = flagString(flags, "state");
    if (state !== undefined) {
      filter["status"] = { id: { eq: (await resolveProjectStatus(state)).id } };
    }

    const data = await gql<ListResponse>(LIST_QUERY, {
      filter,
      first: limitOf(config.limit),
      after: flagString(flags, "after"),
    });

    table(
      "projects",
      data.projects.nodes.map((node) => ({
        id: node.slugId,
        name: node.name,
        state: node.status?.name,
        lead: node.lead?.displayName,
        target: node.targetDate,
      })),
      LIST_COLUMNS,
    );
  },
});

// --- project view -----------------------------------------------------------

export const MILESTONE_COLUMNS = ["id", "name", "target", "progress"];
export const POST_COLUMNS = ["date", "author", "health", "body"];

export const VIEW_QUERY = `query LinProjectView($id: String!) {
  project(id: $id) {
    slugId name url content progress health startDate targetDate updatedAt
    status { name }
    lead { displayName }
    teams(first: 10) { nodes { key } }
    projectMilestones(first: 50) { nodes { id name targetDate progress } }
    projectUpdates(first: 3) { nodes { createdAt health body user { displayName } } }
  }
}`;

export interface MilestoneNode {
  id: string;
  name: string;
  targetDate: string | null;
  progress: number;
}

export interface PostNode {
  createdAt: string;
  health: string | null;
  body: string;
  user: { displayName: string } | null;
}

interface ViewResponse {
  project: {
    slugId: string;
    name: string;
    url: string;
    content: string | null;
    progress: number;
    health: string | null;
    startDate: string | null;
    targetDate: string | null;
    updatedAt: string;
    status: { name: string } | null;
    lead: { displayName: string } | null;
    teams: { nodes: { key: string }[] };
    projectMilestones: { nodes: MilestoneNode[] };
    projectUpdates: { nodes: PostNode[] };
  };
}

/** Milestone rows, shared with `milestone list`. */
export function milestoneRows(nodes: readonly MilestoneNode[]): Row[] {
  return nodes.map((node) => ({
    id: shortRef(node.id),
    name: node.name,
    target: node.targetDate,
    // ProjectMilestone.progress is already 0-100, unlike Project.progress.
    progress: percent(node.progress),
  }));
}

/** Status-post rows, shared with `project posts` and `initiative posts`. */
export function postRows(nodes: readonly PostNode[]): Row[] {
  return nodes.map((node) => ({
    date: node.createdAt,
    author: node.user?.displayName,
    health: healthWord(node.health),
    body: clip(node.body),
  }));
}

export const projectView = defineCommand({
  name: "project view",
  group: "project",
  summary: "show a project with its milestones and last 3 status posts",
  args: [{ name: "project", doc: "project name, slug id, or UUID", required: true }],
  examples: ["lin project view Onboarding"],
  async run({ args }) {
    const ref = requireArg(args, 0, "project view needs a project", "example: lin project view Onboarding");

    const project = await resolveProject(ref);
    const data = await gql<ViewResponse>(VIEW_QUERY, { id: project.id });
    const node = data.project;

    record(
      {
        id: node.slugId,
        name: node.name,
        state: node.status?.name,
        health: healthWord(node.health),
        lead: node.lead?.displayName,
        teams: node.teams.nodes.map((team) => team.key),
        start: node.startDate,
        target: node.targetDate,
        progress: percent(node.progress * 100),
        updated: node.updatedAt,
        url: node.url,
      },
      {
        body: node.content ?? undefined,
        children: [
          { key: "milestones", rows: milestoneRows(node.projectMilestones.nodes), columns: MILESTONE_COLUMNS },
          { key: "posts", rows: postRows(node.projectUpdates.nodes), columns: POST_COLUMNS },
        ],
      },
    );
  },
});

// --- project create / update ------------------------------------------------

const WRITE_FLAGS = {
  name: { type: "string", valueHint: "text", doc: "project name" },
  body: { type: "string", short: "d", valueHint: "text|@file|-", doc: "project content as markdown" },
  lead: { type: "string", valueHint: "user", doc: "project lead" },
  target: { type: "string", valueHint: "YYYY-MM-DD", doc: "target date" },
  state: { type: "string", valueHint: "name", doc: "project status" },
} as const;

export const CREATE_MUTATION = `mutation LinProjectCreate($input: ProjectCreateInput!) {
  projectCreate(input: $input) { project { slugId url } }
}`;

interface CreateResponse {
  projectCreate: { project: { slugId: string; url: string } | null };
}

/** The fields create and update share; the caller adds the required ones. */
async function writeInput(flags: Flags): Promise<Row> {
  const input: Row = {};

  const name = flagString(flags, "name");
  if (name !== undefined) input["name"] = name;

  const content = readBody(flagString(flags, "body"));
  if (content !== undefined) input["content"] = content;

  const lead = flagString(flags, "lead");
  if (lead !== undefined) input["leadId"] = (await resolveUser(lead)).id;

  const target = dateFlag(flags, "target");
  if (target !== undefined) input["targetDate"] = target;

  const state = flagString(flags, "state");
  if (state !== undefined) input["statusId"] = (await resolveProjectStatus(state)).id;

  return input;
}

export const projectCreate = defineCommand({
  name: "project create",
  group: "project",
  summary: "create a project",
  flags: WRITE_FLAGS,
  examples: [
    'lin project create --name "Onboarding" --team ENG',
    'lin project create --name "Billing" --team ENG,DES --target 2026-09-30 -d @brief.md',
  ],
  async run({ flags, config }) {
    const name = flagString(flags, "name");
    if (name === undefined) {
      throw new LinError(EXIT.input, "project create needs a name", 'pass --name "Project name"');
    }

    // resolveTeam(undefined) owns the "no team given" message.
    const refs = teamRefs(config.team);
    const teams =
      refs.length === 0 ? [await resolveTeam(undefined)] : await Promise.all(refs.map((ref) => resolveTeam(ref)));

    const data = await gql<CreateResponse>(
      CREATE_MUTATION,
      { input: { ...(await writeInput(flags)), name, teamIds: teams.map((team) => team.id) } },
      { retry: false },
    );

    const project = data.projectCreate.project;
    if (!project) throw new LinError(EXIT.api, "the project was not created");
    created(project.slugId, project.url);
  },
});

export const BEFORE_QUERY = `query LinProjectBefore($id: String!, $withContent: Boolean!) {
  project(id: $id) {
    name targetDate
    status { name }
    lead { displayName }
    content @include(if: $withContent)
  }
}`;

export const UPDATE_MUTATION = `mutation LinProjectUpdate($id: String!, $input: ProjectUpdateInput!, $withContent: Boolean!) {
  projectUpdate(id: $id, input: $input) {
    project {
      slugId name targetDate
      status { name }
      lead { displayName }
      content @include(if: $withContent)
    }
  }
}`;

interface ProjectFields {
  name: string;
  targetDate: string | null;
  status: { name: string } | null;
  lead: { displayName: string } | null;
  content?: string | null;
}

interface BeforeResponse {
  project: ProjectFields;
}

interface UpdateResponse {
  projectUpdate: { project: (ProjectFields & { slugId: string }) | null };
}

function projectRow(fields: ProjectFields): Row {
  return {
    name: fields.name,
    state: fields.status?.name,
    lead: fields.lead?.displayName,
    target: fields.targetDate,
  };
}

export const projectUpdate = defineCommand({
  name: "project update",
  group: "project",
  summary: "edit a project's fields",
  args: [{ name: "project", doc: "project name, slug id, or UUID", required: true }],
  flags: WRITE_FLAGS,
  examples: ["lin project update Onboarding --state Completed", "lin project update Onboarding --lead alex"],
  async run({ args, flags }) {
    const ref = requireArg(
      args,
      0,
      "project update needs a project",
      "example: lin project update Onboarding --lead alex",
    );

    const project = await resolveProject(ref);
    const input = await writeInput(flags);
    if (Object.keys(input).length === 0) {
      throw new LinError(
        EXIT.input,
        "project update needs at least one field",
        "flags: --name, --body, --lead, --target, --state",
      );
    }

    // Content is read back only when it is being written: it is the long field.
    const withContent = input["content"] !== undefined;
    const before = await gql<BeforeResponse>(BEFORE_QUERY, { id: project.id, withContent });
    const data = await gql<UpdateResponse>(UPDATE_MUTATION, { id: project.id, input, withContent }, { retry: false });

    const after = data.projectUpdate.project;
    if (!after) throw new LinError(EXIT.api, "the project was not updated");

    const changes = diff(projectRow(before.project), projectRow(after));
    if (withContent) {
      const change = contentChange(before.project.content ?? null, after.content ?? null);
      if (change) changes.push(change);
    }
    changed(after.slugId, changes);
  },
});

// --- project post / posts ---------------------------------------------------

export const POST_MUTATION = `mutation LinProjectPost($input: ProjectUpdateCreateInput!) {
  projectUpdateCreate(input: $input) { projectUpdate { slugId url } }
}`;

interface PostResponse {
  projectUpdateCreate: { projectUpdate: { slugId: string; url: string } };
}

export const projectPost = defineCommand({
  name: "project post",
  group: "project",
  summary: "post a project status update",
  args: [{ name: "project", doc: "project name, slug id, or UUID", required: true }],
  flags: {
    health: { type: "string", valueHint: "on-track|at-risk|off-track", doc: "project health" },
    message: { type: "string", short: "m", valueHint: "text|@file|-", doc: "the post body" },
  },
  examples: ['lin project post Onboarding --health on-track -m "Beta is out"'],
  async run({ args, flags }) {
    const ref = requireArg(
      args,
      0,
      "project post needs a project",
      'example: lin project post Onboarding -m "shipped"',
    );

    const body = readBody(flagString(flags, "message"));
    if (body === undefined) {
      throw new LinError(EXIT.input, "project post needs a message", 'pass -m "text", -m @file, or -m -');
    }

    const health = flagString(flags, "health");
    const project = await resolveProject(ref);

    const data = await gql<PostResponse>(
      POST_MUTATION,
      { input: { projectId: project.id, body, ...(health !== undefined && { health: healthEnum(health) }) } },
      { retry: false },
    );

    const post = data.projectUpdateCreate.projectUpdate;
    created(post.slugId, post.url);
  },
});

export const POSTS_QUERY = `query LinProjectPosts($id: String!, $first: Int) {
  project(id: $id) {
    projectUpdates(first: $first) { nodes { createdAt health body user { displayName } } }
  }
}`;

interface PostsResponse {
  project: { projectUpdates: { nodes: PostNode[] } };
}

export const projectPosts = defineCommand({
  name: "project posts",
  group: "project",
  summary: "list a project's status updates, newest first",
  fields: POST_COLUMNS,
  args: [{ name: "project", doc: "project name, slug id, or UUID", required: true }],
  examples: ["lin project posts Onboarding", "lin project posts Onboarding -n 10"],
  async run({ args, config }) {
    const ref = requireArg(args, 0, "project posts needs a project", "example: lin project posts Onboarding");

    const project = await resolveProject(ref);
    const data = await gql<PostsResponse>(POSTS_QUERY, { id: project.id, first: limitOf(config.limit) });
    table("posts", postRows(data.project.projectUpdates.nodes), POST_COLUMNS);
  },
});
