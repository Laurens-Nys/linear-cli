// Transparent Today view: assigned open issues that are started, overdue,
// urgent/high, or blocked. Reasons are named facts, never a score.

import { gql } from "./client.ts";
import type { Config } from "./config.ts";
import {
  missingCursor,
  repeatedCursor,
  tooManyPages,
  walkPages,
  type PageInfo,
} from "./page.ts";
import { flagString, type Flags } from "./registry.ts";
import { resolveTeam } from "./resolve.ts";

export const TODAY_COLUMNS = ["id", "title", "state", "priority", "due", "reason", "updated"] as const;

/** GraphQL page size for the complete walk. Output `-n` is applied after ranking. */
export const TODAY_PAGE_SIZE = 50;

export const TODAY_REASONS = ["started", "overdue", "urgent/high", "blocked"] as const;
export type TodayReason = (typeof TODAY_REASONS)[number];

const OPEN_STATES = { type: { nin: ["completed", "canceled"] } };

const TODAY_PAGE_ERRORS = {
  missing: missingCursor(
    "pagination cursor missing",
    "retry lin today; the assigned-issue list was truncated mid-page",
  ),
  repeated: repeatedCursor(
    "pagination cursor repeated",
    "retry lin today; the assigned-issue list repeated a cursor",
  ),
  tooMany: tooManyPages(
    "pagination exceeded maximum pages",
    "retry lin today or narrow with --team",
  ),
};

const TODAY_ISSUES_QUERY = `query LinTodayIssues($filter: IssueFilter, $first: Int!, $after: String) {
  issues(filter: $filter, first: $first, after: $after) {
    nodes {
      identifier
      title
      priority
      dueDate
      updatedAt
      state { name type }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const TODAY_BLOCKED_QUERY = `query LinTodayBlocked($filter: IssueFilter, $first: Int!, $after: String) {
  issues(filter: $filter, first: $first, after: $after) {
    nodes { identifier }
    pageInfo { hasNextPage endCursor }
  }
}`;

export interface TodayIssue {
  identifier: string;
  title: string;
  priority: number;
  dueDate: string | null;
  updatedAt: string;
  state: { name: string; type: string };
}

interface TodayConnection<T> {
  issues: { nodes: T[]; pageInfo: PageInfo };
}

export interface TodayRow {
  id: string;
  title: string;
  state: string;
  priority: number;
  due: string | undefined;
  reason: string;
  reasons: TodayReason[];
  updated: string;
  [key: string]: unknown;
}

/** Replaceable clock so overdue tests can pin a local calendar day. */
export const todayDate = {
  now(): Date {
    return new Date();
  },
};

/** Local calendar date as `YYYY-MM-DD`. Not UTC. */
export function localYmd(now: Date = todayDate.now()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** A due date is overdue only when it is a calendar day strictly before `today`. */
export function isOverdue(due: string | null | undefined, today: string): boolean {
  if (due === undefined || due === null || due === "") return false;
  return due < today;
}

export function todayReasons(input: {
  stateType: string;
  dueDate: string | null | undefined;
  priority: number;
  blocked: boolean;
  today: string;
}): TodayReason[] {
  const reasons: TodayReason[] = [];
  if (input.stateType === "started") reasons.push("started");
  if (isOverdue(input.dueDate, input.today)) reasons.push("overdue");
  if (input.priority === 1 || input.priority === 2) reasons.push("urgent/high");
  if (input.blocked) reasons.push("blocked");
  return reasons;
}

function hasReason(row: TodayRow, reason: TodayReason): boolean {
  return row.reasons.includes(reason);
}

/** None (0) ranks after low (4). Linear stores urgent=1 … low=4. */
function priorityRank(priority: number): number {
  return priority === 0 ? 5 : priority;
}

/**
 * Focus order: started, then overdue, urgent, high, blocked.
 * Ties: priority (urgent→none), earlier due (missing last), newer updated, id.
 */
export function compareToday(a: TodayRow, b: TodayRow): number {
  if (hasReason(a, "started") !== hasReason(b, "started")) return hasReason(a, "started") ? -1 : 1;
  if (hasReason(a, "overdue") !== hasReason(b, "overdue")) return hasReason(a, "overdue") ? -1 : 1;
  const aUrgent = a.priority === 1;
  const bUrgent = b.priority === 1;
  if (aUrgent !== bUrgent) return aUrgent ? -1 : 1;
  const aHigh = a.priority === 2;
  const bHigh = b.priority === 2;
  if (aHigh !== bHigh) return aHigh ? -1 : 1;
  if (hasReason(a, "blocked") !== hasReason(b, "blocked")) return hasReason(a, "blocked") ? -1 : 1;

  const byPriority = priorityRank(a.priority) - priorityRank(b.priority);
  if (byPriority !== 0) return byPriority;

  const aDue = a.due ?? "9999-99-99";
  const bDue = b.due ?? "9999-99-99";
  if (aDue !== bDue) return aDue < bDue ? -1 : 1;

  if (a.updated !== b.updated) return a.updated > b.updated ? -1 : 1;
  return a.id.localeCompare(b.id);
}

export function toTodayRow(issue: TodayIssue, blocked: boolean, today: string): TodayRow | undefined {
  const reasons = todayReasons({
    stateType: issue.state.type,
    dueDate: issue.dueDate,
    priority: issue.priority,
    blocked,
    today,
  });
  if (reasons.length === 0) return undefined;
  return {
    id: issue.identifier,
    title: issue.title,
    state: issue.state.name,
    priority: issue.priority,
    due: issue.dueDate ?? undefined,
    reason: reasons.join(","),
    reasons,
    updated: issue.updatedAt,
  };
}

function quoteArg(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

/** Continuation after `-n` truncation: the same view with `-n` set to the full ranked count. */
export function todayContinuation(total: number, flags: Flags): string {
  const parts = ["lin today", `-n ${total}`];
  const team = flagString(flags, "team");
  if (team !== undefined && team !== "") parts.push(`--team ${quoteArg(team)}`);
  const fields = flags["fields"];
  if (typeof fields === "string" && fields !== "") parts.push(`--fields ${quoteArg(fields)}`);
  return parts.join(" ");
}

export async function loadAllNodes<T>(
  fetchPage: (after: string | null) => Promise<{ nodes: readonly T[]; pageInfo: PageInfo }>,
): Promise<T[]> {
  const first = await fetchPage(null);
  const page = await walkPages(first, (cursor) => fetchPage(cursor), null, TODAY_PAGE_ERRORS);
  return page.nodes;
}

function baseFilter(teamId: string | undefined): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    assignee: { isMe: { eq: true } },
    state: OPEN_STATES,
  };
  if (teamId !== undefined) filter["team"] = { id: { eq: teamId } };
  return filter;
}

function focusFilter(teamId: string | undefined, today: string): Record<string, unknown> {
  return {
    ...baseFilter(teamId),
    or: [
      { state: { type: { eq: "started" } } },
      { dueDate: { lt: today } },
      { priority: { in: [1, 2] } },
      { hasBlockedByRelations: { eq: true } },
    ],
  };
}

function blockedFilter(teamId: string | undefined): Record<string, unknown> {
  return {
    ...baseFilter(teamId),
    hasBlockedByRelations: { eq: true },
  };
}

async function loadConnection<T>(
  document: string,
  filter: Record<string, unknown>,
  pageSize: number,
): Promise<T[]> {
  return loadAllNodes(async (after) => {
    const data = await gql<TodayConnection<T>>(document, {
      filter,
      first: pageSize,
      after,
    });
    return data.issues;
  });
}

export async function collectToday(options: {
  teamId?: string;
  today: string;
  pageSize?: number;
}): Promise<TodayRow[]> {
  const pageSize = options.pageSize ?? TODAY_PAGE_SIZE;
  const [issues, blockedNodes] = await Promise.all([
    loadConnection<TodayIssue>(TODAY_ISSUES_QUERY, focusFilter(options.teamId, options.today), pageSize),
    loadConnection<{ identifier: string }>(TODAY_BLOCKED_QUERY, blockedFilter(options.teamId), pageSize),
  ]);

  const blocked = new Set(blockedNodes.map((node) => node.identifier));
  const rows: TodayRow[] = [];
  for (const issue of issues) {
    const row = toTodayRow(issue, blocked.has(issue.identifier), options.today);
    if (row) rows.push(row);
  }
  rows.sort(compareToday);
  return rows;
}

export async function resolveTodayTeam(
  config: Config,
  flags: Flags,
): Promise<string | undefined> {
  if (config.team === undefined || config.team === "") return undefined;
  return (await resolveTeam(config.team, { noCache: flags["no-cache"] === true })).id;
}

export function truncateToday(
  rows: readonly TodayRow[],
  limit: number,
  flags: Flags,
): { shown: TodayRow[]; more?: { count: number; command: string } } {
  if (rows.length <= limit) return { shown: [...rows] };
  return {
    shown: rows.slice(0, limit),
    more: { count: rows.length - limit, command: todayContinuation(rows.length, flags) },
  };
}
