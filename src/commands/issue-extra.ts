// owned by: issue agent
// Issue lifecycle beyond create and update: archive, unarchive, delete,
// relations, sub-issue ordering, attachments, subscriptions, and reactions.
// See INTERFACES.md at the repo root before editing.

import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { gql } from "../client.ts";
import { EXIT, LinError, record, simpleReceipt, table, type Row } from "../out.ts";
import { defineCommand, flagString } from "../registry.ts";
import { issueIdentifierFrom, resolveIssueUUID } from "../resolve.ts";

// --- shared -----------------------------------------------------------------

interface IssueRef {
  identifier: string;
}

function requiredArg(
  args: readonly string[],
  index: number,
  what: string,
  example: string,
): string {
  const value = args[index];
  if (value === undefined || value === "") {
    throw new LinError(EXIT.input, `${what} is required`, `example: ${example}`);
  }
  return value;
}

/** What to print for a ref the API never echoed back. A UUID stays a UUID. */
function refLabel(ref: string): string {
  return issueIdentifierFrom(ref) ?? ref;
}

/** Prefer the identifier the mutation read back; fall back to what was typed. */
function readBackLabel(ref: string, issue: IssueRef | null | undefined): string {
  return issue?.identifier ?? refLabel(ref);
}

// --- archive, unarchive, delete ---------------------------------------------

interface ArchiveResponse {
  issueArchive: { entity: IssueRef | null };
}

interface UnarchiveResponse {
  issueUnarchive: { entity: IssueRef | null };
}

interface DeleteResponse {
  issueDelete: { entity: IssueRef | null };
}

const ARCHIVE_MUTATION = `mutation LinIssueArchive($id: String!) {
  issueArchive(id: $id) { entity { identifier } }
}`;

const UNARCHIVE_MUTATION = `mutation LinIssueUnarchive($id: String!) {
  issueUnarchive(id: $id) { entity { identifier } }
}`;

const DELETE_MUTATION = `mutation LinIssueDelete($id: String!) {
  issueDelete(id: $id) { entity { identifier } }
}`;

export const issueArchive = defineCommand({
  name: "issue archive",
  group: "issue",
  summary: "archive an issue",
  args: [{ name: "id", doc: "issue identifier, URL, or UUID", required: true }],
  examples: ["lin issue archive ENG-42"],
  async run({ args }) {
    const ref = requiredArg(args, 0, "an issue", "lin issue archive ENG-42");
    const data = await gql<ArchiveResponse>(ARCHIVE_MUTATION, { id: await resolveIssueUUID(ref) });
    simpleReceipt("archived", readBackLabel(ref, data.issueArchive.entity));
  },
});

export const issueUnarchive = defineCommand({
  name: "issue unarchive",
  group: "issue",
  summary: "restore an archived issue",
  args: [{ name: "id", doc: "issue identifier, URL, or UUID", required: true }],
  examples: ["lin issue unarchive ENG-42"],
  async run({ args }) {
    const ref = requiredArg(args, 0, "an issue", "lin issue unarchive ENG-42");
    const data = await gql<UnarchiveResponse>(UNARCHIVE_MUTATION, {
      id: await resolveIssueUUID(ref),
    });
    simpleReceipt("unarchived", readBackLabel(ref, data.issueUnarchive.entity));
  },
});

export const issueDelete = defineCommand({
  name: "issue delete",
  group: "issue",
  summary: "move an issue to the trash, recoverable for 30 days",
  args: [{ name: "id", doc: "issue identifier, URL, or UUID", required: true }],
  examples: ["lin issue delete ENG-42"],
  async run({ args }) {
    const ref = requiredArg(args, 0, "an issue", "lin issue delete ENG-42");
    const data = await gql<DeleteResponse>(DELETE_MUTATION, { id: await resolveIssueUUID(ref) });
    simpleReceipt("trashed", readBackLabel(ref, data.issueDelete.entity));
  },
});

// --- relations --------------------------------------------------------------

/**
 * `blocked-by` is the only inversion: Linear stores one `blocks` edge, so
 * "a blocked-by b" is written as "b blocks a".
 */
const RELATION_KINDS = ["blocks", "blocked-by", "related", "duplicate"] as const;

interface RelationInput {
  issueId: string;
  relatedIssueId: string;
  type: string;
}

function relationInput(kind: string, aId: string, bId: string): RelationInput {
  if (kind === "blocked-by") return { issueId: bId, relatedIssueId: aId, type: "blocks" };
  return { issueId: aId, relatedIssueId: bId, type: kind };
}

function assertRelationKind(kind: string): void {
  if (!(RELATION_KINDS as readonly string[]).includes(kind)) {
    throw new LinError(
      EXIT.input,
      `"${kind}" is not a relation`,
      `relations: ${RELATION_KINDS.join(", ")}`,
    );
  }
}

interface RelationNode {
  id: string;
  type: string;
  issue: { id: string; identifier: string };
  relatedIssue: { id: string; identifier: string };
}

function relationSentence(node: RelationNode): string {
  return `${node.issue.identifier} ${node.type} ${node.relatedIssue.identifier}`;
}

interface RelateResponse {
  issueRelationCreate: { issueRelation: RelationNode };
}

const RELATE_MUTATION = `mutation LinIssueRelate($input: IssueRelationCreateInput!) {
  issueRelationCreate(input: $input) {
    issueRelation {
      id
      type
      issue { id identifier }
      relatedIssue { id identifier }
    }
  }
}`;

export const issueRelate = defineCommand({
  name: "issue relate",
  group: "issue",
  summary: "link two issues with a native relation",
  args: [
    { name: "a", doc: "issue identifier, URL, or UUID", required: true },
    { name: "relation", doc: `one of ${RELATION_KINDS.join(", ")}`, required: true },
    { name: "b", doc: "the other issue", required: true },
  ],
  examples: ["lin issue relate ENG-42 blocks ENG-43", "lin issue relate ENG-42 blocked-by ENG-40"],
  async run({ args }) {
    const example = "lin issue relate ENG-42 blocks ENG-43";
    const aRef = requiredArg(args, 0, "an issue", example);
    const kind = requiredArg(args, 1, "a relation", example).toLowerCase();
    const bRef = requiredArg(args, 2, "a second issue", example);
    assertRelationKind(kind);

    const aId = await resolveIssueUUID(aRef);
    const bId = await resolveIssueUUID(bRef);
    const data = await gql<RelateResponse>(RELATE_MUTATION, {
      input: relationInput(kind, aId, bId),
    });

    simpleReceipt("related", relationSentence(data.issueRelationCreate.issueRelation));
  },
});

interface RelationsResponse {
  issue: {
    relations: { nodes: RelationNode[] };
    inverseRelations: { nodes: RelationNode[] };
  };
}

const RELATIONS_QUERY = `query LinIssueRelations($id: String!) {
  issue(id: $id) {
    relations(first: 50) {
      nodes { id type issue { id identifier } relatedIssue { id identifier } }
    }
    inverseRelations(first: 50) {
      nodes { id type issue { id identifier } relatedIssue { id identifier } }
    }
  }
}`;

const UNRELATE_MUTATION = `mutation LinIssueUnrelate($id: String!) {
  issueRelationDelete(id: $id) { success }
}`;

export const issueUnrelate = defineCommand({
  name: "issue unrelate",
  group: "issue",
  summary: "remove the relation between two issues",
  args: [
    { name: "a", doc: "issue identifier, URL, or UUID", required: true },
    { name: "b", doc: "the other issue", required: true },
  ],
  examples: ["lin issue unrelate ENG-42 ENG-43"],
  async run({ args }) {
    const example = "lin issue unrelate ENG-42 ENG-43";
    const aRef = requiredArg(args, 0, "an issue", example);
    const bRef = requiredArg(args, 1, "a second issue", example);

    const aId = await resolveIssueUUID(aRef);
    const bId = await resolveIssueUUID(bRef);

    const data = await gql<RelationsResponse>(RELATIONS_QUERY, { id: aId });
    const nodes = [...data.issue.relations.nodes, ...data.issue.inverseRelations.nodes];
    // One pair can hold several relations; remove one per run so the receipt
    // always names exactly what went away.
    const match = nodes.find((node) => node.issue.id === bId || node.relatedIssue.id === bId);

    if (!match) {
      const others = nodes.map(relationSentence);
      throw new LinError(
        EXIT.notFound,
        `no relation between ${refLabel(aRef)} and ${refLabel(bRef)}`,
        others.length > 0 ? `relations: ${others.join(", ")}` : undefined,
      );
    }

    await gql<{ issueRelationDelete: { success: boolean } }>(UNRELATE_MUTATION, { id: match.id });
    simpleReceipt("unrelated", relationSentence(match));
  },
});

// --- sub-issue ordering -----------------------------------------------------

interface ChildNode {
  id: string;
  identifier: string;
}

interface ChildrenResponse {
  issue: { identifier: string; children: { nodes: ChildNode[] } };
}

interface ReorderResponse {
  issueUpdate: { issue: { title: string; subIssueSortOrder: number | null } | null };
}

const CHILDREN_QUERY = `query LinIssueChildren($id: String!) {
  issue(id: $id) {
    identifier
    children(first: 250) { nodes { id identifier } }
  }
}`;

const REORDER_MUTATION = `mutation LinIssueReorder($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { issue { title subIssueSortOrder } }
}`;

/** Sub-issue positions are spaced so a later insert has room between them. */
const ORDER_STEP = 100;

export const issueReorder = defineCommand({
  name: "issue reorder",
  group: "issue",
  summary: "set the order of a parent's sub-issues",
  args: [
    { name: "parent", doc: "the parent issue", required: true },
    { name: "child", doc: "sub-issues in the order you want them", required: true, variadic: true },
  ],
  examples: ["lin issue reorder ENG-40 ENG-43 ENG-41 ENG-42"],
  async run({ args }) {
    const example = "lin issue reorder ENG-40 ENG-43 ENG-41";
    const parentRef = requiredArg(args, 0, "a parent issue", example);
    const childRefs = args.slice(1);
    if (childRefs.length === 0) {
      throw new LinError(EXIT.input, "at least one sub-issue is required", `example: ${example}`);
    }

    const data = await gql<ChildrenResponse>(CHILDREN_QUERY, {
      id: await resolveIssueUUID(parentRef),
    });
    const parent = data.issue.identifier;
    const children = data.issue.children.nodes;

    const ordered: ChildNode[] = [];
    const offenders: string[] = [];
    const seen = new Set<string>();

    for (const ref of childRefs) {
      const wanted = refLabel(ref).toLowerCase();
      const child = children.find(
        (node) => node.identifier.toLowerCase() === wanted || node.id.toLowerCase() === wanted,
      );
      if (!child) {
        offenders.push(refLabel(ref));
        continue;
      }
      if (seen.has(child.id)) {
        throw new LinError(
          EXIT.input,
          `${child.identifier} is listed twice`,
          "give each sub-issue once, in the order you want",
        );
      }
      seen.add(child.id);
      ordered.push(child);
    }

    if (offenders.length > 0) {
      throw new LinError(
        EXIT.input,
        `${offenders.join(", ")} ${offenders.length === 1 ? "is not a sub-issue" : "are not sub-issues"} of ${parent}`,
        `sub-issues: ${children.map((node) => node.identifier).join(", ")}`,
      );
    }

    const rows: Row[] = [];
    for (const [index, child] of ordered.entries()) {
      const order = (index + 1) * ORDER_STEP;
      const updated = await gql<ReorderResponse>(REORDER_MUTATION, {
        id: child.id,
        input: { subIssueSortOrder: order },
      });
      rows.push({
        id: child.identifier,
        title: updated.issueUpdate.issue?.title,
        order: updated.issueUpdate.issue?.subIssueSortOrder ?? order,
      });
    }

    table("children", rows, ["id", "title", "order"]);
  },
});

// --- attachments ------------------------------------------------------------

interface AttachmentResponse {
  attachmentLinkURL: { attachment: { issue: IssueRef } };
}

const LINK_MUTATION = `mutation LinIssueLink($issueId: String!, $url: String!, $title: String) {
  attachmentLinkURL(issueId: $issueId, url: $url, title: $title) {
    attachment { issue { identifier } }
  }
}`;

export const issueLink = defineCommand({
  name: "issue link",
  group: "issue",
  summary: "attach a URL to an issue",
  args: [
    { name: "id", doc: "issue identifier, URL, or UUID", required: true },
    { name: "url", doc: "the URL to attach", required: true },
  ],
  flags: {
    title: {
      type: "string",
      valueHint: "text",
      doc: "attachment title; Linear reads it from the page when omitted",
    },
  },
  examples: [
    "lin issue link ENG-42 https://github.com/acme/api/pull/7",
    'lin issue link ENG-42 https://acme.test/runbook --title "Runbook"',
  ],
  async run({ args, flags }) {
    const example = "lin issue link ENG-42 https://acme.test/doc";
    const ref = requiredArg(args, 0, "an issue", example);
    const url = requiredArg(args, 1, "a URL", example);
    const title = flagString(flags, "title");

    const data = await gql<AttachmentResponse>(LINK_MUTATION, {
      issueId: await resolveIssueUUID(ref),
      url,
      ...(title !== undefined && { title }),
    });

    simpleReceipt("linked", data.attachmentLinkURL.attachment.issue.identifier);
  },
});

/**
 * The one HTTP call in the CLI that is not `client.gql`: Linear hands out a
 * pre-signed URL and the bytes go straight to storage. Tests inject a stub here,
 * the way `client.setFetch` works for GraphQL.
 */
export type UploadFetch = (url: string, init: RequestInit) => Promise<Response>;

const browserFetch: UploadFetch = (url, init) => globalThis.fetch(url, init);
let uploadFetch: UploadFetch = browserFetch;

export function setUploadFetch(impl: UploadFetch): void {
  uploadFetch = impl;
}

export function resetUploadFetch(): void {
  uploadFetch = browserFetch;
}

/** Extensions an agent actually attaches: screenshots, logs, diffs, exports. */
const CONTENT_TYPES: Record<string, string> = {
  ".csv": "text/csv",
  ".diff": "text/x-diff",
  ".gif": "image/gif",
  ".gz": "application/gzip",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".patch": "text/x-diff",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".zip": "application/zip",
};

export function contentTypeFor(filename: string): string {
  return CONTENT_TYPES[extname(filename).toLowerCase()] ?? "application/octet-stream";
}

interface UploadResponse {
  fileUpload: {
    uploadFile: {
      uploadUrl: string;
      assetUrl: string;
      headers: { key: string; value: string }[];
    } | null;
  };
}

interface AttachCreateResponse {
  attachmentCreate: { attachment: { issue: IssueRef } };
}

const UPLOAD_MUTATION = `mutation LinFileUpload($contentType: String!, $filename: String!, $size: Int!) {
  fileUpload(contentType: $contentType, filename: $filename, size: $size) {
    uploadFile { uploadUrl assetUrl headers { key value } }
  }
}`;

const ATTACH_MUTATION = `mutation LinIssueAttach($input: AttachmentCreateInput!) {
  attachmentCreate(input: $input) { attachment { issue { identifier } } }
}`;

export const issueAttach = defineCommand({
  name: "issue attach",
  group: "issue",
  summary: "upload a local file and attach it to an issue",
  args: [
    { name: "id", doc: "issue identifier, URL, or UUID", required: true },
    { name: "file", doc: "path to a local file", required: true },
  ],
  examples: ["lin issue attach ENG-42 ./screenshot.png"],
  async run({ args }) {
    const example = "lin issue attach ENG-42 ./screenshot.png";
    const ref = requiredArg(args, 0, "an issue", example);
    const path = requiredArg(args, 1, "a file", example);

    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      throw new LinError(EXIT.input, `cannot read "${path}"`, "pass a path to a readable file");
    }

    const filename = basename(path);
    const contentType = contentTypeFor(filename);
    const issueId = await resolveIssueUUID(ref);

    const upload = await gql<UploadResponse>(UPLOAD_MUTATION, {
      contentType,
      filename,
      size: bytes.byteLength,
    });
    const target = upload.fileUpload.uploadFile;
    if (!target) {
      throw new LinError(EXIT.api, `Linear returned no upload URL for ${filename}`);
    }

    // Linear signs the PUT: its headers must be sent verbatim or storage answers 403.
    const headers = new Headers({
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000",
    });
    for (const header of target.headers) headers.set(header.key, header.value);

    const response = await uploadFetch(target.uploadUrl, { method: "PUT", headers, body: bytes });
    if (!response.ok) {
      throw new LinError(
        EXIT.api,
        `uploading ${filename} failed with HTTP ${response.status}`,
        "the signed upload URL is short-lived; run the command again",
      );
    }

    const created = await gql<AttachCreateResponse>(ATTACH_MUTATION, {
      input: { issueId, url: target.assetUrl, title: filename },
    });

    record({
      attached: created.attachmentCreate.attachment.issue.identifier,
      url: target.assetUrl,
    });
  },
});

// --- subscriptions ----------------------------------------------------------

interface SubscribeResponse {
  issueSubscribe: { issue: IssueRef | null };
}

interface UnsubscribeResponse {
  issueUnsubscribe: { issue: IssueRef | null };
}

const SUBSCRIBE_MUTATION = `mutation LinIssueSubscribe($id: String!) {
  issueSubscribe(id: $id) { issue { identifier } }
}`;

const UNSUBSCRIBE_MUTATION = `mutation LinIssueUnsubscribe($id: String!) {
  issueUnsubscribe(id: $id) { issue { identifier } }
}`;

export const issueSubscribe = defineCommand({
  name: "issue subscribe",
  group: "issue",
  summary: "follow an issue's updates",
  args: [{ name: "id", doc: "issue identifier, URL, or UUID", required: true }],
  examples: ["lin issue subscribe ENG-42"],
  async run({ args }) {
    const ref = requiredArg(args, 0, "an issue", "lin issue subscribe ENG-42");
    const data = await gql<SubscribeResponse>(SUBSCRIBE_MUTATION, {
      id: await resolveIssueUUID(ref),
    });
    simpleReceipt("subscribed", readBackLabel(ref, data.issueSubscribe.issue));
  },
});

export const issueUnsubscribe = defineCommand({
  name: "issue unsubscribe",
  group: "issue",
  summary: "stop following an issue",
  args: [{ name: "id", doc: "issue identifier, URL, or UUID", required: true }],
  examples: ["lin issue unsubscribe ENG-42"],
  async run({ args }) {
    const ref = requiredArg(args, 0, "an issue", "lin issue unsubscribe ENG-42");
    const data = await gql<UnsubscribeResponse>(UNSUBSCRIBE_MUTATION, {
      id: await resolveIssueUUID(ref),
    });
    simpleReceipt("unsubscribed", readBackLabel(ref, data.issueUnsubscribe.issue));
  },
});

// --- reactions --------------------------------------------------------------

interface CommentsResponse {
  issue: { identifier: string; comments: { nodes: { id: string }[] } };
}

interface ReactResponse {
  reactionCreate: { reaction: { emoji: string; issue: IssueRef | null } };
}

const COMMENTS_QUERY = `query LinIssueCommentIds($id: String!) {
  issue(id: $id) {
    identifier
    comments(first: 250) { nodes { id } }
  }
}`;

const REACT_MUTATION = `mutation LinReact($input: ReactionCreateInput!) {
  reactionCreate(input: $input) { reaction { emoji issue { identifier } } }
}`;

/** Comment refs are the first 8 hex characters of the comment UUID. */
function shortRef(id: string): string {
  return id.slice(0, 8);
}

export const react = defineCommand({
  name: "react",
  group: "issue",
  summary: "add an emoji reaction to an issue or a comment",
  args: [
    { name: "target", doc: "an issue, or a comment ref together with --issue" },
    { name: "emoji", doc: "emoji name, for example +1 or eyes", required: true },
  ],
  flags: {
    comment: { type: "string", valueHint: "ref", doc: "react to this comment instead" },
    issue: { type: "string", valueHint: "id", doc: "the issue the comment belongs to" },
  },
  examples: ["lin react ENG-42 +1", "lin react 9f2ab41c eyes --issue ENG-42"],
  async run({ args, flags }) {
    const example = "lin react ENG-42 +1";
    const emoji = requiredArg(args, args.length - 1, "an emoji name", example);
    const target = args.length >= 2 ? args[0] : undefined;
    const issueFlag = flagString(flags, "issue");

    // With --issue present, a leading argument that is not an issue is a comment ref.
    const commentRef =
      flagString(flags, "comment") ??
      (issueFlag !== undefined && target !== undefined && issueIdentifierFrom(target) === undefined
        ? target
        : undefined);
    const issueArg = issueFlag ?? target;

    if (issueArg === undefined) {
      throw new LinError(
        EXIT.input,
        "an issue is required",
        `example: ${example}, or lin react <comment-ref> +1 --issue ENG-42`,
      );
    }

    const issueId = await resolveIssueUUID(issueArg);

    if (commentRef === undefined) {
      const data = await gql<ReactResponse>(REACT_MUTATION, { input: { issueId, emoji } });
      const reaction = data.reactionCreate.reaction;
      simpleReceipt("reacted", `${reaction.emoji} on ${readBackLabel(issueArg, reaction.issue)}`);
      return;
    }

    const thread = await gql<CommentsResponse>(COMMENTS_QUERY, { id: issueId });
    const wanted = commentRef.toLowerCase();
    const matches = thread.issue.comments.nodes.filter((node) =>
      node.id.toLowerCase().startsWith(wanted),
    );

    const [first] = matches;
    if (first === undefined) {
      throw new LinError(
        EXIT.notFound,
        `no comment "${commentRef}" on ${thread.issue.identifier}`,
        `comments: ${thread.issue.comments.nodes.map((node) => shortRef(node.id)).join(", ")}`,
      );
    }
    if (matches.length > 1) {
      throw new LinError(
        EXIT.input,
        `comment "${commentRef}" is ambiguous on ${thread.issue.identifier}`,
        `matches: ${matches.map((node) => shortRef(node.id)).join(", ")}`,
      );
    }

    const data = await gql<ReactResponse>(REACT_MUTATION, {
      input: { commentId: first.id, emoji },
    });
    simpleReceipt(
      "reacted",
      `${data.reactionCreate.reaction.emoji} on ${thread.issue.identifier} comment ${shortRef(first.id)}`,
    );
  },
});
