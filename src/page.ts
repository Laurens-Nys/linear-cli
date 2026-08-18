// Shared Relay pagination. Walkers must fail closed: a missing or repeated
// cursor is an API error, never a silently complete page or cache write.

import { EXIT, LinError } from "./out.ts";

export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

/** Generous cap so unique-but-endless cursors still fail instead of walking forever. */
export const MAX_PAGES = 200;

export function missingCursor(message: string, hint: string): LinError {
  return new LinError(EXIT.api, message, hint);
}

export function repeatedCursor(message: string, hint: string): LinError {
  return new LinError(EXIT.api, message, hint);
}

export function tooManyPages(message: string, hint: string): LinError {
  return new LinError(EXIT.api, message, hint);
}

export interface PageErrors {
  missing: LinError;
  repeated: LinError;
  tooMany: LinError;
}

function listPageErrors(): PageErrors {
  return {
    missing: missingCursor(
      "pagination cursor missing",
      "retry without --all-pages or pass a different --after",
    ),
    repeated: repeatedCursor(
      "pagination cursor repeated",
      "retry without --all-pages or pass a different --after",
    ),
    tooMany: tooManyPages(
      "pagination exceeded maximum pages",
      "retry without --all-pages or pass a different --after",
    ),
  };
}

/**
 * The next `after` value, or `undefined` when the connection is complete.
 * `hasNextPage: true` without a usable cursor is a broken page, not the end.
 */
export function nextPageCursor(
  pageInfo: { hasNextPage?: boolean; endCursor?: string | null } | undefined,
  seen: Set<string>,
  missing: LinError,
  repeated: LinError,
): string | undefined {
  if (pageInfo?.hasNextPage !== true) return undefined;
  const cursor = pageInfo.endCursor;
  if (typeof cursor !== "string" || cursor === "") throw missing;
  if (seen.has(cursor)) throw repeated;
  return cursor;
}

/**
 * Walk remaining pages from `firstPage`. `after` is the cursor that produced
 * that page and is treated as already seen. Unique cursors still stop at
 * `MAX_PAGES` so a broken API cannot loop forever.
 */
export async function walkPages<T>(
  firstPage: { nodes: readonly T[]; pageInfo: PageInfo },
  fetchPage: (after: string) => Promise<{ nodes: readonly T[]; pageInfo: PageInfo }>,
  after: string | null,
  errors: PageErrors,
): Promise<{ nodes: T[]; pageInfo: PageInfo }> {
  const nodes = [...firstPage.nodes];
  const seen = new Set<string>();
  if (after) seen.add(after);
  let pageInfo = firstPage.pageInfo;
  let pages = 1;

  while (true) {
    const cursor = nextPageCursor(pageInfo, seen, errors.missing, errors.repeated);
    if (cursor === undefined) break;
    if (pages >= MAX_PAGES) throw errors.tooMany;
    seen.add(cursor);
    const next = await fetchPage(cursor);
    nodes.push(...next.nodes);
    pageInfo = next.pageInfo;
    pages += 1;
  }

  return { nodes, pageInfo: { hasNextPage: false, endCursor: pageInfo.endCursor } };
}

/**
 * One page, or every remaining page when `allPages` is set. Starts at `after`.
 * A cursor that repeats or goes missing is a loop or a truncated page, not more data.
 */
export async function collectPages<T>(
  fetchPage: (after: string | null) => Promise<{ nodes: readonly T[]; pageInfo: PageInfo }>,
  after: string | null,
  allPages: boolean,
  first?: { nodes: readonly T[]; pageInfo: PageInfo },
): Promise<{ nodes: T[]; pageInfo: PageInfo }> {
  const firstPage = first ?? (await fetchPage(after));
  if (!allPages) return { nodes: [...firstPage.nodes], pageInfo: firstPage.pageInfo };
  return walkPages(firstPage, (cursor) => fetchPage(cursor), after, listPageErrors());
}
