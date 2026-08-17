import { gql } from "../client.ts";

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
  description: string | null;
  priority: number;
  updatedAt: string;
  dueDate?: string | null;
  url: string;
  state: { id: string; name: string; color: string; type: TuiWorkflowStateType };
  team: { key: string; name: string };
  project?: { name: string } | null;
  labels: { nodes: { name: string }[] };
}

interface TuiIssuesResponse {
  issues: { nodes: TuiIssue[] };
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

export const TUI_ISSUES_DOCUMENT = `query LinTuiIssues($first: Int!, $filter: IssueFilter!, $sort: [IssueSortInput!]) {
  issues(first: $first, filter: $filter, sort: $sort) {
    nodes {
      id
      identifier
      title
      description
      priority
      updatedAt
      dueDate
      url
      state { id name color type }
      team { key name }
      project { name }
      labels { nodes { name } }
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

export async function loadTuiIssues(query: TuiIssueQuery): Promise<TuiIssue[]> {
  const data = await gql<TuiIssuesResponse>(TUI_ISSUES_DOCUMENT, tuiIssueVariables(query));
  return data.issues.nodes;
}

const TUI_MOVE_DOCUMENT = `mutation LinTuiMoveIssue($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) {
    issue { id identifier state { id name color type } }
  }
}`;

export async function moveTuiIssue(issueId: string, stateId: string): Promise<TuiIssue["state"]> {
  const data = await gql<{ issueUpdate: { issue: Pick<TuiIssue, "state"> } }>(
    TUI_MOVE_DOCUMENT,
    { id: issueId, stateId },
    { retry: false },
  );
  return data.issueUpdate.issue.state;
}

export type TuiLoadState =
  | { kind: "loading"; issues: TuiIssue[] }
  | { kind: "ready"; issues: TuiIssue[] }
  | { kind: "error"; issues: TuiIssue[]; message: string };

export class TuiIssueStore {
  state: TuiLoadState = { kind: "loading", issues: [] };

  constructor(private readonly loader: (query: TuiIssueQuery) => Promise<TuiIssue[]>) {}

  loading(): TuiLoadState {
    this.state = { kind: "loading", issues: this.state.issues };
    return this.state;
  }

  ready(issues: TuiIssue[]): TuiLoadState {
    this.state = { kind: "ready", issues };
    return this.state;
  }

  error(error: unknown): TuiLoadState {
    this.state = {
      kind: "error",
      issues: this.state.issues,
      message: error instanceof Error ? error.message : String(error),
    };
    return this.state;
  }

  load(query: TuiIssueQuery): Promise<TuiIssue[]> {
    return this.loader(query);
  }

  replace(issue: TuiIssue): TuiLoadState {
    this.state = {
      ...this.state,
      issues: this.state.issues.map((item) => item.id === issue.id ? issue : item),
    };
    return this.state;
  }
}
