// owned by: alias agent
// The hot path: ls, start, done, triage, search. Each is a whole command rather
// than a flag preset, because the defaults differ from the verbs they shorten.
// Bare-identifier dispatch (`lin ENG-42`) lives in main.ts.

import { gql } from "../client.ts";
import { changed, EXIT, line, LinError, table, type Change } from "../out.ts";
import { defineCommand, flagBool, flagString } from "../registry.ts";
import {
  issueIdentifierFrom,
  issueIdentifierFromBranch,
  resolveStateByType,
  resolveTeam,
  resolveUser,
} from "../resolve.ts";
import {
  clip,
  collapse,
  continuation,
  limitOf,
  listDocument,
  listRows,
  MINE_COLUMNS,
  morePages,
  OPEN_STATES,
  resolveOptions,
  SORTS,
  type IssueListResponse,
  type PageInfo,
} from "./issue.ts";

// --- ls ---------------------------------------------------------------------

export const lsCommand = defineCommand({
  name: "ls",
  group: "alias",
  summary: "my open issues, most recently updated first",
  examples: ["lin ls", "lin ls --team ENG"],
  async run({ flags, config }) {
    const filter: Record<string, unknown> = {
      assignee: { isMe: { eq: true } },
      state: OPEN_STATES,
    };
    if (config.team !== undefined) {
      filter["team"] = { id: { eq: (await resolveTeam(config.team, resolveOptions(flags))).id } };
    }

    const first = limitOf(config);
    const data = await gql<IssueListResponse>(listDocument(false), {
      filter,
      first,
      after: flagString(flags, "after") ?? null,
      sort: [SORTS["updated"]],
      archived: false,
    });

    table("issues", listRows(data.issues.nodes), MINE_COLUMNS, {
      more: morePages(data.issues.pageInfo, undefined, (cursor) => continuation("ls", [], flags, cursor)),
    });
  },
});

// --- start / done -----------------------------------------------------------

/**
 * The current git branch. A replaceable binding rather than a bare function so
 * tests can stand in for git without a repository on disk.
 */
export const git = {
  branch(): string | undefined {
    const result = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { stderr: "ignore" });
    if (!result.success) return undefined;
    return result.stdout.toString().trim() || undefined;
  },
};

function targetDocument(withBranch: boolean): string {
  return `query LinIssueTarget($id: String!) {
  issue(id: $id) { id identifier team { key } state { name } assignee { displayName }${withBranch ? " branchName" : ""} }
}`;
}

const MOVE_MUTATION = `mutation LinIssueMove($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { issue { identifier state { name } assignee { displayName } } }
}`;

interface TargetIssue {
  id: string;
  identifier: string;
  team: { key: string };
  state: { name: string };
  assignee: { displayName: string } | null;
  branchName?: string;
}

interface MoveResponse {
  issueUpdate: { issue: { identifier: string; state: { name: string }; assignee: { displayName: string } | null } };
}

/** The argument, or the identifier in the current branch name. */
function targetRef(args: readonly string[], command: string): string {
  const explicit = args[0];
  if (explicit !== undefined) return issueIdentifierFrom(explicit) ?? explicit;

  const branch = git.branch();
  const inferred = branch === undefined ? undefined : issueIdentifierFromBranch(branch);
  if (inferred === undefined) {
    throw new LinError(
      EXIT.input,
      `${command} needs an issue id`,
      `pass one, or run it on a branch whose name carries the identifier, like casey/eng-42-fix`,
    );
  }
  return inferred;
}

function movement(before: TargetIssue, after: MoveResponse["issueUpdate"]["issue"]): Change[] {
  const changes: Change[] = [];
  if (before.state.name !== after.state.name) {
    changes.push({ field: "state", from: before.state.name, to: after.state.name });
  }
  const from = before.assignee?.displayName;
  const to = after.assignee?.displayName;
  if (from !== to) changes.push({ field: "assignee", from, to });
  return changes;
}

export const startCommand = defineCommand({
  name: "start",
  group: "alias",
  summary: "assign an issue to me, move it to the team's first started state, print its branch name",
  args: [{ name: "id", doc: "issue id; taken from the current git branch when omitted" }],
  examples: ["lin start ENG-42", "lin start"],
  async run({ args, flags }) {
    const options = resolveOptions(flags);
    const data = await gql<{ issue: TargetIssue }>(targetDocument(true), {
      id: targetRef(args, "start"),
    });
    const issue = data.issue;

    const state = await resolveStateByType(issue.team.key, "started", options);
    const me = await resolveUser("me", options);

    const moved = await gql<MoveResponse>(
      MOVE_MUTATION,
      { id: issue.id, input: { stateId: state.id, assigneeId: me.id } },
      { retry: false },
    );

    changed(issue.identifier, movement(issue, moved.issueUpdate.issue));
    if (issue.branchName) line(issue.branchName);
  },
});

export const doneCommand = defineCommand({
  name: "done",
  group: "alias",
  summary: "move an issue to the team's first completed state",
  args: [{ name: "id", doc: "issue id; taken from the current git branch when omitted" }],
  examples: ["lin done ENG-42", "lin done"],
  async run({ args, flags }) {
    const data = await gql<{ issue: TargetIssue }>(targetDocument(false), {
      id: targetRef(args, "done"),
    });
    const issue = data.issue;

    const state = await resolveStateByType(issue.team.key, "completed", resolveOptions(flags));
    const moved = await gql<MoveResponse>(
      MOVE_MUTATION,
      { id: issue.id, input: { stateId: state.id } },
      { retry: false },
    );

    changed(issue.identifier, movement(issue, moved.issueUpdate.issue));
  },
});

// --- triage -----------------------------------------------------------------

const TRIAGE_QUERY = `query LinTriage($filter: IssueFilter, $first: Int!, $after: String) {
  issues(filter: $filter, first: $first, after: $after, sort: [{ createdAt: { order: Ascending } }]) {
    nodes { identifier title createdAt priority }
    pageInfo { hasNextPage endCursor }
  }
}`;

interface TriageResponse {
  issues: {
    nodes: { identifier: string; title: string; createdAt: string; priority: number }[];
    pageInfo: PageInfo;
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days since a timestamp, e.g. `12d`. */
export function age(createdAt: string, now: number = Date.now()): string {
  const days = Math.floor((now - Date.parse(createdAt)) / DAY_MS);
  return `${Number.isFinite(days) && days > 0 ? days : 0}d`;
}

export const triageCommand = defineCommand({
  name: "triage",
  group: "alias",
  summary: "issues waiting in the team's triage state, oldest first",
  examples: ["lin triage", "lin triage --team ENG"],
  async run({ flags, config }) {
    const options = resolveOptions(flags);
    const team = await resolveTeam(config.team, options);

    const first = limitOf(config);
    const data = await gql<TriageResponse>(TRIAGE_QUERY, {
      filter: { team: { id: { eq: team.id } }, state: { type: { eq: "triage" } } },
      first,
      after: flagString(flags, "after") ?? null,
    });

    const rows = data.issues.nodes.map((node) => ({
      id: node.identifier,
      title: node.title,
      age: age(node.createdAt),
      priority: node.priority,
    }));

    table("issues", rows, ["id", "title", "age", "priority"], {
      more: morePages(data.issues.pageInfo, undefined, (cursor) => continuation("triage", [], flags, cursor)),
    });
  },
});

// --- search -----------------------------------------------------------------

const SNIPPET_CLIP = 80;

export function searchDocument(projects: boolean, docs: boolean): string {
  const extra = [
    projects
      ? "\n  searchProjects(term: $term, first: $first) { totalCount nodes { slugId name status { name } } }"
      : "",
    docs
      ? "\n  searchDocuments(term: $term, first: $first) { totalCount nodes { slugId title project { name } updatedAt } }"
      : "",
  ].join("");

  return `query LinSearch($term: String!, $first: Int!, $after: String) {
  searchIssues(term: $term, first: $first, after: $after) {
    totalCount
    nodes { identifier title state { name } description }
    pageInfo { hasNextPage endCursor }
  }${extra}
}`;
}

interface SearchResponse {
  searchIssues: {
    totalCount: number;
    nodes: { identifier: string; title: string; state: { name: string }; description: string | null }[];
    pageInfo: PageInfo;
  };
  searchProjects?: {
    totalCount: number;
    nodes: { slugId: string; name: string; status: { name: string } | null }[];
  };
  searchDocuments?: {
    totalCount: number;
    nodes: { slugId: string; title: string; project: { name: string } | null; updatedAt: string }[];
  };
}

export const searchCommand = defineCommand({
  name: "search",
  group: "alias",
  summary: "full-text search across issues, and optionally projects and documents",
  args: [{ name: "term", doc: "text to search for", required: true }],
  flags: {
    projects: { type: "boolean", doc: "also search projects" },
    docs: { type: "boolean", doc: "also search documents" },
  },
  examples: ['lin search "login redirect"', 'lin search "webhook" --projects --docs'],
  async run({ args, flags, config }) {
    const term = args[0];
    if (term === undefined || term.trim() === "") {
      throw new LinError(EXIT.input, "search needs a term", 'example: lin search "login redirect"');
    }

    const projects = flagBool(flags, "projects");
    const docs = flagBool(flags, "docs");
    const first = limitOf(config);

    const data = await gql<SearchResponse>(searchDocument(projects, docs), {
      term,
      first,
      after: flagString(flags, "after") ?? null,
    });

    const issues = data.searchIssues;
    const rows = issues.nodes.map((node) => ({
      id: node.identifier,
      title: node.title,
      state: node.state.name,
      snippet: node.description ? clip(collapse(node.description), SNIPPET_CLIP) : "",
    }));

    table("issues", rows, ["id", "title", "state", "snippet"], {
      // Search payloads carry a total, so the count is exact.
      more: morePages(issues.pageInfo, issues.totalCount - rows.length, (cursor) =>
        continuation("search", [term], flags, cursor),
      ),
    });

    if (data.searchProjects) {
      table(
        "projects",
        data.searchProjects.nodes.map((node) => ({
          id: node.slugId,
          name: node.name,
          state: node.status?.name,
        })),
        ["id", "name", "state"],
      );
    }

    if (data.searchDocuments) {
      table(
        "docs",
        data.searchDocuments.nodes.map((node) => ({
          id: node.slugId,
          title: node.title,
          project: node.project?.name,
          updated: node.updatedAt,
        })),
        ["id", "title", "project", "updated"],
      );
    }
  },
});
