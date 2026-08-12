import { gql } from "../client.ts";

export interface TuiIssue {
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  updatedAt: string;
  dueDate?: string | null;
  url: string;
  state: { name: string; color?: string | null };
  team: { key: string; name: string };
  project?: { name: string } | null;
  labels: { nodes: { name: string }[] };
}

interface TuiIssuesResponse {
  issues: { nodes: TuiIssue[] };
}

export const TUI_ISSUES_DOCUMENT = `query LinTuiIssues($first: Int!, $filter: IssueFilter!) {
  issues(first: $first, filter: $filter, sort: [{ updatedAt: { order: Descending } }]) {
    nodes {
      identifier
      title
      description
      priority
      updatedAt
      dueDate
      url
      state { name color }
      team { key name }
      project { name }
      labels { nodes { name } }
    }
  }
}`;

export async function loadTuiIssues(limit: number): Promise<TuiIssue[]> {
  const filter = {
    assignee: { isMe: { eq: true } },
    state: { type: { nin: ["completed", "canceled"] } },
  };
  const data = await gql<TuiIssuesResponse>(TUI_ISSUES_DOCUMENT, { first: limit, filter });
  return data.issues.nodes;
}

export type TuiLoadState =
  | { kind: "loading"; issues: TuiIssue[] }
  | { kind: "ready"; issues: TuiIssue[] }
  | { kind: "error"; issues: TuiIssue[]; message: string };

export class TuiIssueStore {
  state: TuiLoadState = { kind: "loading", issues: [] };

  constructor(private readonly loader: () => Promise<TuiIssue[]>) {}

  async refresh(): Promise<TuiLoadState> {
    const previous = this.state.issues;
    this.state = { kind: "loading", issues: previous };
    try {
      this.state = { kind: "ready", issues: await this.loader() };
    } catch (error) {
      this.state = {
        kind: "error",
        issues: previous,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    return this.state;
  }
}
