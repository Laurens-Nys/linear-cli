// owned by: issue agent
// The issue core: list, view, create, update, branch, url.
//
// The helpers at the top are shared with comment.ts and aliases.ts. They live
// here rather than in a fourth module because ownership is per file and a
// shared module would be a foundation file; the dependency only ever points
// this way, so there is no import cycle.

import { readFileSync } from "node:fs";
import { gql } from "../client.ts";
import type { Config } from "../config.ts";
import {
  changed,
  created,
  EXIT,
  line,
  LinError,
  PRIORITY_WORDS,
  priorityNumber,
  record,
  selectColumns,
  table,
  type Change,
  type MoreInfo,
  type Row,
} from "../out.ts";
import { collectPages, type PageInfo } from "../page.ts";
import {
  defineCommand,
  flagBool,
  flagList,
  flagNumber,
  flagString,
  type Flags,
  type FlagSpec,
} from "../registry.ts";
import {
  issueIdentifierFrom,
  resolveCycle,
  resolveIssueUUID,
  resolveLabel,
  resolveProject,
  resolveState,
  resolveTeam,
  resolveTemplate,
  resolveUser,
  type ResolveOptions,
} from "../resolve.ts";

// --- shared helpers ---------------------------------------------------------

const DEFAULT_LIMIT = 50;
/** Linear's cap on one issueBatchUpdate. */
const BATCH_MAX = 50;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** `--no-cache`, threaded into every resolver call. */
export function resolveOptions(flags: Flags): ResolveOptions {
  return { noCache: flagBool(flags, "no-cache") };
}

export function limitOf(config: Config): number {
  return config.limit ?? DEFAULT_LIMIT;
}

/** Dates are YYYY-MM-DD everywhere, in and out. */
function dateFlag(flags: Flags, name: string): string | undefined {
  const value = flagString(flags, name);
  if (value === undefined) return undefined;
  if (!DATE_ONLY.test(value)) {
    throw new LinError(
      EXIT.input,
      `--${name} expects YYYY-MM-DD, got "${value}"`,
      `example: --${name} 2026-08-15`,
    );
  }
  return value;
}

/** Priorities are words in and words out; Linear stores them as 0-4. */
function priorityFlag(flags: Flags): number | undefined {
  const word = flagString(flags, "priority");
  if (word === undefined) return undefined;
  const value = priorityNumber(word);
  if (value === undefined) {
    throw new LinError(EXIT.input, `"${word}" is not a priority`, `priorities: ${PRIORITY_WORDS.join(", ")}`);
  }
  return value;
}

/** One line, no runs of whitespace: prose that has to fit a table cell. */
export function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** `-d text`, `-d @file`, or `-d -` to read stdin. */
export async function bodyInput(value: string | undefined): Promise<string | undefined> {
  if (value === undefined) return undefined;
  if (value === "-") return Bun.stdin.text();
  if (value.startsWith("@")) {
    const path = value.slice(1);
    try {
      return readFileSync(path, "utf8");
    } catch {
      throw new LinError(
        EXIT.input,
        `cannot read ${path}`,
        "pass the text inline, @path to a readable file, or - to read stdin",
      );
    }
  }
  return value;
}

function quoteArg(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

const CONTINUATION_SKIP = new Set(["after", "help", "version", "all-pages"]);

function flagParts(flags: Flags): string[] {
  const parts: string[] = [];
  for (const [flag, value] of Object.entries(flags)) {
    if (CONTINUATION_SKIP.has(flag)) continue;
    if (value === true) parts.push(`--${flag}`);
    else if (Array.isArray(value)) for (const item of value) parts.push(`--${flag} ${quoteArg(item)}`);
    else if (typeof value !== "boolean") parts.push(`--${flag} ${quoteArg(String(value))}`);
  }
  return parts;
}

/**
 * The exact command that fetches the next page: this invocation's arguments and
 * flags, with the cursor appended.
 */
export function continuation(
  name: string,
  args: readonly string[],
  flags: Flags,
  cursor: string,
): string {
  return [`lin ${name}`, ...args.map(quoteArg), ...flagParts(flags), `--after ${cursor}`].join(" ");
}

/**
 * Rerun this invocation with `--all-pages`. Search projects/docs have no
 * user-facing cursor, so the hint must not invent `--after` or duplicate flags.
 */
export function allPagesContinuation(name: string, args: readonly string[], flags: Flags): string {
  return [`lin ${name}`, ...args.map(quoteArg), ...flagParts(flags), "--all-pages"].join(" ");
}

export type { PageInfo };
export { collectPages };

/**
 * The continuation comment line. Plain connections carry no total, so callers
 * pass no count and the line reads `# more · <command>`. Search payloads do
 * know the total, and then the count is exact.
 */
export function morePages(
  pageInfo: PageInfo,
  count: number | undefined,
  command: (cursor: string) => string,
): MoreInfo | undefined {
  if (!pageInfo.hasNextPage || !pageInfo.endCursor) return undefined;
  if (count !== undefined && count <= 0) return undefined;
  return { count, command: command(pageInfo.endCursor) };
}

// --- comments (shared with comment.ts) --------------------------------------

const COMMENT_BODY_CLIP = 100;
export const COMMENT_COLUMNS = ["ref", "author", "date", "body"] as const;
export const COMMENT_SELECTION = "id createdAt body resolvedAt user { displayName } botActor { name }";

export interface CommentNode {
  id: string;
  createdAt: string;
  body: string;
  resolvedAt: string | null;
  user: { displayName: string } | null;
  botActor: { name: string } | null;
}

/** A comment ref is the first 8 hex characters of its UUID. */
export function commentRef(id: string): string {
  return id.slice(0, 8);
}

export function commentRows(nodes: readonly CommentNode[]): Row[] {
  return nodes.map((node) => {
    const body = clip(collapse(node.body), COMMENT_BODY_CLIP);
    return {
      ref: commentRef(node.id),
      author: node.user?.displayName ?? node.botActor?.name ?? "",
      date: node.createdAt,
      // A resolved thread is marked in the body rather than in a fifth column,
      // which would cost an empty cell on every row of every thread.
      body: node.resolvedAt === null ? body : `${body} (resolved)`,
    };
  });
}

// --- issue list -------------------------------------------------------------

export const ISSUE_COLUMNS = ["id", "title", "state", "assignee", "priority", "updated"] as const;
/** `--mine` and `lin ls` already know the assignee. */
export const MINE_COLUMNS = ["id", "title", "state", "priority", "updated"] as const;
/** Optional `--fields` for issue list / ls; selected only when requested. */
export const ISSUE_OPTIONAL_FIELDS = ["parent", "project", "labels", "blockers", "url"] as const;
const LIST_LABEL_PAGE = 10;
const LIST_BLOCKER_PAGE = 20;

interface NestedPage {
  hasNextPage?: boolean;
}

export interface IssueListNode {
  identifier: string;
  title: string;
  state: { name: string };
  assignee?: { displayName: string } | null;
  priority: number;
  updatedAt: string;
  url?: string;
  parent?: { identifier: string } | null;
  project?: { name: string } | null;
  labels?: { nodes: { name: string; parent: { name: string } | null }[]; pageInfo?: NestedPage };
  inverseRelations?: { nodes: { type: string }[]; pageInfo?: NestedPage };
}

export interface IssueListResponse {
  issues: { nodes: IssueListNode[]; pageInfo: PageInfo };
}

/** Linear rejects `sort` and `orderBy` together, so every sort goes through `sort`. */
export const SORTS: Record<string, unknown> = {
  updated: { updatedAt: { order: "Descending" } },
  created: { createdAt: { order: "Descending" } },
  priority: { priority: { order: "Ascending" } },
  manual: { manual: { order: "Ascending" } },
};

function sortInput(flags: Flags): unknown[] {
  const name = flagString(flags, "sort") ?? "updated";
  const sort = SORTS[name];
  if (sort === undefined) {
    throw new LinError(EXIT.input, `"${name}" is not a sort`, `sorts: ${Object.keys(SORTS).join(", ")}`);
  }
  return [sort];
}

/** Anything not completed and not canceled. Keyed off type, never state names. */
export const OPEN_STATES = { type: { nin: ["completed", "canceled"] } };

export function listDocument(withAssignee: boolean, extras: ReadonlySet<string> = new Set()): string {
  // parent/project/url are cheap objects. labels and inverseRelations are
  // capped so a 50-row page stays well under the 10,000 point query cap.
  // Both carry pageInfo so a truncated nested page cannot look exact.
  const extra = [
    extras.has("url") ? " url" : "",
    extras.has("parent") ? " parent { identifier }" : "",
    extras.has("project") ? " project { name }" : "",
    extras.has("labels")
      ? ` labels(first: ${LIST_LABEL_PAGE}) { nodes { name parent { name } } pageInfo { hasNextPage } }`
      : "",
    extras.has("blockers")
      ? ` inverseRelations(first: ${LIST_BLOCKER_PAGE}) { nodes { type } pageInfo { hasNextPage } }`
      : "",
  ].join("");

  return `query LinIssueList($filter: IssueFilter, $first: Int!, $after: String, $sort: [IssueSortInput!], $archived: Boolean) {
  issues(filter: $filter, first: $first, after: $after, sort: $sort, includeArchived: $archived) {
    nodes { identifier title state { name }${withAssignee ? " assignee { displayName }" : ""} priority updatedAt${extra} }
    pageInfo { hasNextPage endCursor }
  }
}`;
}

/** Label groups read as `group/label`, the form `--label` accepts back. */
function labelName(label: { name: string; parent: { name: string } | null }): string {
  return label.parent ? `${label.parent.name}/${label.name}` : label.name;
}

/** `…` marks a truncated label page so a capped list cannot look complete. */
function labelCell(labels: IssueListNode["labels"]): string[] {
  const names = labels?.nodes.map(labelName) ?? [];
  if (labels?.pageInfo?.hasNextPage === true) names.push("…");
  return names;
}

/**
 * inverseRelations is a mixed page (blocks, related, …). An exact count from a
 * capped page would silently undercount, so a truncated page prints `N+`.
 */
export function blockerCell(relations: IssueListNode["inverseRelations"]): number | string {
  const count = relations?.nodes.filter((relation) => relation.type === "blocks").length ?? 0;
  return relations?.pageInfo?.hasNextPage === true ? `${count}+` : count;
}

export function listRows(nodes: readonly IssueListNode[]): Row[] {
  return nodes.map((node) => ({
    id: node.identifier,
    title: node.title,
    state: node.state.name,
    assignee: node.assignee?.displayName,
    priority: node.priority,
    updated: node.updatedAt,
    parent: node.parent?.identifier,
    project: node.project?.name,
    labels: labelCell(node.labels),
    blockers: blockerCell(node.inverseRelations),
    url: node.url,
  }));
}

/** `--label Bug` matches on the name; `--label Priority/P0` names the group too. */
function labelFilter(name: string): unknown {
  const slash = name.indexOf("/");
  if (slash === -1) return { labels: { some: { name: { eqIgnoreCase: name } } } };
  return {
    labels: {
      some: {
        name: { eqIgnoreCase: name.slice(slash + 1) },
        parent: { name: { eqIgnoreCase: name.slice(0, slash) } },
      },
    },
  };
}

const ASSIGNEE_FLAGS = ["mine", "assignee", "unassigned"] as const;

async function assigneeFilter(flags: Flags): Promise<unknown | undefined> {
  const chosen = ASSIGNEE_FLAGS.filter((name) => flags[name] !== undefined);
  if (chosen.length > 1) {
    throw new LinError(
      EXIT.input,
      `${chosen.map((name) => `--${name}`).join(" and ")} filter the same field`,
      "pick one of --mine, --assignee, --unassigned",
    );
  }

  if (flagBool(flags, "mine")) return { isMe: { eq: true } };
  if (flagBool(flags, "unassigned")) return { null: true };

  const ref = flagString(flags, "assignee");
  if (ref === undefined) return undefined;
  // Resolved rather than matched by name: `--assignee casey` is a displayName,
  // and an unknown name has to come back as exit 2 with the candidates.
  const user = await resolveUser(ref, resolveOptions(flags));
  return { id: { eq: user.id } };
}

export const listCommand = defineCommand({
  name: "issue list",
  group: "issue",
  summary: "list issues in a team, filtered by assignee, state, label, project or cycle",
  allPages: true,
  fields: ISSUE_COLUMNS,
  extra: ISSUE_OPTIONAL_FIELDS,
  flags: {
    mine: { type: "boolean", doc: "only issues assigned to me" },
    assignee: { type: "string", valueHint: "name", doc: "only issues assigned to this user" },
    unassigned: { type: "boolean", doc: "only issues with no assignee" },
    state: { type: "string", valueHint: "name", doc: "only issues in this workflow state" },
    label: {
      type: "repeatable",
      valueHint: "name",
      doc: "only issues carrying this label; repeat to require all of them",
    },
    project: { type: "string", valueHint: "name", doc: "only issues in this project" },
    cycle: { type: "string", valueHint: "current|next|previous|N", doc: "only issues in this cycle" },
    parent: { type: "string", valueHint: "id", doc: "only sub-issues of this issue" },
    "updated-since": { type: "string", valueHint: "YYYY-MM-DD", doc: "only issues updated on or after this date" },
    "created-since": { type: "string", valueHint: "YYYY-MM-DD", doc: "only issues created on or after this date" },
    archived: { type: "boolean", doc: "include archived issues" },
    sort: { type: "string", valueHint: "updated|created|priority|manual", doc: "sort order (default updated)" },
  },
  examples: [
    "lin issue list --team ENG",
    "lin issue list --mine --state Todo",
    "lin issue list --team ENG --label Bug --label Priority/P0",
  ],
  async run({ flags, config }) {
    const options = resolveOptions(flags);
    const mine = flagBool(flags, "mine");
    const defaults = mine ? MINE_COLUMNS : ISSUE_COLUMNS;
    const columns = selectColumns(defaults, ISSUE_OPTIONAL_FIELDS);
    const extras = new Set(ISSUE_OPTIONAL_FIELDS.filter((field) => columns.includes(field)));
    const assigneeRef = flagString(flags, "assignee");
    const projectRef = flagString(flags, "project");
    const scoped = mine || assigneeRef !== undefined || projectRef !== undefined;

    // Without a team and without a scope this would sweep the workspace, so
    // resolveTeam(undefined) is left to report the missing --team.
    const team = config.team !== undefined || !scoped ? await resolveTeam(config.team, options) : undefined;

    const filter: Record<string, unknown> = {};
    if (team) filter["team"] = { id: { eq: team.id } };

    const assignee = await assigneeFilter(flags);
    if (assignee) filter["assignee"] = assignee;

    const stateName = flagString(flags, "state");
    const archived = flagBool(flags, "archived");
    if (stateName !== undefined) {
      filter["state"] = team
        ? { id: { eq: (await resolveState(team.key, stateName, options)).id } }
        : { name: { eqIgnoreCase: stateName } };
    } else if (!archived) {
      filter["state"] = OPEN_STATES;
    }

    // Every label is its own clause, so repeating --label requires all of them.
    const labels = flagList(flags, "label");
    if (labels.length > 0) filter["and"] = labels.map(labelFilter);

    if (projectRef !== undefined) {
      filter["project"] = { id: { eq: (await resolveProject(projectRef, options)).id } };
    }

    const cycleRef = flagString(flags, "cycle");
    if (cycleRef !== undefined) {
      filter["cycle"] = { id: { eq: (await resolveCycle(config.team, cycleRef, options)).id } };
    }

    // `id` comparators take ENG-42 as readily as a UUID, so no lookup is needed.
    const parentRef = flagString(flags, "parent");
    if (parentRef !== undefined) filter["parent"] = { id: { eq: issueIdentifierFrom(parentRef) ?? parentRef } };

    const updatedSince = dateFlag(flags, "updated-since");
    if (updatedSince !== undefined) filter["updatedAt"] = { gte: updatedSince };
    const createdSince = dateFlag(flags, "created-since");
    if (createdSince !== undefined) filter["createdAt"] = { gte: createdSince };

    const first = limitOf(config);
    const after = flagString(flags, "after") ?? null;
    const page = await collectPages(
      async (cursor) => {
        const data = await gql<IssueListResponse>(listDocument(!mine, extras), {
          filter,
          first,
          after: cursor,
          sort: sortInput(flags),
          archived,
        });
        return data.issues;
      },
      after,
      flagBool(flags, "all-pages"),
    );

    table("issues", listRows(page.nodes), mine ? MINE_COLUMNS : ISSUE_COLUMNS, {
      extra: ISSUE_OPTIONAL_FIELDS,
      more: morePages(page.pageInfo, undefined, (cursor) => continuation("issue list", [], flags, cursor)),
    });
  },
});

// --- issue view -------------------------------------------------------------

const RELATION_LIMIT = 20;
const ALL_COMMENTS = 100;

function viewDocument(options: { body: boolean; comments: number }): string {
  const comments =
    options.comments > 0 ? `\n    comments(last: ${options.comments}) { nodes { ${COMMENT_SELECTION} } }` : "";
  return `query LinIssueView($id: String!) {
  issue(id: $id) {
    identifier title priority estimate dueDate createdAt updatedAt url${options.body ? " description" : ""}
    state { name } assignee { displayName } team { key } parent { identifier }
    labels(first: ${RELATION_LIMIT}) { nodes { name parent { name } } }
    relations(first: ${RELATION_LIMIT}) { nodes { type relatedIssue { identifier } } }
    inverseRelations(first: ${RELATION_LIMIT}) { nodes { type issue { identifier } } }
    attachments(first: ${RELATION_LIMIT}) { nodes { title url } }
    cycle { number } project { name } projectMilestone { name }${comments}
  }
}`;
}

interface ViewResponse {
  issue: {
    identifier: string;
    title: string;
    priority: number;
    estimate: number | null;
    dueDate: string | null;
    createdAt: string;
    updatedAt: string;
    url: string;
    description?: string | null;
    state: { name: string };
    assignee: { displayName: string } | null;
    team: { key: string };
    parent: { identifier: string } | null;
    labels: { nodes: { name: string; parent: { name: string } | null }[] };
    relations: { nodes: { type: string; relatedIssue: { identifier: string } }[] };
    inverseRelations: { nodes: { type: string; issue: { identifier: string } }[] };
    attachments: { nodes: { title: string | null; url: string }[] };
    cycle: { number: number } | null;
    project: { name: string } | null;
    projectMilestone: { name: string } | null;
    comments?: { nodes: CommentNode[] };
  };
}

/** `--comments N`, `--comments all`, or the default of the last 3. */
function commentCount(value: string | undefined): number {
  if (value === undefined) return 3;
  if (value.toLowerCase() === "all") return ALL_COMMENTS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new LinError(
      EXIT.input,
      `--comments expects a number or "all", got "${value}"`,
      "example: --comments 10",
    );
  }
  return Math.min(parsed, ALL_COMMENTS);
}

export const viewCommand = defineCommand({
  name: "issue view",
  group: "issue",
  summary: "show one issue: fields, description, and its most recent comments",
  args: [{ name: "id", doc: "issue identifier, URL or UUID", required: true }],
  flags: {
    comments: { type: "string", valueHint: "N|all", doc: "how many comments to show (default 3)" },
    "no-body": { type: "boolean", doc: "skip the description" },
  },
  examples: ["lin issue view ENG-42", "lin ENG-42 --comments all", "lin issue view ENG-42 --no-body"],
  async run({ args, flags }) {
    const id = issueArg(args, "issue view");
    const comments = commentCount(flagString(flags, "comments"));
    const data = await gql<ViewResponse>(viewDocument({ body: !flagBool(flags, "no-body"), comments }), { id });
    const issue = data.issue;

    const blocks = issue.relations.nodes
      .filter((relation) => relation.type === "blocks")
      .map((relation) => relation.relatedIssue.identifier);
    const blockedBy = issue.inverseRelations.nodes
      .filter((relation) => relation.type === "blocks")
      .map((relation) => relation.issue.identifier);

    record(
      {
        id: issue.identifier,
        title: issue.title,
        state: issue.state.name,
        assignee: issue.assignee?.displayName,
        priority: issue.priority,
        team: issue.team.key,
        parent: issue.parent?.identifier,
        labels: issue.labels.nodes.map(labelName),
        blocks,
        blockedBy,
        attachments: issue.attachments.nodes.map((attachment) =>
          attachment.title ? `${attachment.title} · ${attachment.url}` : attachment.url,
        ),
        estimate: issue.estimate,
        cycle: issue.cycle?.number,
        project: issue.project?.name,
        milestone: issue.projectMilestone?.name,
        due: issue.dueDate,
        created: issue.createdAt,
        updated: issue.updatedAt,
        url: issue.url,
      },
      {
        body: issue.description ?? undefined,
        children: issue.comments
          ? [{ key: "comments", rows: commentRows(issue.comments.nodes), columns: COMMENT_COLUMNS }]
          : undefined,
      },
    );
  },
});

// --- write axes -------------------------------------------------------------
// One table drives the update selection, the input, and the receipt, so the
// three can never disagree about what a field is called or where it lives.
// Axis keys match their flag names, which is how `issue update` knows what the
// caller touched.

interface MutableIssue {
  id: string;
  identifier: string;
  team: { key: string };
  title?: string;
  description?: string | null;
  state?: { name: string };
  assignee?: { displayName: string } | null;
  priority?: number;
  estimate?: number | null;
  project?: { id: string; name: string } | null;
  cycle?: { number: number } | null;
  projectMilestone?: { name: string } | null;
  dueDate?: string | null;
  parent?: { identifier: string } | null;
  labels?: { nodes: { name: string }[] };
}

interface Axis {
  selection: string;
  read: (issue: MutableIssue) => unknown;
}

const BODY_PREVIEW = 40;

const AXES: Record<string, Axis> = {
  title: { selection: "title", read: (issue) => issue.title },
  // A whole description would drown the receipt; the preview says it moved.
  body: {
    selection: "description",
    read: (issue) => (issue.description ? clip(collapse(issue.description), BODY_PREVIEW) : undefined),
  },
  state: { selection: "state { name }", read: (issue) => issue.state?.name },
  assignee: { selection: "assignee { displayName }", read: (issue) => issue.assignee?.displayName },
  priority: { selection: "priority", read: (issue) => issue.priority },
  estimate: { selection: "estimate", read: (issue) => issue.estimate },
  project: { selection: "project { id name }", read: (issue) => issue.project?.name },
  cycle: { selection: "cycle { number }", read: (issue) => issue.cycle?.number },
  milestone: { selection: "projectMilestone { name }", read: (issue) => issue.projectMilestone?.name },
  due: { selection: "dueDate", read: (issue) => issue.dueDate },
  parent: { selection: "parent { identifier }", read: (issue) => issue.parent?.identifier },
  labels: {
    selection: `labels(first: ${RELATION_LIMIT}) { nodes { name } }`,
    read: (issue) => issue.labels?.nodes.map((label) => label.name),
  },
};

function axisSelection(fields: readonly string[]): string {
  return fields.map((field) => (AXES[field] as Axis).selection).join(" ");
}

/** The write flags create and update share. */
const WRITE_FLAGS: Record<string, FlagSpec> = {
  title: { type: "string", short: "t", valueHint: "text", doc: "issue title" },
  body: {
    type: "string",
    short: "d",
    valueHint: "text|@file|-",
    doc: "description: inline text, @file, or - to read stdin",
  },
  parent: { type: "string", valueHint: "id", doc: "parent issue, making this a sub-issue" },
  label: { type: "repeatable", valueHint: "name", doc: "label to set; repeat for more than one" },
  assignee: { type: "string", valueHint: "name|me", doc: "assignee" },
  priority: { type: "string", valueHint: "urgent|high|medium|low|none", doc: "priority" },
  estimate: { type: "number", valueHint: "N", doc: "estimate points" },
  project: { type: "string", valueHint: "name", doc: "project" },
  cycle: { type: "string", valueHint: "current|next|previous|N", doc: "cycle" },
  milestone: { type: "string", valueHint: "name", doc: "project milestone; needs the issue to be in a project" },
  due: { type: "string", valueHint: "YYYY-MM-DD", doc: "due date" },
  state: { type: "string", valueHint: "name", doc: "workflow state" },
};

const MILESTONES_QUERY = `query LinProjectMilestones($id: String!) {
  project(id: $id) { projectMilestones(first: 50) { nodes { id name } } }
}`;

interface MilestonesResponse {
  project: { projectMilestones: { nodes: { id: string; name: string }[] } };
}

/** Milestones live under a project, so they are looked up live, not cached. */
async function resolveMilestone(projectId: string | undefined, name: string): Promise<string> {
  if (projectId === undefined) {
    throw new LinError(
      EXIT.input,
      `--milestone "${name}" needs a project`,
      "pass --project NAME, or set the project on the issue first",
    );
  }
  const data = await gql<MilestonesResponse>(MILESTONES_QUERY, { id: projectId });
  const nodes = data.project.projectMilestones.nodes;
  const matches = nodes.filter((node) => node.name.toLowerCase() === name.toLowerCase());
  const first = matches[0];
  if (matches.length === 1 && first) return first.id;
  throw new LinError(
    EXIT.input,
    matches.length === 0 ? `no milestone "${name}" in that project` : `milestone "${name}" is ambiguous`,
    `milestones: ${nodes.map((node) => node.name).join(", ")}`,
  );
}

/**
 * Turn the write flags into a Linear input object, resolving every name.
 * `current` supplies the issue's own project when `--project` does not.
 */
async function writeInput(
  flags: Flags,
  teamRef: string | undefined,
  current: { projectId?: string | undefined },
): Promise<Record<string, unknown>> {
  const options = resolveOptions(flags);
  const input: Record<string, unknown> = {};

  const title = flagString(flags, "title");
  if (title !== undefined) input["title"] = title;

  const body = await bodyInput(flagString(flags, "body"));
  if (body !== undefined) input["description"] = body;

  const stateName = flagString(flags, "state");
  if (stateName !== undefined) input["stateId"] = (await resolveState(teamRef, stateName, options)).id;

  const assigneeRef = flagString(flags, "assignee");
  const unassign = flagBool(flags, "unassign");
  if (unassign && assigneeRef !== undefined) {
    throw new LinError(EXIT.input, "--assignee and --unassign disagree", "pass one or the other");
  }
  if (unassign) input["assigneeId"] = null;
  if (assigneeRef !== undefined) input["assigneeId"] = (await resolveUser(assigneeRef, options)).id;

  const priority = priorityFlag(flags);
  if (priority !== undefined) input["priority"] = priority;

  const estimate = flagNumber(flags, "estimate");
  if (estimate !== undefined) input["estimate"] = estimate;

  let projectId = current.projectId;
  const projectRef = flagString(flags, "project");
  if (projectRef !== undefined) {
    projectId = (await resolveProject(projectRef, options)).id;
    input["projectId"] = projectId;
  }

  const cycleRef = flagString(flags, "cycle");
  if (cycleRef !== undefined) input["cycleId"] = (await resolveCycle(teamRef, cycleRef, options)).id;

  const milestone = flagString(flags, "milestone");
  if (milestone !== undefined) input["projectMilestoneId"] = await resolveMilestone(projectId, milestone);

  const due = dateFlag(flags, "due");
  if (due !== undefined) input["dueDate"] = due;

  const parentRef = flagString(flags, "parent");
  if (parentRef !== undefined) input["parentId"] = await resolveIssueUUID(parentRef, options);

  const labels = flagList(flags, "label");
  if (labels.length > 0) {
    const ids: string[] = [];
    for (const name of labels) ids.push((await resolveLabel(teamRef ?? null, name, options)).id);
    input["labelIds"] = ids;
  }

  return input;
}

// --- issue create -----------------------------------------------------------

const CREATE_MUTATION = `mutation LinIssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { issue { identifier url } }
}`;

interface CreateResponse {
  issueCreate: { issue: { identifier: string; url: string } | null };
}

export const createCommand = defineCommand({
  name: "issue create",
  group: "issue",
  summary: "create an issue",
  flags: {
    ...WRITE_FLAGS,
    template: { type: "string", valueHint: "name", doc: "issue template to apply" },
  },
  examples: [
    'lin issue create --team ENG -t "Fix login redirect loop" --label Bug',
    'lin issue create --team ENG -t "Rotate webhook secrets" -d @notes.md --assignee me --priority high',
  ],
  async run({ flags, config }) {
    const options = resolveOptions(flags);
    const team = await resolveTeam(config.team, options);

    const templateRef = flagString(flags, "template");
    if (flagString(flags, "title") === undefined && templateRef === undefined) {
      throw new LinError(
        EXIT.input,
        "issue create needs a title",
        'pass -t "...", or --template NAME to take the title from a template',
      );
    }

    const input = await writeInput(flags, team.key, {});
    input["teamId"] = team.id;
    if (templateRef !== undefined) {
      input["templateId"] = (await resolveTemplate(templateRef, team.key, options)).id;
    }

    const data = await gql<CreateResponse>(CREATE_MUTATION, { input }, { retry: false });
    const issue = data.issueCreate.issue;
    if (!issue) throw new LinError(EXIT.api, "the issue was not created");
    created(issue.identifier, issue.url);
  },
});

// --- issue update -----------------------------------------------------------

function beforeDocument(selection: string): string {
  return `query LinIssueBefore($ids: [ID!]!, $first: Int!) {
  issues(filter: { id: { in: $ids } }, first: $first, includeArchived: true) {
    nodes { id identifier team { key } ${selection} }
  }
}`;
}

function updateMutation(selection: string): string {
  return `mutation LinIssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { issue { identifier ${selection} } }
}`;
}

function batchMutation(selection: string): string {
  return `mutation LinIssueBatchUpdate($ids: [UUID!]!, $input: IssueUpdateInput!) {
  issueBatchUpdate(ids: $ids, input: $input) { issues { identifier ${selection} } }
}`;
}

function addLabelMutation(selection: string): string {
  return `mutation LinIssueAddLabel($id: String!, $labelId: String!) {
  issueAddLabel(id: $id, labelId: $labelId) { issue { identifier ${selection} } }
}`;
}

function removeLabelMutation(selection: string): string {
  return `mutation LinIssueRemoveLabel($id: String!, $labelId: String!) {
  issueRemoveLabel(id: $id, labelId: $labelId) { issue { identifier ${selection} } }
}`;
}

interface BeforeResponse {
  issues: { nodes: MutableIssue[] };
}

function diff(before: MutableIssue, after: MutableIssue, fields: readonly string[]): Change[] {
  const changes: Change[] = [];
  for (const field of fields) {
    const axis = AXES[field];
    if (!axis) continue;
    const from = axis.read(before);
    const to = axis.read(after);
    if (JSON.stringify(from ?? null) !== JSON.stringify(to ?? null)) changes.push({ field, from, to });
  }
  return changes;
}

/** Team-scoped names (states, labels, cycles) need one team for the whole set. */
function commonTeam(issues: readonly MutableIssue[], configured: string | undefined): string | undefined {
  if (configured !== undefined) return configured;
  const keys = new Set(issues.map((issue) => issue.team.key));
  if (keys.size === 1) return [...keys][0];
  throw new LinError(
    EXIT.input,
    `those issues span ${keys.size} teams`,
    `pass --team KEY to say whose names to use: ${[...keys].join(", ")}`,
  );
}

export const updateCommand = defineCommand({
  name: "issue update",
  group: "issue",
  summary: "update one issue or a batch of them",
  args: [{ name: "id", doc: "issue identifier, URL or UUID", required: true, variadic: true }],
  flags: {
    ...WRITE_FLAGS,
    "add-label": { type: "repeatable", valueHint: "name", doc: "add a label, keeping the others" },
    "rm-label": { type: "repeatable", valueHint: "name", doc: "remove a label" },
    unassign: { type: "boolean", doc: "clear the assignee" },
  },
  examples: [
    "lin issue update ENG-42 --state Done",
    "lin issue update ENG-42 ENG-41 --assignee me --priority high",
    "lin issue update ENG-42 --add-label Bug --rm-label Priority/P0",
  ],
  async run({ args, flags, config }) {
    if (args.length === 0) {
      throw new LinError(
        EXIT.input,
        "issue update needs an issue id",
        "example: lin issue update ENG-42 --state Done",
      );
    }
    if (args.length > BATCH_MAX) {
      throw new LinError(
        EXIT.input,
        `issue update takes at most ${BATCH_MAX} issues, got ${args.length}`,
        `split the list into batches of ${BATCH_MAX}`,
      );
    }

    const options = resolveOptions(flags);
    const addLabels = flagList(flags, "add-label");
    const rmLabels = flagList(flags, "rm-label");

    // What might change decides both what we read back and what we print.
    const touched = new Set<string>();
    for (const field of Object.keys(AXES)) {
      if (field !== "labels" && flags[field] !== undefined) touched.add(field);
    }
    if (flagBool(flags, "unassign")) touched.add("assignee");
    if (flagList(flags, "label").length > 0 || addLabels.length > 0 || rmLabels.length > 0) touched.add("labels");
    // A milestone is addressed through its project, so that id is needed too.
    if (flags["milestone"] !== undefined) touched.add("project");

    if (touched.size === 0) {
      throw new LinError(
        EXIT.input,
        "issue update needs something to change",
        `fields: ${Object.keys(AXES).join(", ")}, add-label, rm-label, unassign`,
      );
    }

    const fields = Object.keys(AXES).filter((field) => touched.has(field));
    const selection = axisSelection(fields);

    // One query resolves every identifier to a UUID and captures the before
    // state: mutations need UUIDs, and `id: { in: [...] }` accepts either form.
    const refs = args.map((ref) => issueIdentifierFrom(ref) ?? ref);
    const before = await gql<BeforeResponse>(beforeDocument(selection), { ids: refs, first: BATCH_MAX });

    const byRef = new Map<string, MutableIssue>();
    for (const issue of before.issues.nodes) {
      byRef.set(issue.identifier.toLowerCase(), issue);
      byRef.set(issue.id.toLowerCase(), issue);
    }
    const missing = refs.filter((ref) => !byRef.has(ref.toLowerCase()));
    if (missing.length > 0) {
      throw new LinError(EXIT.notFound, `no issue ${missing.join(", ")}`, "check the identifier and the team");
    }
    const issues = refs.map((ref) => byRef.get(ref.toLowerCase()) as MutableIssue);

    // Only states, labels and cycles are team-scoped; the rest of the axes work
    // across teams, so a mixed batch is only a problem when a name has to resolve.
    const scopedByTeam =
      touched.has("state") || touched.has("cycle") || touched.has("labels");
    const teamRef = scopedByTeam ? commonTeam(issues, config.team) : config.team;

    const input = await writeInput(flags, teamRef, { projectId: issues[0]?.project?.id });

    const addIds: string[] = [];
    for (const name of addLabels) addIds.push((await resolveLabel(teamRef ?? null, name, options)).id);
    const rmIds: string[] = [];
    for (const name of rmLabels) rmIds.push((await resolveLabel(teamRef ?? null, name, options)).id);

    const single = issues[0] as MutableIssue;
    const after =
      issues.length === 1
        ? [await updateOne(single, input, addIds, rmIds, selection)]
        : await updateBatch(issues, input, addIds, rmIds, selection);

    const afterByIdentifier = new Map(after.map((issue) => [issue.identifier, issue]));
    for (const issue of issues) {
      const now = afterByIdentifier.get(issue.identifier);
      changed(issue.identifier, now ? diff(issue, now, fields) : []);
    }
  },
});

/**
 * One issue takes the dedicated label mutations, which add or remove a single
 * label without having to restate the whole set.
 */
async function updateOne(
  issue: MutableIssue,
  input: Record<string, unknown>,
  addIds: readonly string[],
  rmIds: readonly string[],
  selection: string,
): Promise<MutableIssue> {
  let latest: MutableIssue = issue;

  if (Object.keys(input).length > 0) {
    const data = await gql<{ issueUpdate: { issue: MutableIssue } }>(
      updateMutation(selection),
      { id: issue.id, input },
      { retry: false },
    );
    latest = data.issueUpdate.issue;
  }
  for (const labelId of addIds) {
    const data = await gql<{ issueAddLabel: { issue: MutableIssue } }>(
      addLabelMutation(selection),
      { id: issue.id, labelId },
      { retry: false },
    );
    latest = data.issueAddLabel.issue;
  }
  for (const labelId of rmIds) {
    const data = await gql<{ issueRemoveLabel: { issue: MutableIssue } }>(
      removeLabelMutation(selection),
      { id: issue.id, labelId },
      { retry: false },
    );
    latest = data.issueRemoveLabel.issue;
  }
  return latest;
}

async function updateBatch(
  issues: readonly MutableIssue[],
  input: Record<string, unknown>,
  addIds: readonly string[],
  rmIds: readonly string[],
  selection: string,
): Promise<MutableIssue[]> {
  const payload = { ...input };
  if (addIds.length > 0) payload["addedLabelIds"] = addIds;
  if (rmIds.length > 0) payload["removedLabelIds"] = rmIds;

  const data = await gql<{ issueBatchUpdate: { issues: MutableIssue[] } }>(
    batchMutation(selection),
    { ids: issues.map((issue) => issue.id), input: payload },
    { retry: false },
  );
  return data.issueBatchUpdate.issues;
}

// --- issue branch / issue url -----------------------------------------------

const BRANCH_QUERY = `query LinIssueBranch($id: String!) {
  issue(id: $id) { branchName }
}`;

const URL_QUERY = `query LinIssueUrl($id: String!) {
  issue(id: $id) { url }
}`;

/** The leading issue argument, normalised to ENG-42 or a UUID. */
export function issueArg(args: readonly string[], command: string): string {
  const ref = args[0];
  if (ref === undefined) {
    throw new LinError(EXIT.input, `${command} needs an issue id`, `example: lin ${command} ENG-42`);
  }
  return issueIdentifierFrom(ref) ?? ref;
}

export const branchCommand = defineCommand({
  name: "issue branch",
  group: "issue",
  summary: "print Linear's suggested git branch name for an issue",
  args: [{ name: "id", doc: "issue identifier, URL or UUID", required: true }],
  examples: ["lin issue branch ENG-42"],
  async run({ args }) {
    const data = await gql<{ issue: { branchName: string } }>(BRANCH_QUERY, {
      id: issueArg(args, "issue branch"),
    });
    line(data.issue.branchName);
  },
});

export const urlCommand = defineCommand({
  name: "issue url",
  group: "issue",
  summary: "print the canonical Linear URL for an issue",
  args: [{ name: "id", doc: "issue identifier, URL or UUID", required: true }],
  examples: ["lin issue url ENG-42"],
  async run({ args }) {
    const data = await gql<{ issue: { url: string } }>(URL_QUERY, { id: issueArg(args, "issue url") });
    line(data.issue.url);
  },
});
