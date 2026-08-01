// owned by: issue agent
// Arguments in, GraphQL operation and variables out, exact rendered output.
// Fixtures are synthetic: workspace acme, team ENG, issues ENG-40..43.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toMeta, writeCached } from "../src/cache.ts";
import { keyFingerprint } from "../src/client.ts";
import {
  contentTypeFor,
  issueArchive,
  issueAttach,
  issueDelete,
  issueLink,
  issueRelate,
  issueReorder,
  issueSubscribe,
  issueUnarchive,
  issueUnrelate,
  issueUnsubscribe,
  react,
  resetUploadFetch,
  setUploadFetch,
} from "../src/commands/issue-extra.ts";
import { EXIT, LinError } from "../src/out.ts";
import type { CommandSpec, Flags } from "../src/registry.ts";
import { WARM_DATA } from "./fixtures.ts";
import { captureStdout, mock, sandbox, type Mock } from "./harness.ts";

const ENG40 = "aaaa0040-1111-4111-8111-aaaaaaaaaaaa";
const ENG41 = "aaaa0041-1111-4111-8111-aaaaaaaaaaaa";
const ENG42 = "aaaa0042-1111-4111-8111-aaaaaaaaaaaa";
const ENG43 = "aaaa0043-1111-4111-8111-aaaaaaaaaaaa";
const RELATION = "bbbb0001-2222-4222-8222-bbbbbbbbbbbb";
const COMMENT_A = "9f2ab41c-3333-4333-8333-cccccccccccc";
const COMMENT_B = "1c0d88ee-4444-4444-8444-dddddddddddd";

/** The `LinIssueId` lookup every mutation makes before it can write. */
function idLookup(id: string, identifier: string): { match: string; data: unknown } {
  return { match: "LinIssueId", data: { issue: { id, identifier } } };
}

interface Outcome {
  output: string;
  calls: Mock["calls"];
  error: unknown;
}

/** Run a command against stubbed responses in a private cache and env. */
async function attempt(
  command: CommandSpec,
  args: string[],
  responses: Parameters<typeof mock>[0],
  flags: Flags = {},
): Promise<Outcome> {
  const box = sandbox();
  writeCached(
    { ...toMeta(WARM_DATA, keyFingerprint(box.env)), fetchedAt: new Date().toISOString() },
    box.env,
  );
  const stub = mock(responses);
  const captured = captureStdout();
  let error: unknown;

  try {
    await command.run({ args, flags, config: { limit: 50 }, command });
  } catch (caught) {
    error = caught;
  } finally {
    captured.restore();
  }

  const outcome = { output: captured.text(), calls: stub.calls, error };
  stub.restore();
  box.cleanup();
  return outcome;
}

async function run(
  command: CommandSpec,
  args: string[],
  responses: Parameters<typeof mock>[0],
  flags: Flags = {},
): Promise<Outcome> {
  const outcome = await attempt(command, args, responses, flags);
  if (outcome.error) throw outcome.error;
  return outcome;
}

function failure(outcome: Outcome): LinError {
  expect(outcome.error).toBeInstanceOf(LinError);
  return outcome.error as LinError;
}

describe("issue archive / unarchive / delete", () => {
  test("archive resolves the UUID first, then prints the receipt", async () => {
    const { output, calls } = await run(issueArchive, ["ENG-42"], [
      idLookup(ENG42, "ENG-42"),
      { match: "LinIssueArchive", data: { issueArchive: { entity: { identifier: "ENG-42" } } } },
    ]);

    expect(calls.map((call) => call.operation)).toEqual(["LinIssueId", "LinIssueArchive"]);
    expect(calls[0]?.variables).toEqual({ id: "ENG-42" });
    expect(calls[1]?.variables).toEqual({ id: ENG42 });
    expect(output).toBe("archived: ENG-42\n");
  });

  test("unarchive prints the restored identifier", async () => {
    const { output, calls } = await run(issueUnarchive, ["ENG-42"], [
      idLookup(ENG42, "ENG-42"),
      { match: "LinIssueUnarchive", data: { issueUnarchive: { entity: { identifier: "ENG-42" } } } },
    ]);

    expect(calls[1]?.operation).toBe("LinIssueUnarchive");
    expect(calls[1]?.variables).toEqual({ id: ENG42 });
    expect(output).toBe("unarchived: ENG-42\n");
  });

  test("delete is trash, and says so", async () => {
    const { output, calls } = await run(issueDelete, ["ENG-42"], [
      idLookup(ENG42, "ENG-42"),
      { match: "LinIssueDelete", data: { issueDelete: { entity: { identifier: "ENG-42" } } } },
    ]);

    expect(calls[1]?.operation).toBe("LinIssueDelete");
    expect(calls[1]?.variables).toEqual({ id: ENG42 });
    expect(output).toBe("trashed: ENG-42\n");
    expect(issueDelete.summary).toContain("30 days");
  });

  test("a payload with no entity falls back to the identifier that was typed", async () => {
    const { output } = await run(issueArchive, ["https://linear.app/acme/issue/ENG-42/fix"], [
      idLookup(ENG42, "ENG-42"),
      { match: "LinIssueArchive", data: { issueArchive: { entity: null } } },
    ]);

    expect(output).toBe("archived: ENG-42\n");
  });

  test("a missing argument is exit 2 with the example", async () => {
    const error = failure(await attempt(issueArchive, [], []));
    expect(error.exitCode).toBe(EXIT.input);
    expect(error.message).toBe("an issue is required");
    expect(error.hint).toBe("example: lin issue archive ENG-42");
  });
});

describe("issue relate", () => {
  test("blocks writes a -> b", async () => {
    const { output, calls } = await run(issueRelate, ["ENG-42", "blocks", "ENG-43"], [
      idLookup(ENG42, "ENG-42"),
      idLookup(ENG43, "ENG-43"),
      {
        match: "LinIssueRelate",
        data: {
          issueRelationCreate: {
            issueRelation: {
              id: RELATION,
              type: "blocks",
              issue: { id: ENG42, identifier: "ENG-42" },
              relatedIssue: { id: ENG43, identifier: "ENG-43" },
            },
          },
        },
      },
    ]);

    expect(calls[2]?.operation).toBe("LinIssueRelate");
    expect(calls[2]?.variables).toEqual({
      input: { issueId: ENG42, relatedIssueId: ENG43, type: "blocks" },
    });
    expect(output).toBe("related: ENG-42 blocks ENG-43\n");
  });

  test("blocked-by inverts the pair, because Linear only stores blocks", async () => {
    const { output, calls } = await run(issueRelate, ["ENG-42", "blocked-by", "ENG-40"], [
      idLookup(ENG42, "ENG-42"),
      idLookup(ENG40, "ENG-40"),
      {
        match: "LinIssueRelate",
        data: {
          issueRelationCreate: {
            issueRelation: {
              id: RELATION,
              type: "blocks",
              issue: { id: ENG40, identifier: "ENG-40" },
              relatedIssue: { id: ENG42, identifier: "ENG-42" },
            },
          },
        },
      },
    ]);

    expect(calls[2]?.variables).toEqual({
      input: { issueId: ENG40, relatedIssueId: ENG42, type: "blocks" },
    });
    expect(output).toBe("related: ENG-40 blocks ENG-42\n");
  });

  test("duplicate passes straight through", async () => {
    const { calls } = await run(issueRelate, ["ENG-42", "duplicate", "ENG-43"], [
      idLookup(ENG42, "ENG-42"),
      idLookup(ENG43, "ENG-43"),
      {
        match: "LinIssueRelate",
        data: {
          issueRelationCreate: {
            issueRelation: {
              id: RELATION,
              type: "duplicate",
              issue: { id: ENG42, identifier: "ENG-42" },
              relatedIssue: { id: ENG43, identifier: "ENG-43" },
            },
          },
        },
      },
    ]);

    expect(calls[2]?.variables).toEqual({
      input: { issueId: ENG42, relatedIssueId: ENG43, type: "duplicate" },
    });
  });

  test("an unknown relation is exit 2 before any request", async () => {
    const outcome = await attempt(issueRelate, ["ENG-42", "supersedes", "ENG-43"], []);
    const error = failure(outcome);

    expect(error.exitCode).toBe(EXIT.input);
    expect(error.message).toBe('"supersedes" is not a relation');
    expect(error.hint).toBe("relations: blocks, blocked-by, related, duplicate");
    expect(outcome.calls).toHaveLength(0);
  });
});

describe("issue unrelate", () => {
  const relationsResponse = (nodes: unknown[], inverse: unknown[] = []) => ({
    match: "LinIssueRelations",
    data: { issue: { relations: { nodes }, inverseRelations: { nodes: inverse } } },
  });

  const blocks42to43 = {
    id: RELATION,
    type: "blocks",
    issue: { id: ENG42, identifier: "ENG-42" },
    relatedIssue: { id: ENG43, identifier: "ENG-43" },
  };

  test("finds the relation and deletes it by id", async () => {
    const { output, calls } = await run(issueUnrelate, ["ENG-42", "ENG-43"], [
      idLookup(ENG42, "ENG-42"),
      idLookup(ENG43, "ENG-43"),
      relationsResponse([blocks42to43]),
      { match: "LinIssueUnrelate", data: { issueRelationDelete: { success: true } } },
    ]);

    expect(calls.map((call) => call.operation)).toEqual([
      "LinIssueId",
      "LinIssueId",
      "LinIssueRelations",
      "LinIssueUnrelate",
    ]);
    expect(calls[2]?.variables).toEqual({ id: ENG42 });
    expect(calls[3]?.variables).toEqual({ id: RELATION });
    expect(output).toBe("unrelated: ENG-42 blocks ENG-43\n");
  });

  test("matches a relation pointing the other way", async () => {
    const { output, calls } = await run(issueUnrelate, ["ENG-42", "ENG-40"], [
      idLookup(ENG42, "ENG-42"),
      idLookup(ENG40, "ENG-40"),
      relationsResponse(
        [],
        [
          {
            id: RELATION,
            type: "blocks",
            issue: { id: ENG40, identifier: "ENG-40" },
            relatedIssue: { id: ENG42, identifier: "ENG-42" },
          },
        ],
      ),
      { match: "LinIssueUnrelate", data: { issueRelationDelete: { success: true } } },
    ]);

    expect(calls[3]?.variables).toEqual({ id: RELATION });
    expect(output).toBe("unrelated: ENG-40 blocks ENG-42\n");
  });

  test("no relation between the two is exit 4, listing the ones that exist", async () => {
    const outcome = await attempt(issueUnrelate, ["ENG-42", "ENG-41"], [
      idLookup(ENG42, "ENG-42"),
      idLookup(ENG41, "ENG-41"),
      relationsResponse([blocks42to43]),
    ]);
    const error = failure(outcome);

    expect(error.exitCode).toBe(EXIT.notFound);
    expect(error.message).toBe("no relation between ENG-42 and ENG-41");
    expect(error.hint).toBe("relations: ENG-42 blocks ENG-43");
    expect(outcome.calls).toHaveLength(3);
  });
});

describe("issue reorder", () => {
  const children = {
    match: "LinIssueChildren",
    data: {
      issue: {
        identifier: "ENG-40",
        children: {
          nodes: [
            { id: ENG41, identifier: "ENG-41" },
            { id: ENG42, identifier: "ENG-42" },
            { id: ENG43, identifier: "ENG-43" },
          ],
        },
      },
    },
  };

  test("rewrites subIssueSortOrder in steps of 100, in the given order", async () => {
    const { output, calls } = await run(issueReorder, ["ENG-40", "ENG-43", "ENG-41", "ENG-42"], [
      idLookup(ENG40, "ENG-40"),
      children,
      {
        match: "LinIssueReorder",
        data: { issueUpdate: { issue: { title: "Ship the importer", subIssueSortOrder: 100 } } },
      },
      {
        match: "LinIssueReorder",
        data: { issueUpdate: { issue: { title: "Rotate webhook secrets", subIssueSortOrder: 200 } } },
      },
      {
        match: "LinIssueReorder",
        data: { issueUpdate: { issue: { title: "Fix login redirect loop", subIssueSortOrder: 300 } } },
      },
    ]);

    expect(calls.map((call) => call.operation)).toEqual([
      "LinIssueId",
      "LinIssueChildren",
      "LinIssueReorder",
      "LinIssueReorder",
      "LinIssueReorder",
    ]);
    expect(calls[2]?.variables).toEqual({ id: ENG43, input: { subIssueSortOrder: 100 } });
    expect(calls[3]?.variables).toEqual({ id: ENG41, input: { subIssueSortOrder: 200 } });
    expect(calls[4]?.variables).toEqual({ id: ENG42, input: { subIssueSortOrder: 300 } });
    expect(output).toBe(
      "children[3]{id,title,order}:\n" +
        "  ENG-43,Ship the importer,100\n" +
        "  ENG-41,Rotate webhook secrets,200\n" +
        "  ENG-42,Fix login redirect loop,300\n",
    );
  });

  test("an issue that is not a sub-issue is exit 2, naming the offenders", async () => {
    const outcome = await attempt(issueReorder, ["ENG-40", "ENG-43", "ENG-57"], [
      idLookup(ENG40, "ENG-40"),
      children,
    ]);
    const error = failure(outcome);

    expect(error.exitCode).toBe(EXIT.input);
    expect(error.message).toBe("ENG-57 is not a sub-issue of ENG-40");
    expect(error.hint).toBe("sub-issues: ENG-41, ENG-42, ENG-43");
    expect(outcome.calls).toHaveLength(2);
  });

  test("the same sub-issue twice is exit 2 before any write", async () => {
    const outcome = await attempt(issueReorder, ["ENG-40", "ENG-41", "ENG-41"], [
      idLookup(ENG40, "ENG-40"),
      children,
    ]);
    const error = failure(outcome);

    expect(error.exitCode).toBe(EXIT.input);
    expect(error.message).toBe("ENG-41 is listed twice");
    expect(outcome.calls).toHaveLength(2);
  });

  test("no sub-issues at all is exit 2 before any request", async () => {
    const outcome = await attempt(issueReorder, ["ENG-40"], []);
    const error = failure(outcome);

    expect(error.exitCode).toBe(EXIT.input);
    expect(error.message).toBe("at least one sub-issue is required");
    expect(outcome.calls).toHaveLength(0);
  });
});

describe("issue link", () => {
  const linked = {
    match: "LinIssueLink",
    data: { attachmentLinkURL: { attachment: { issue: { identifier: "ENG-42" } } } },
  };

  test("attaches a URL and prints the receipt", async () => {
    const { output, calls } = await run(
      issueLink,
      ["ENG-42", "https://acme.test/runbook"],
      [idLookup(ENG42, "ENG-42"), linked],
    );

    expect(calls[1]?.operation).toBe("LinIssueLink");
    expect(calls[1]?.variables).toEqual({ issueId: ENG42, url: "https://acme.test/runbook" });
    expect(output).toBe("linked: ENG-42\n");
  });

  test("--title is passed through when given", async () => {
    const { calls } = await run(
      issueLink,
      ["ENG-42", "https://acme.test/runbook"],
      [idLookup(ENG42, "ENG-42"), linked],
      { title: "Runbook" },
    );

    expect(calls[1]?.variables).toEqual({
      issueId: ENG42,
      url: "https://acme.test/runbook",
      title: "Runbook",
    });
  });
});

describe("issue attach", () => {
  const ASSET_URL = "https://uploads.linear.app/acme/8f1/screenshot.png";
  const UPLOAD_URL = "https://storage.linear.test/signed/8f1?sig=abc";

  const upload = {
    match: "LinFileUpload",
    data: {
      fileUpload: {
        uploadFile: {
          uploadUrl: UPLOAD_URL,
          assetUrl: ASSET_URL,
          headers: [{ key: "x-linear-signature", value: "signed" }],
        },
      },
    },
  };

  const attached = {
    match: "LinIssueAttach",
    data: { attachmentCreate: { attachment: { issue: { identifier: "ENG-42" } } } },
  };

  interface Put {
    url: string;
    init: RequestInit;
  }

  /** Stub the one non-GraphQL HTTP call: the signed PUT of the bytes. */
  function capturePuts(status = 200): Put[] {
    const puts: Put[] = [];
    setUploadFetch(async (url, init) => {
      puts.push({ url, init });
      return new Response("", { status });
    });
    return puts;
  }

  function withFile(name: string, contents: string, body: (path: string) => Promise<void>) {
    return async () => {
      const dir = mkdtempSync(join(tmpdir(), "lin-attach-"));
      const path = join(dir, name);
      writeFileSync(path, contents);
      try {
        await body(path);
      } finally {
        resetUploadFetch();
        rmSync(dir, { recursive: true, force: true });
      }
    };
  }

  test(
    "uploads the bytes, then attaches the asset URL",
    withFile("screenshot.png", "fake png bytes", async (path) => {
      const puts = capturePuts();
      const { output, calls } = await run(issueAttach, ["ENG-42", path], [
        idLookup(ENG42, "ENG-42"),
        upload,
        attached,
      ]);

      expect(calls.map((call) => call.operation)).toEqual([
        "LinIssueId",
        "LinFileUpload",
        "LinIssueAttach",
      ]);
      expect(calls[1]?.variables).toEqual({
        contentType: "image/png",
        filename: "screenshot.png",
        size: 14,
      });
      expect(calls[2]?.variables).toEqual({
        input: { issueId: ENG42, url: ASSET_URL, title: "screenshot.png" },
      });

      expect(puts).toHaveLength(1);
      expect(puts[0]?.url).toBe(UPLOAD_URL);
      expect(puts[0]?.init.method).toBe("PUT");
      const headers = new Headers(puts[0]?.init.headers);
      expect(headers.get("content-type")).toBe("image/png");
      expect(headers.get("cache-control")).toBe("public, max-age=31536000");
      expect(headers.get("x-linear-signature")).toBe("signed");
      expect(new TextDecoder().decode(puts[0]?.init.body as Uint8Array)).toBe("fake png bytes");

      expect(output).toBe(`attached: ENG-42\nurl: ${ASSET_URL}\n`);
    }),
  );

  test(
    "a rejected upload stops before the attachment is created",
    withFile("screenshot.png", "fake png bytes", async (path) => {
      capturePuts(403);
      const outcome = await attempt(issueAttach, ["ENG-42", path], [
        idLookup(ENG42, "ENG-42"),
        upload,
        attached,
      ]);
      const error = failure(outcome);

      expect(error.exitCode).toBe(EXIT.api);
      expect(error.message).toBe("uploading screenshot.png failed with HTTP 403");
      expect(outcome.calls.map((call) => call.operation)).toEqual(["LinIssueId", "LinFileUpload"]);
    }),
  );

  test("an unreadable file is exit 2 before any request", async () => {
    const outcome = await attempt(issueAttach, ["ENG-42", "/nowhere/missing.png"], []);
    const error = failure(outcome);

    expect(error.exitCode).toBe(EXIT.input);
    expect(error.message).toBe('cannot read "/nowhere/missing.png"');
    expect(outcome.calls).toHaveLength(0);
  });

  test("content types come from the extension, unknown ones are opaque bytes", () => {
    expect(contentTypeFor("shot.PNG")).toBe("image/png");
    expect(contentTypeFor("trace.log")).toBe("text/plain");
    expect(contentTypeFor("notes.md")).toBe("text/markdown");
    expect(contentTypeFor("core.dump")).toBe("application/octet-stream");
  });
});

describe("issue subscribe / unsubscribe", () => {
  test("subscribe prints the receipt", async () => {
    const { output, calls } = await run(issueSubscribe, ["ENG-42"], [
      idLookup(ENG42, "ENG-42"),
      { match: "LinIssueSubscribe", data: { issueSubscribe: { issue: { identifier: "ENG-42" } } } },
    ]);

    expect(calls[1]?.operation).toBe("LinIssueSubscribe");
    expect(calls[1]?.variables).toEqual({ id: ENG42 });
    expect(output).toBe("subscribed: ENG-42\n");
  });

  test("unsubscribe prints the receipt", async () => {
    const { output, calls } = await run(issueUnsubscribe, ["ENG-42"], [
      idLookup(ENG42, "ENG-42"),
      {
        match: "LinIssueUnsubscribe",
        data: { issueUnsubscribe: { issue: { identifier: "ENG-42" } } },
      },
    ]);

    expect(calls[1]?.operation).toBe("LinIssueUnsubscribe");
    expect(calls[1]?.variables).toEqual({ id: ENG42 });
    expect(output).toBe("unsubscribed: ENG-42\n");
  });
});

describe("react", () => {
  const comments = {
    match: "LinIssueCommentIds",
    data: {
      issue: {
        identifier: "ENG-42",
        comments: { nodes: [{ id: COMMENT_A }, { id: COMMENT_B }] },
      },
    },
  };

  test("a bare issue identifier reacts to the issue", async () => {
    const { output, calls } = await run(react, ["ENG-42", "+1"], [
      idLookup(ENG42, "ENG-42"),
      {
        match: "LinReact",
        data: { reactionCreate: { reaction: { emoji: "+1", issue: { identifier: "ENG-42" } } } },
      },
    ]);

    expect(calls[1]?.operation).toBe("LinReact");
    expect(calls[1]?.variables).toEqual({ input: { issueId: ENG42, emoji: "+1" } });
    expect(output).toBe("reacted: +1 on ENG-42\n");
  });

  test("a comment ref with --issue reacts to the comment", async () => {
    const { output, calls } = await run(
      react,
      ["9f2ab41c", "eyes"],
      [
        idLookup(ENG42, "ENG-42"),
        comments,
        { match: "LinReact", data: { reactionCreate: { reaction: { emoji: "eyes", issue: null } } } },
      ],
      { issue: "ENG-42" },
    );

    expect(calls.map((call) => call.operation)).toEqual([
      "LinIssueId",
      "LinIssueCommentIds",
      "LinReact",
    ]);
    expect(calls[2]?.variables).toEqual({ input: { commentId: COMMENT_A, emoji: "eyes" } });
    expect(output).toBe("reacted: eyes on ENG-42 comment 9f2ab41c\n");
  });

  test("--comment names the comment when the emoji is the only argument", async () => {
    const { output, calls } = await run(
      react,
      ["tada"],
      [
        idLookup(ENG42, "ENG-42"),
        comments,
        { match: "LinReact", data: { reactionCreate: { reaction: { emoji: "tada", issue: null } } } },
      ],
      { comment: "1c0d88ee", issue: "ENG-42" },
    );

    expect(calls[2]?.variables).toEqual({ input: { commentId: COMMENT_B, emoji: "tada" } });
    expect(output).toBe("reacted: tada on ENG-42 comment 1c0d88ee\n");
  });

  test("an unknown comment ref is exit 4, listing the refs that exist", async () => {
    const outcome = await attempt(
      react,
      ["deadbeef", "+1"],
      [idLookup(ENG42, "ENG-42"), comments],
      { issue: "ENG-42" },
    );
    const error = failure(outcome);

    expect(error.exitCode).toBe(EXIT.notFound);
    expect(error.message).toBe('no comment "deadbeef" on ENG-42');
    expect(error.hint).toBe("comments: 9f2ab41c, 1c0d88ee");
  });

  test("no issue at all is exit 2 before any request", async () => {
    const outcome = await attempt(react, ["+1"], []);
    const error = failure(outcome);

    expect(error.exitCode).toBe(EXIT.input);
    expect(error.message).toBe("an issue is required");
    expect(outcome.calls).toHaveLength(0);
  });
});
