// owned by: alias agent
// The hot path: ls, start, done, triage, search. Each is a whole command rather
// than a flag preset, because the defaults differ from the verbs they shorten.
// Bare-identifier dispatch (`lin ENG-42`) lives in main.ts.

import { gql } from "../client.ts";
import { changed, EXIT, line, LinError, selectColumns, table, type Change, type MoreInfo } from "../out.ts";
import { defineCommand, flagBool, flagString, type Flags } from "../registry.ts";
import {
  issueIdentifierFrom,
  issueIdentifierFromBranch,
  resolveStateByType,
  resolveTeam,
  resolveUser,
} from "../resolve.ts";
import {
  allPagesContinuation,
  clip,
  collapse,
  collectPages,
  continuation,
  ISSUE_OPTIONAL_FIELDS,
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
  allPages: true,
  fields: MINE_COLUMNS,
  extra: ISSUE_OPTIONAL_FIELDS,
  examples: ["lin ls", "lin ls --team ENG"],
  async run({ flags, config }) {
    const columns = selectColumns(MINE_COLUMNS, ISSUE_OPTIONAL_FIELDS);
    const extras = new Set(ISSUE_OPTIONAL_FIELDS.filter((field) => columns.includes(field)));
    const filter: Record<string, unknown> = {
      assignee: { isMe: { eq: true } },
      state: OPEN_STATES,
    };
    if (config.team !== undefined) {
      filter["team"] = { id: { eq: (await resolveTeam(config.team, resolveOptions(flags))).id } };
    }

    const first = limitOf(config);
    const after = flagString(flags, "after") ?? null;
    const page = await collectPages(
      async (cursor) => {
        const data = await gql<IssueListResponse>(listDocument(false, extras), {
          filter,
          first,
          after: cursor,
          sort: [SORTS["updated"]],
          archived: false,
        });
        return data.issues;
      },
      after,
      flagBool(flags, "all-pages"),
    );

    table("issues", listRows(page.nodes), MINE_COLUMNS, {
      extra: ISSUE_OPTIONAL_FIELDS,
      more: morePages(page.pageInfo, undefined, (cursor) => continuation("ls", [], flags, cursor)),
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

const TRIAGE_COLUMNS = ["id", "title", "age", "priority"] as const;

export const triageCommand = defineCommand({
  name: "triage",
  group: "alias",
  summary: "issues waiting in the team's triage state, oldest first",
  allPages: true,
  fields: TRIAGE_COLUMNS,
  examples: ["lin triage", "lin triage --team ENG"],
  async run({ flags, config }) {
    selectColumns(TRIAGE_COLUMNS);
    const options = resolveOptions(flags);
    const team = await resolveTeam(config.team, options);

    const first = limitOf(config);
    const after = flagString(flags, "after") ?? null;
    const page = await collectPages(
      async (cursor) => {
        const data = await gql<TriageResponse>(TRIAGE_QUERY, {
          filter: { team: { id: { eq: team.id } }, state: { type: { eq: "triage" } } },
          first,
          after: cursor,
        });
        return data.issues;
      },
      after,
      flagBool(flags, "all-pages"),
    );

    const rows = page.nodes.map((node) => ({
      id: node.identifier,
      title: node.title,
      age: age(node.createdAt),
      priority: node.priority,
    }));

    table("issues", rows, ["id", "title", "age", "priority"], {
      more: morePages(page.pageInfo, undefined, (cursor) => continuation("triage", [], flags, cursor)),
    });
  },
});

// --- search -----------------------------------------------------------------

const SNIPPET_CLIP = 80;
const SEARCH_ISSUE_COLUMNS = ["id", "title", "state", "snippet"] as const;
const SEARCH_PROJECT_COLUMNS = ["id", "name", "state"] as const;
const SEARCH_DOC_COLUMNS = ["id", "title", "project", "updated"] as const;

/**
 * Projects/docs have no user-facing cursor on the combined search query.
 * A truncated first page must rerun the same search with `--all-pages`.
 */
function searchSectionMore(
  nodes: number,
  totalCount: number,
  pageInfo: PageInfo | undefined,
  allPages: boolean,
  term: string,
  flags: Flags,
): MoreInfo | undefined {
  if (allPages) return undefined;
  const extra = totalCount - nodes;
  if (extra <= 0 && pageInfo?.hasNextPage !== true) return undefined;
  return {
    count: extra > 0 ? extra : undefined,
    command: allPagesContinuation("search", [term], flags),
  };
}

export function searchDocument(projects: boolean, docs: boolean): string {
  const extra = [
    projects
      ? "\n  searchProjects(term: $term, first: $first) { totalCount nodes { slugId name status { name } } pageInfo { hasNextPage endCursor } }"
      : "",
    docs
      ? "\n  searchDocuments(term: $term, first: $first) { totalCount nodes { slugId title project { name } updatedAt } pageInfo { hasNextPage endCursor } }"
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

const SEARCH_PROJECTS_QUERY = `query LinSearchProjects($term: String!, $first: Int!, $after: String) {
  searchProjects(term: $term, first: $first, after: $after) {
    totalCount
    nodes { slugId name status { name } }
    pageInfo { hasNextPage endCursor }
  }
}`;

const SEARCH_DOCUMENTS_QUERY = `query LinSearchDocuments($term: String!, $first: Int!, $after: String) {
  searchDocuments(term: $term, first: $first, after: $after) {
    totalCount
    nodes { slugId title project { name } updatedAt }
    pageInfo { hasNextPage endCursor }
  }
}`;

interface SearchIssuePage {
  totalCount: number;
  nodes: { identifier: string; title: string; state: { name: string }; description: string | null }[];
  pageInfo: PageInfo;
}

interface SearchProjectPage {
  totalCount: number;
  nodes: { slugId: string; name: string; status: { name: string } | null }[];
  pageInfo: PageInfo;
}

interface SearchDocumentPage {
  totalCount: number;
  nodes: { slugId: string; title: string; project: { name: string } | null; updatedAt: string }[];
  pageInfo: PageInfo;
}

interface SearchResponse {
  searchIssues: SearchIssuePage;
  searchProjects?: SearchProjectPage;
  searchDocuments?: SearchDocumentPage;
}

export const searchCommand = defineCommand({
  name: "search",
  group: "alias",
  summary: "full-text search across issues, and optionally projects and documents",
  allPages: true,
  fields: SEARCH_ISSUE_COLUMNS,
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
    if ((projects || docs) && flags["fields"] !== undefined) {
      throw new LinError(
        EXIT.input,
        "--fields cannot be combined with --projects or --docs",
        "omit --fields, or search issues only",
      );
    }
    selectColumns(SEARCH_ISSUE_COLUMNS);

    const first = limitOf(config);
    const after = flagString(flags, "after") ?? null;
    const allPages = flagBool(flags, "all-pages");

    const data = await gql<SearchResponse>(searchDocument(projects, docs), {
      term,
      first,
      after,
    });

    const issues = await collectPages(
      async (cursor) => {
        const page = await gql<SearchResponse>(searchDocument(false, false), {
          term,
          first,
          after: cursor,
        });
        return page.searchIssues;
      },
      after,
      allPages,
      data.searchIssues,
    );
    const rows = issues.nodes.map((node) => ({
      id: node.identifier,
      title: node.title,
      state: node.state.name,
      snippet: node.description ? clip(collapse(node.description), SNIPPET_CLIP) : "",
    }));

    table("issues", rows, SEARCH_ISSUE_COLUMNS, {
      // First-page totals are exact. A mid-list --after cannot recover how many
      // rows were already printed, so that remainder stays unknown.
      more: morePages(
        issues.pageInfo,
        after === null ? data.searchIssues.totalCount - rows.length : undefined,
        (cursor) => continuation("search", [term], flags, cursor),
      ),
    });

    if (data.searchProjects) {
      const page = await collectPages(
        async (cursor) => {
          const next = await gql<{ searchProjects: SearchProjectPage }>(SEARCH_PROJECTS_QUERY, {
            term,
            first,
            after: cursor,
          });
          return next.searchProjects;
        },
        null,
        allPages,
        data.searchProjects,
      );
      table(
        "projects",
        page.nodes.map((node) => ({
          id: node.slugId,
          name: node.name,
          state: node.status?.name,
        })),
        SEARCH_PROJECT_COLUMNS,
        { more: searchSectionMore(page.nodes.length, data.searchProjects.totalCount, page.pageInfo, allPages, term, flags) },
      );
    }

    if (data.searchDocuments) {
      const page = await collectPages(
        async (cursor) => {
          const next = await gql<{ searchDocuments: SearchDocumentPage }>(SEARCH_DOCUMENTS_QUERY, {
            term,
            first,
            after: cursor,
          });
          return next.searchDocuments;
        },
        null,
        allPages,
        data.searchDocuments,
      );
      table(
        "docs",
        page.nodes.map((node) => ({
          id: node.slugId,
          title: node.title,
          project: node.project?.name,
          updated: node.updatedAt,
        })),
        SEARCH_DOC_COLUMNS,
        { more: searchSectionMore(page.nodes.length, data.searchDocuments.totalCount, page.pageInfo, allPages, term, flags) },
      );
    }
  },
});
