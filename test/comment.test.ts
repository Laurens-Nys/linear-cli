import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { toMeta, writeCached } from "../src/cache.ts";
import { keyFingerprint } from "../src/client.ts";
import {
  addCommand,
  editCommand,
  listCommand,
  resolveCommand,
  unresolveCommand,
} from "../src/commands/comment.ts";
import { EXIT, setFields } from "../src/out.ts";
import type { CommandSpec, Flags } from "../src/registry.ts";
import { captureStdout, mock, sandbox, type Mock, type MockResponse } from "./harness.ts";
import { WARM_DATA } from "./fixtures.ts";

const ENG42 = "f0f0f0f0-0001-4001-8001-f0f0f0f0f001";
const FIRST = "9f2ab41c-1111-4111-8111-999999999999";
const SECOND = "1c0d88ee-2222-4222-8222-888888888888";
/** Shares its first four characters with FIRST, to make a short ref ambiguous. */
const TWIN = "9f2acccc-3333-4333-8333-777777777777";

interface RunOptions {
  args?: string[];
  flags?: Flags;
  files?: Record<string, string>;
}

async function run(
  command: CommandSpec,
  options: RunOptions,
  responses: readonly MockResponse[],
  check: (output: string, stub: Mock) => void = () => {},
): Promise<void> {
  const box = sandbox();
  writeCached(
    { ...toMeta(WARM_DATA, keyFingerprint(box.env)), fetchedAt: new Date().toISOString() },
    box.env,
  );
  for (const [name, content] of Object.entries(options.files ?? {})) {
    writeFileSync(join(box.dir, name), content, "utf8");
  }

  const stub = mock(responses);
  const captured = captureStdout();
  try {
    setFields(options.flags?.["fields"]);
    await command.run({
      args: options.args ?? [],
      flags: Object.fromEntries(
        Object.entries(options.flags ?? {}).map(([flag, value]) => [
          flag,
          typeof value === "string" ? value.replace("<dir>", box.dir) : value,
        ]),
      ),
      config: { limit: 50 },
      command,
    });
    captured.restore();
    check(captured.text(), stub);
  } finally {
    captured.restore();
    stub.restore();
    box.cleanup();
  }
}

function refs(ids: readonly string[]): MockResponse {
  return {
    match: "LinCommentRefs",
    data: { issue: { id: ENG42, comments: { nodes: ids.map((id) => ({ id })) } } },
  };
}

describe("comment list", () => {
  test("prints the thread oldest first and marks a resolved one", async () => {
    await run(
      listCommand,
      { args: ["ENG-42"] },
      [
        {
          match: "LinCommentList",
          data: {
            issue: {
              comments: {
                // Deliberately out of order: the command owns "oldest first".
                nodes: [
                  {
                    id: SECOND,
                    createdAt: "2026-07-30T09:15:00.000Z",
                    body: "Fix pushed for review",
                    resolvedAt: "2026-07-30T10:00:00.000Z",
                    user: null,
                    botActor: { name: "agent" },
                  },
                  {
                    id: FIRST,
                    createdAt: "2026-07-29T08:00:00.000Z",
                    body: "Repro:  stale cookie,\nthen any deep link",
                    resolvedAt: null,
                    user: { displayName: "casey" },
                    botActor: null,
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: "c1" },
              },
            },
          },
        },
      ],
      (output, stub) => {
        expect(stub.calls[0]?.operation).toBe("LinCommentList");
        expect(stub.calls[0]?.variables).toEqual({ id: "ENG-42", first: 50, after: null });
        expect(output).toBe(
          "comments[2]{ref,author,date,body}:\n" +
            '  9f2ab41c,casey,2026-07-29,"Repro: stale cookie, then any deep link"\n' +
            "  1c0d88ee,agent,2026-07-30,Fix pushed for review (resolved)\n",
        );
      },
    );
  });

  test("--all-pages concatenates comments then sorts oldest first", async () => {
    await run(
      listCommand,
      { args: ["ENG-42"], flags: { "all-pages": true } },
      [
        {
          match: "LinCommentList",
          data: {
            issue: {
              comments: {
                nodes: [
                  {
                    id: SECOND,
                    createdAt: "2026-07-30T09:15:00.000Z",
                    body: "Fix pushed for review",
                    resolvedAt: null,
                    user: null,
                    botActor: { name: "agent" },
                  },
                ],
                pageInfo: { hasNextPage: true, endCursor: "c1" },
              },
            },
          },
        },
        {
          match: "LinCommentList",
          data: {
            issue: {
              comments: {
                nodes: [
                  {
                    id: FIRST,
                    createdAt: "2026-07-29T08:00:00.000Z",
                    body: "Repro first",
                    resolvedAt: null,
                    user: { displayName: "casey" },
                    botActor: null,
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: "c2" },
              },
            },
          },
        },
      ],
      (output, stub) => {
        expect(stub.calls.map((call) => call.variables?.after)).toEqual([null, "c1"]);
        expect(output).toBe(
          "comments[2]{ref,author,date,body}:\n" +
            "  9f2ab41c,casey,2026-07-29,Repro first\n" +
            "  1c0d88ee,agent,2026-07-30,Fix pushed for review\n",
        );
      },
    );
  });

  test("a missing comment pagination cursor is exit 1", async () => {
    await expect(
      run(
        listCommand,
        { args: ["ENG-42"], flags: { "all-pages": true } },
        [
          {
            match: "LinCommentList",
            data: {
              issue: {
                comments: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "" } },
              },
            },
          },
        ],
      ),
    ).rejects.toMatchObject({
      exitCode: EXIT.api,
      message: "pagination cursor missing",
    });
  });

  test("an issue with no comments prints an empty table", async () => {
    await run(
      listCommand,
      { args: ["ENG-42"] },
      [
        {
          match: "LinCommentList",
          data: { issue: { comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } },
        },
      ],
      (output) => {
        expect(output).toBe("comments[0]:\n");
      },
    );
  });

  test("no issue id is exit 2", async () => {
    await expect(run(listCommand, {}, [])).rejects.toMatchObject({ exitCode: EXIT.input });
  });
});

describe("comment add", () => {
  const receipt = {
    match: "LinCommentCreate",
    data: {
      commentCreate: {
        comment: { id: FIRST, url: "https://linear.app/acme/issue/ENG-42#comment-9f2ab41c" },
      },
    },
  };

  test("resolves the issue UUID and returns the new ref and url", async () => {
    await run(
      addCommand,
      { args: ["ENG-42"], flags: { message: "Fix pushed for review" } },
      [{ match: "LinIssueId", data: { issue: { id: ENG42, identifier: "ENG-42" } } }, receipt],
      (output, stub) => {
        expect(stub.calls[1]?.operation).toBe("LinCommentCreate");
        expect(stub.calls[1]?.variables).toEqual({
          input: { body: "Fix pushed for review", issueId: ENG42 },
        });
        expect(output).toBe(
          "created: 9f2ab41c\nurl: https://linear.app/acme/issue/ENG-42#comment-9f2ab41c\n",
        );
      },
    );
  });

  test("--reply-to threads under the parent and needs no separate id lookup", async () => {
    await run(
      addCommand,
      { args: ["ENG-42"], flags: { message: "Agreed", "reply-to": "9f2ab41c" } },
      [refs([FIRST, SECOND]), receipt],
      (_output, stub) => {
        expect(stub.calls[0]?.operation).toBe("LinCommentRefs");
        expect(stub.calls[1]?.variables).toEqual({
          input: { body: "Agreed", issueId: ENG42, parentId: FIRST },
        });
      },
    );
  });

  test("-m @file reads the body from disk", async () => {
    await run(
      addCommand,
      { args: ["ENG-42"], files: { "note.md": "Repro attached.\n" }, flags: { message: "@<dir>/note.md" } },
      [{ match: "LinIssueId", data: { issue: { id: ENG42, identifier: "ENG-42" } } }, receipt],
      (_output, stub) => {
        expect(stub.calls[1]?.variables).toMatchObject({ input: { body: "Repro attached.\n" } });
      },
    );
  });

  test("no message is exit 2", async () => {
    await expect(run(addCommand, { args: ["ENG-42"] }, [])).rejects.toMatchObject({
      exitCode: EXIT.input,
      hint: expect.stringContaining("-m"),
    });
  });
});

describe("comment refs", () => {
  test("a prefix matching two comments is exit 2 with both candidates", async () => {
    await expect(
      run(editCommand, { args: ["ENG-42", "9f2a"], flags: { message: "x" } }, [refs([FIRST, TWIN])]),
    ).rejects.toMatchObject({
      exitCode: EXIT.input,
      hint: "refs: 9f2ab41c, 9f2acccc",
    });
  });

  test("a ref that matches nothing is exit 4 with the refs that exist", async () => {
    await expect(
      run(editCommand, { args: ["ENG-42", "deadbeef"], flags: { message: "x" } }, [refs([FIRST])]),
    ).rejects.toMatchObject({ exitCode: EXIT.notFound, hint: "refs: 9f2ab41c" });
  });

  test("a full UUID is accepted as well as the 8-character ref", async () => {
    await run(
      editCommand,
      { args: ["ENG-42", SECOND], flags: { message: "Corrected" } },
      [refs([FIRST, SECOND]), { match: "LinCommentUpdate", data: { commentUpdate: { comment: { id: SECOND } } } }],
      (output, stub) => {
        expect(stub.calls[1]?.variables).toEqual({ id: SECOND, input: { body: "Corrected" } });
        expect(output).toBe("edited: 1c0d88ee\n");
      },
    );
  });
});

describe("comment resolve and unresolve", () => {
  test("resolve marks the thread and receipts the ref", async () => {
    await run(
      resolveCommand,
      { args: ["ENG-42", "9f2ab41c"] },
      [refs([FIRST, SECOND]), { match: "LinCommentResolve", data: { commentResolve: { comment: { id: FIRST } } } }],
      (output, stub) => {
        expect(stub.calls[1]?.operation).toBe("LinCommentResolve");
        expect(stub.calls[1]?.variables).toEqual({ id: FIRST });
        expect(output).toBe("resolved: 9f2ab41c\n");
      },
    );
  });

  test("unresolve clears it again", async () => {
    await run(
      unresolveCommand,
      { args: ["ENG-42", "9f2ab41c"] },
      [
        refs([FIRST, SECOND]),
        { match: "LinCommentUnresolve", data: { commentUnresolve: { comment: { id: FIRST } } } },
      ],
      (output, stub) => {
        expect(stub.calls[1]?.operation).toBe("LinCommentUnresolve");
        expect(output).toBe("unresolved: 9f2ab41c\n");
      },
    );
  });

  test("a missing ref is exit 2", async () => {
    await expect(run(resolveCommand, { args: ["ENG-42"] }, [])).rejects.toMatchObject({
      exitCode: EXIT.input,
      message: "comment resolve needs a comment ref",
    });
  });
});
