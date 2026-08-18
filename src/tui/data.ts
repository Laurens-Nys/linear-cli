import { gql } from "../client.ts";
import { EXIT, LinError } from "../out.ts";
import type { PageInfo } from "../page.ts";

export type TuiSort = "updated" | "created" | "priority";
export type TuiView = "all" | "started" | "unstarted" | "completed";
export type TuiWorkflowStateType =
  | "triage"
  | "backlog"
  | "unstarted"
  | "started"
  | "completed"
  | "canceled"
  | "duplicate";

export interface TuiIssueQuery {
  limit: number;
  teamId?: string;
  projectId?: string;
  title?: string;
  sort: TuiSort;
  view: TuiView;
  layout?: "list" | "board";
}

export interface TuiIssue {
  id: string;
  identifier: string;
  title: string;
  priority: number;
  updatedAt: string;
  dueDate?: string | null;
  url: string;
  state: { id: string; name: string; color: string; type: TuiWorkflowStateType };
  team: { key: string; name: string };
  project?: { name: string } | null;
  labels: { nodes: { name: string }[] };
}

export interface TuiComment {
  id: string;
  createdAt: string;
  body: string;
  user: { displayName: string } | null;
  botActor?: { name: string } | null;
}

export interface TuiIssueDetail {
  description: string | null;
  comments: TuiComment[];
  updatedAt: string;
}

export interface TuiIssuePage {
  nodes: TuiIssue[];
  totalCount: number;
  pageInfo: PageInfo;
}

interface TuiIssuesResponse {
  issues: {
    nodes: TuiIssue[];
    totalCount: number;
    pageInfo: { hasNextPage?: boolean; endCursor?: string | null };
  };
}

interface TuiIssueDetailResponse {
  issue: {
    id: string;
    identifier: string;
    updatedAt: string;
    description: string | null;
    comments: { nodes: TuiComment[] };
  } | null;
}

export const TUI_SORTS: Record<TuiSort, unknown> = {
  updated: { updatedAt: { order: "Descending" } },
  created: { createdAt: { order: "Descending" } },
  priority: { priority: { order: "Ascending" } },
};

export const TUI_SORT_LABELS: Record<TuiSort, string> = {
  updated: "Recently updated",
  created: "Recently created",
  priority: "Priority",
};

export const TUI_SORT_SHORT: Record<TuiSort, string> = {
  updated: "updated",
  created: "created",
  priority: "priority",
};

export const TUI_VIEWS: TuiView[] = ["all", "started", "unstarted", "completed"];

export const TUI_VIEW_LABELS: Record<TuiView, string> = {
  all: "All",
  started: "Started",
  unstarted: "Todo",
  completed: "Done",
};

export function tuiStateFilter(view: TuiView, layout: "list" | "board" = "list"): Record<string, unknown> {
  if (layout === "board") return { type: { nin: ["canceled", "duplicate"] } };
  if (view === "completed") return { type: { eq: "completed" } };
  if (view === "started") return { type: { eq: "started" } };
  if (view === "unstarted") return { type: { in: ["unstarted", "backlog", "triage"] } };
  return { type: { nin: ["completed", "canceled"] } };
}

/** List/board rows only. Descriptions and comment bodies load lazily per issue. */
export const TUI_ISSUES_DOCUMENT = `query LinTuiIssues($first: Int!, $filter: IssueFilter!, $sort: [IssueSortInput!]) {
  issues(first: $first, filter: $filter, sort: $sort) {
    nodes {
      id
      identifier
      title
      priority
      updatedAt
      dueDate
      url
      state { id name color type }
      team { key name }
      project { name }
      labels { nodes { name } }
    }
    totalCount
    pageInfo { hasNextPage endCursor }
  }
}`;

export const TUI_ISSUE_DETAIL_DOCUMENT = `query LinTuiIssueDetail($id: String!) {
  issue(id: $id) {
    id
    identifier
    updatedAt
    description
    comments(last: 3) {
      nodes {
        id
        createdAt
        body
        user { displayName }
        botActor { name }
      }
    }
  }
}`;

export function tuiIssueVariables(query: TuiIssueQuery): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    assignee: { isMe: { eq: true } },
    state: tuiStateFilter(query.view, query.layout),
  };
  if (query.teamId) filter["team"] = { id: { eq: query.teamId } };
  if (query.projectId) filter["project"] = { id: { eq: query.projectId } };
  const title = query.title?.trim();
  if (title) filter["title"] = { containsIgnoreCase: title };
  return { first: query.limit, filter, sort: [TUI_SORTS[query.sort]] };
}

export function isTuiAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function tuiAbortError(): Error {
  const error = new Error("the TUI request was cancelled");
  error.name = "AbortError";
  return error;
}

export function formatTuiCount(shown: number, totalCount: number, pageInfo: PageInfo): string {
  const bounded = pageInfo.hasNextPage || shown < totalCount;
  if (!bounded) return `${shown}`;
  if (totalCount > shown) return `${shown} of ${totalCount}`;
  return `${shown}+`;
}

/** Oldest-first, then id, so the last-three comment window is stable regardless of API order. */
export function sortTuiComments(comments: readonly TuiComment[]): TuiComment[] {
  return comments.slice().sort((left, right) => {
    const byCreated = left.createdAt.localeCompare(right.createdAt);
    return byCreated !== 0 ? byCreated : left.id.localeCompare(right.id);
  });
}

export function asTuiIssuePage(result: TuiIssue[] | TuiIssuePage): TuiIssuePage {
  if (Array.isArray(result)) {
    return { nodes: result, totalCount: result.length, pageInfo: { hasNextPage: false, endCursor: null } };
  }
  return {
    nodes: result.nodes,
    totalCount: result.totalCount,
    pageInfo: {
      hasNextPage: result.pageInfo.hasNextPage,
      endCursor: result.pageInfo.endCursor,
    },
  };
}

function connectionPage(issues: TuiIssuesResponse["issues"]): TuiIssuePage {
  const nodes = issues.nodes;
  const totalCount = typeof issues.totalCount === "number" ? issues.totalCount : nodes.length;
  return {
    nodes,
    totalCount,
    pageInfo: {
      hasNextPage: issues.pageInfo?.hasNextPage === true,
      endCursor: typeof issues.pageInfo?.endCursor === "string" ? issues.pageInfo.endCursor : null,
    },
  };
}

export async function loadTuiIssues(query: TuiIssueQuery, signal?: AbortSignal): Promise<TuiIssuePage> {
  const data = await gql<TuiIssuesResponse>(TUI_ISSUES_DOCUMENT, tuiIssueVariables(query), { signal });
  return connectionPage(data.issues);
}

export async function loadTuiIssueDetail(id: string, signal?: AbortSignal): Promise<TuiIssueDetail> {
  const data = await gql<TuiIssueDetailResponse>(TUI_ISSUE_DETAIL_DOCUMENT, { id }, { signal });
  if (!data.issue) {
    throw new LinError(EXIT.notFound, `issue ${id} not found`, "refresh the list and try again");
  }
  return {
    description: data.issue.description,
    comments: sortTuiComments(data.issue.comments.nodes),
    updatedAt: data.issue.updatedAt,
  };
}

const TUI_MOVE_DOCUMENT = `mutation LinTuiMoveIssue($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) {
    issue { id identifier state { id name color type } }
  }
}`;

export async function moveTuiIssue(
  issueId: string,
  stateId: string,
  signal?: AbortSignal,
): Promise<TuiIssue["state"]> {
  const data = await gql<{ issueUpdate: { issue: Pick<TuiIssue, "state"> } }>(
    TUI_MOVE_DOCUMENT,
    { id: issueId, stateId },
    { retry: false, signal },
  );
  return data.issueUpdate.issue.state;
}

export type TuiLoadState =
  | { kind: "loading"; issues: TuiIssue[]; totalCount: number; pageInfo: PageInfo }
  | { kind: "ready"; issues: TuiIssue[]; totalCount: number; pageInfo: PageInfo }
  | { kind: "error"; issues: TuiIssue[]; totalCount: number; pageInfo: PageInfo; message: string };

const EMPTY_PAGE: PageInfo = { hasNextPage: false, endCursor: null };

export class TuiIssueStore {
  state: TuiLoadState = { kind: "loading", issues: [], totalCount: 0, pageInfo: EMPTY_PAGE };
  private listController: AbortController | undefined;
  private detailController: AbortController | undefined;
  private readonly details = new Map<string, { updatedAt: string; detail: TuiIssueDetail }>();

  constructor(
    private readonly loader: (query: TuiIssueQuery, signal?: AbortSignal) => Promise<TuiIssue[] | TuiIssuePage>,
    private readonly detailLoader?: (id: string, signal?: AbortSignal) => Promise<TuiIssueDetail>,
  ) {}

  get canLoadDetail(): boolean {
    return this.detailLoader !== undefined;
  }

  loading(): TuiLoadState {
    this.state = { ...this.state, kind: "loading" };
    return this.state;
  }

  ready(page: TuiIssue[] | TuiIssuePage): TuiLoadState {
    const next = asTuiIssuePage(page);
    this.state = { kind: "ready", issues: next.nodes, totalCount: next.totalCount, pageInfo: next.pageInfo };
    return this.state;
  }

  error(error: unknown): TuiLoadState {
    if (isTuiAbortError(error)) return this.state;
    this.state = {
      kind: "error",
      issues: this.state.issues,
      totalCount: this.state.totalCount,
      pageInfo: this.state.pageInfo,
      message: error instanceof Error ? error.message : String(error),
    };
    return this.state;
  }

  async load(query: TuiIssueQuery): Promise<TuiIssuePage> {
    this.listController?.abort();
    const controller = new AbortController();
    this.listController = controller;
    try {
      const result = await this.loader(query, controller.signal);
      if (controller.signal.aborted) throw tuiAbortError();
      return asTuiIssuePage(result);
    } catch (error) {
      if (controller.signal.aborted || isTuiAbortError(error)) throw tuiAbortError();
      throw error;
    }
  }

  peekDetail(issue: TuiIssue): TuiIssueDetail | undefined {
    const cached = this.details.get(issue.id);
    if (cached && cached.updatedAt === issue.updatedAt) return cached.detail;
    return undefined;
  }

  /** Cached body even when `updatedAt` no longer matches, used to avoid a loading flicker. */
  peekCachedDetail(issue: TuiIssue): TuiIssueDetail | undefined {
    return this.details.get(issue.id)?.detail;
  }

  async loadDetail(issue: TuiIssue): Promise<TuiIssueDetail> {
    const cached = this.peekDetail(issue);
    if (cached) return cached;
    if (!this.detailLoader) throw new Error("TUI detail loader is not configured");
    this.detailController?.abort();
    const controller = new AbortController();
    this.detailController = controller;
    try {
      const detail = await this.detailLoader(issue.id, controller.signal);
      if (controller.signal.aborted) throw tuiAbortError();
      this.details.set(issue.id, { updatedAt: issue.updatedAt, detail });
      return detail;
    } catch (error) {
      if (controller.signal.aborted || isTuiAbortError(error)) throw tuiAbortError();
      throw error;
    }
  }

  /** Public seam for local writes (comment composer) that make a cached detail stale. */
  invalidateDetail(issueId: string): void {
    this.details.delete(issueId);
  }

  abortList(): void {
    this.listController?.abort();
  }

  abortDetail(): void {
    this.detailController?.abort();
  }

  abort(): void {
    this.abortList();
    this.abortDetail();
  }

  replace(issue: TuiIssue): TuiLoadState {
    this.state = {
      ...this.state,
      issues: this.state.issues.map((item) => item.id === issue.id ? issue : item),
    };
    return this.state;
  }
}
