// owned by: issue agent
// Comment threads: list, add, edit, resolve, unresolve.
//
// A comment ref is the first 8 hex characters of its UUID. Every ref argument
// is matched by prefix against the issue's own comments, so a full UUID works
// too and a ref from another issue is a miss rather than a wrong write.

import { gql } from "../client.ts";
import { created, EXIT, LinError, selectColumns, simpleReceipt, table } from "../out.ts";
import { defineCommand, flagBool, flagString, type CommandSpec, type Flags } from "../registry.ts";
import { resolveIssueUUID } from "../resolve.ts";
import {
  bodyInput,
  collectPages,
  COMMENT_COLUMNS,
  COMMENT_SELECTION,
  commentRef,
  commentRows,
  continuation,
  issueArg,
  limitOf,
  morePages,
  resolveOptions,
  type CommentNode,
  type PageInfo,
} from "./issue.ts";

const REF_PAGE = 100;

const LIST_QUERY = `query LinCommentList($id: String!, $first: Int!, $after: String) {
  issue(id: $id) {
    comments(first: $first, after: $after) {
      nodes { ${COMMENT_SELECTION} }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

interface ListResponse {
  issue: { comments: { nodes: CommentNode[]; pageInfo: PageInfo } };
}

const REFS_QUERY = `query LinCommentRefs($id: String!, $first: Int!) {
  issue(id: $id) { id comments(first: $first) { nodes { id } } }
}`;

interface RefsResponse {
  issue: { id: string; comments: { nodes: { id: string }[] } };
}

const CREATE_MUTATION = `mutation LinCommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { comment { id url } }
}`;

const UPDATE_MUTATION = `mutation LinCommentUpdate($id: String!, $input: CommentUpdateInput!) {
  commentUpdate(id: $id, input: $input) { comment { id } }
}`;

const RESOLVE_MUTATION = `mutation LinCommentResolve($id: String!) {
  commentResolve(id: $id) { comment { id } }
}`;

const UNRESOLVE_MUTATION = `mutation LinCommentUnresolve($id: String!) {
  commentUnresolve(id: $id) { comment { id } }
}`;

interface CommentPayload {
  comment: { id: string; url?: string };
}

/** The issue's UUID plus the comment matching `ref`, in one round trip. */
async function findComment(issueRef: string, ref: string): Promise<{ issueId: string; commentId: string }> {
  const data = await gql<RefsResponse>(REFS_QUERY, { id: issueRef, first: REF_PAGE });
  const ids = data.issue.comments.nodes.map((node) => node.id);
  const matches = ids.filter((id) => id.toLowerCase().startsWith(ref.toLowerCase()));

  const first = matches[0];
  if (matches.length === 1 && first !== undefined) return { issueId: data.issue.id, commentId: first };
  if (matches.length === 0) {
    throw new LinError(
      EXIT.notFound,
      `no comment "${ref}" on ${issueRef}`,
      ids.length > 0 ? `refs: ${ids.map(commentRef).join(", ")}` : undefined,
    );
  }
  throw new LinError(EXIT.input, `comment "${ref}" is ambiguous`, `refs: ${matches.map(commentRef).join(", ")}`);
}

async function messageInput(flags: Flags, command: string): Promise<string> {
  const body = await bodyInput(flagString(flags, "message"));
  if (body === undefined || body.trim() === "") {
    throw new LinError(EXIT.input, `${command} needs a message`, `pass -m "text", -m @file, or -m - to read stdin`);
  }
  return body;
}

const MESSAGE_FLAG = {
  type: "string",
  short: "m",
  valueHint: "text|@file|-",
  doc: "comment body: inline text, @file, or - to read stdin",
} as const;

export const listCommand = defineCommand({
  name: "comment",
  group: "comment",
  summary: "list an issue's comments oldest first; a resolved thread is marked (resolved) in its body",
  allPages: true,
  fields: COMMENT_COLUMNS,
  args: [{ name: "issue", doc: "issue identifier, URL or UUID", required: true }],
  examples: ["lin comment ENG-42"],
  async run({ args, flags, config }) {
    selectColumns(COMMENT_COLUMNS);
    const issueRef = issueArg(args, "comment");
    const first = limitOf(config);
    const after = flagString(flags, "after") ?? null;
    const page = await collectPages(
      async (cursor) => {
        const data = await gql<ListResponse>(LIST_QUERY, {
          id: issueRef,
          first,
          after: cursor,
        });
        return data.issue.comments;
      },
      after,
      flagBool(flags, "all-pages"),
    );

    // Oldest first is the contract; the API's own order is not guaranteed.
    const nodes = [...page.nodes].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    table("comments", commentRows(nodes), COMMENT_COLUMNS, {
      more: morePages(page.pageInfo, undefined, (cursor) =>
        continuation("comment", [args[0] as string], flags, cursor),
      ),
    });
  },
});

export const addCommand = defineCommand({
  name: "comment add",
  group: "comment",
  summary: "add a comment to an issue",
  args: [{ name: "issue", doc: "issue identifier, URL or UUID", required: true }],
  flags: {
    message: MESSAGE_FLAG,
    "reply-to": { type: "string", valueHint: "ref", doc: "reply under this comment instead of starting a thread" },
  },
  examples: ['lin comment add ENG-42 -m "Fix pushed for review"', "lin comment add ENG-42 -m @review.md --reply-to 9f2ab41c"],
  async run({ args, flags }) {
    const issueRef = issueArg(args, "comment add");
    const body = await messageInput(flags, "comment add");
    const replyTo = flagString(flags, "reply-to");

    const input: Record<string, unknown> = { body };
    if (replyTo === undefined) {
      input["issueId"] = await resolveIssueUUID(issueRef, resolveOptions(flags));
    } else {
      // The same lookup yields the parent comment and the issue's UUID.
      const found = await findComment(issueRef, replyTo);
      input["issueId"] = found.issueId;
      input["parentId"] = found.commentId;
    }

    const data = await gql<{ commentCreate: CommentPayload }>(CREATE_MUTATION, { input }, { retry: false });
    const comment = data.commentCreate.comment;
    created(commentRef(comment.id), comment.url);
  },
});

export const editCommand = defineCommand({
  name: "comment edit",
  group: "comment",
  summary: "rewrite the body of a comment",
  args: [
    { name: "issue", doc: "issue identifier, URL or UUID", required: true },
    { name: "ref", doc: "comment ref, the first 8 characters of its UUID", required: true },
  ],
  flags: { message: MESSAGE_FLAG },
  examples: ['lin comment edit ENG-42 9f2ab41c -m "Corrected: the cookie is stale, not missing"'],
  async run({ args, flags }) {
    const issueRef = issueArg(args, "comment edit");
    const ref = args[1];
    if (ref === undefined) {
      throw new LinError(EXIT.input, "comment edit needs a comment ref", "example: lin comment edit ENG-42 9f2ab41c -m \"...\"");
    }
    const body = await messageInput(flags, "comment edit");

    const { commentId } = await findComment(issueRef, ref);
    await gql<{ commentUpdate: CommentPayload }>(
      UPDATE_MUTATION,
      { id: commentId, input: { body } },
      { retry: false },
    );
    simpleReceipt("edited", commentRef(commentId));
  },
});

/** resolve and unresolve differ only in their mutation and their receipt word. */
function resolutionCommand(name: "resolve" | "unresolve"): CommandSpec {
  const document = name === "resolve" ? RESOLVE_MUTATION : UNRESOLVE_MUTATION;
  const past = name === "resolve" ? "resolved" : "unresolved";

  return defineCommand({
    name: `comment ${name}`,
    group: "comment",
    summary: `mark a comment thread ${past}`,
    args: [
      { name: "issue", doc: "issue identifier, URL or UUID", required: true },
      { name: "ref", doc: "comment ref, the first 8 characters of its UUID", required: true },
    ],
    examples: [`lin comment ${name} ENG-42 9f2ab41c`],
    async run({ args }) {
      const issueRef = issueArg(args, `comment ${name}`);
      const ref = args[1];
      if (ref === undefined) {
        throw new LinError(
          EXIT.input,
          `comment ${name} needs a comment ref`,
          `example: lin comment ${name} ENG-42 9f2ab41c`,
        );
      }

      const { commentId } = await findComment(issueRef, ref);
      await gql<{ [key: string]: CommentPayload }>(document, { id: commentId }, { retry: false });
      simpleReceipt(past, commentRef(commentId));
    },
  });
}

export const resolveCommand = resolutionCommand("resolve");
export const unresolveCommand = resolutionCommand("unresolve");
