import { describe, expect, test } from "bun:test";
import { EXIT, LinError } from "../src/out.ts";
import { collectPages, MAX_PAGES, nextPageCursor, type PageInfo } from "../src/page.ts";

const missing = new LinError(EXIT.api, "pagination cursor missing", "hint");
const repeated = new LinError(EXIT.api, "pagination cursor repeated", "hint");

function page(nodes: string[], hasNextPage: boolean, endCursor: string | null): { nodes: string[]; pageInfo: PageInfo } {
  return { nodes, pageInfo: { hasNextPage, endCursor } };
}

describe("nextPageCursor", () => {
  test("a finished page has no cursor", () => {
    expect(nextPageCursor({ hasNextPage: false, endCursor: "c1" }, new Set(), missing, repeated)).toBeUndefined();
    expect(nextPageCursor(undefined, new Set(), missing, repeated)).toBeUndefined();
  });

  test("hasNextPage without a usable cursor is exit 1", () => {
    expect(() => nextPageCursor({ hasNextPage: true, endCursor: null }, new Set(), missing, repeated)).toThrow(
      missing,
    );
    expect(() => nextPageCursor({ hasNextPage: true, endCursor: "" }, new Set(), missing, repeated)).toThrow(missing);
    expect(() => nextPageCursor({ hasNextPage: true }, new Set(), missing, repeated)).toThrow(missing);
  });

  test("a cursor already seen is exit 1", () => {
    expect(() => nextPageCursor({ hasNextPage: true, endCursor: "c1" }, new Set(["c1"]), missing, repeated)).toThrow(
      repeated,
    );
  });

  test("a fresh cursor is returned", () => {
    expect(nextPageCursor({ hasNextPage: true, endCursor: "c2" }, new Set(["c1"]), missing, repeated)).toBe("c2");
  });
});

describe("collectPages", () => {
  test("one page is returned as-is when --all-pages is off", async () => {
    const calls: Array<string | null> = [];
    const result = await collectPages(
      async (after) => {
        calls.push(after);
        return page(["a"], true, "c1");
      },
      null,
      false,
    );
    expect(calls).toEqual([null]);
    expect(result).toEqual(page(["a"], true, "c1"));
  });

  test("walks until hasNextPage is false", async () => {
    const pages = new Map([
      [null, page(["a"], true, "c1")],
      ["c1", page(["b"], false, "c2")],
    ]);
    const result = await collectPages(async (after) => pages.get(after)!, null, true);
    expect(result).toEqual({ nodes: ["a", "b"], pageInfo: { hasNextPage: false, endCursor: "c2" } });
  });

  test("uses a provided first page and does not refetch it", async () => {
    const calls: Array<string | null> = [];
    const result = await collectPages(
      async (after) => {
        calls.push(after);
        return page(["b"], false, "c2");
      },
      "start",
      true,
      page(["a"], true, "c1"),
    );
    expect(calls).toEqual(["c1"]);
    expect(result.nodes).toEqual(["a", "b"]);
  });

  test("a missing cursor fails instead of rewriting the page as complete", async () => {
    await expect(collectPages(async () => page(["a"], true, null), null, true)).rejects.toMatchObject({
      exitCode: EXIT.api,
      message: "pagination cursor missing",
    });
  });

  test("a repeated cursor fails", async () => {
    await expect(
      collectPages(
        async (after) => (after === null ? page(["a"], true, "loop") : page(["b"], true, "loop")),
        null,
        true,
      ),
    ).rejects.toMatchObject({
      exitCode: EXIT.api,
      message: "pagination cursor repeated",
    });
  });

  test("a first page that repeats the starting --after fails", async () => {
    await expect(collectPages(async () => page(["a"], true, "start"), "start", true)).rejects.toMatchObject({
      exitCode: EXIT.api,
      message: "pagination cursor repeated",
    });
  });

  test("a later page that returns the starting --after fails", async () => {
    await expect(
      collectPages(
        async (after) => (after === "c1" ? page(["b"], true, "start") : page(["c"], false, "c2")),
        "start",
        true,
        page(["a"], true, "c1"),
      ),
    ).rejects.toMatchObject({
      exitCode: EXIT.api,
      message: "pagination cursor repeated",
    });
  });

  test("exactly MAX_PAGES unique pages is accepted", async () => {
    const result = await collectPages(
      async (after) => {
        const index = after === null ? 1 : Number(after.slice(1)) + 1;
        return page([`n${index}`], index < MAX_PAGES, `c${index}`);
      },
      null,
      true,
    );
    expect(result.nodes).toHaveLength(MAX_PAGES);
    expect(result.pageInfo).toEqual({ hasNextPage: false, endCursor: `c${MAX_PAGES}` });
  });

  test("unique cursors still fail at MAX_PAGES instead of walking forever", async () => {
    let fetched = 0;
    await expect(
      collectPages(
        async (after) => {
          fetched += 1;
          const index = after === null ? 1 : Number(after.slice(1)) + 1;
          return page([`n${index}`], true, `c${index}`);
        },
        null,
        true,
      ),
    ).rejects.toMatchObject({
      exitCode: EXIT.api,
      message: "pagination exceeded maximum pages",
    });
    expect(fetched).toBe(MAX_PAGES);
  });
});
