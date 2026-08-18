// owned by: workspace agent
// inbox / inbox read / inbox archive.
//
// Notifications are polymorphic, so the list query selects the interface fields
// and adds one inline fragment per kind whose target is worth naming.
// `NotificationFilter` has no `readAt`, so unread is filtered here rather than
// server-side; the page is widened to compensate.

import { gql } from "../client.ts";
import { DEFAULT_LIMIT } from "../config.ts";
import { EXIT, LinError, simpleReceipt, table } from "../out.ts";
import { defineCommand, flagBool } from "../registry.ts";

/** Linear's pagination ceiling, and the widest sweep any inbox command makes. */
const MAX_PAGE = 250;

/** Notifications are referred to by the first 8 hex characters of their UUID. */
export function inboxRef(id: string): string {
  return id.slice(0, 8);
}

export function ageDays(createdAt: string, now: number = Date.now()): string {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return "";
  return `${Math.max(0, Math.floor((now - created) / 86_400_000))}d`;
}

// Linear's `type` repeats the entity that the target column already carries,
// and spells out a few events at length. Drop the entity, shorten the rest.
const EVENT_WORDS: Record<string, string> = {
  assignedToYou: "assignment",
  unassignedFromYou: "unassignment",
  statusChanged: "status",
  newComment: "comment",
  commentMention: "mention",
  commentReaction: "reaction",
  emojiReaction: "reaction",
  updateCreated: "update",
};

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export function eventWord(typename: string, type: string): string {
  const entity = lowerFirst(typename.replace(/Notification$/, ""));
  const event = type.startsWith(entity) ? lowerFirst(type.slice(entity.length)) : type;
  if (event === "") return type;
  return EVENT_WORDS[event] ?? event;
}

// --- inbox ------------------------------------------------------------------

const LIST_QUERY = `query LinInbox($first: Int) {
  notifications(first: $first, orderBy: createdAt) {
    nodes {
      __typename id type createdAt readAt
      actor { displayName }
      ... on IssueNotification { issue { identifier } }
      ... on ProjectNotification { project { name } }
      ... on InitiativeNotification { initiative { name } }
    }
  }
}`;

interface NotificationNode {
  __typename: string;
  id: string;
  type: string;
  createdAt: string;
  readAt: string | null;
  actor: { displayName: string } | null;
  issue?: { identifier: string } | null;
  project?: { name: string } | null;
  initiative?: { name: string } | null;
}

interface ListResponse {
  notifications: { nodes: NotificationNode[] };
}

function target(node: NotificationNode): string | undefined {
  return node.issue?.identifier ?? node.project?.name ?? node.initiative?.name;
}

export const inbox = defineCommand({
  name: "inbox",
  group: "inbox",
  summary: "show unread notifications, newest first",
  fields: ["ref", "type", "actor", "target", "age"],
  flags: {
    all: { type: "boolean", doc: "include read notifications" },
  },
  examples: ["lin inbox", "lin inbox --all"],
  async run({ flags, config }) {
    const includeRead = flagBool(flags, "all");
    const limit = config.limit ?? DEFAULT_LIMIT;
    // Unread is a client-side filter, so ask for more than we intend to print.
    const first = includeRead ? limit : Math.min(limit * 2, MAX_PAGE);

    const data = await gql<ListResponse>(LIST_QUERY, { first });
    const nodes = data.notifications.nodes
      .filter((node) => includeRead || node.readAt === null)
      .slice(0, limit);

    const rows = nodes.map((node) => ({
      ref: inboxRef(node.id),
      type: eventWord(node.__typename, node.type),
      actor: node.actor?.displayName,
      target: target(node),
      age: ageDays(node.createdAt),
    }));

    table("notifications", rows, ["ref", "type", "actor", "target", "age"]);
  },
});

// --- ref resolution ----------------------------------------------------------

const REFS_QUERY = `query LinInboxRefs($first: Int) {
  notifications(first: $first, orderBy: createdAt) {
    nodes { id readAt }
  }
}`;

interface RefsResponse {
  notifications: { nodes: { id: string; readAt: string | null }[] };
}

/**
 * Mutations take UUIDs, and the printed ref is only the first 8 characters, so
 * every write starts by listing the inbox and prefix-matching. An unknown ref
 * is exit 4; an ambiguous one is exit 2 with the candidates.
 */
async function resolveRefs(
  refs: readonly string[],
  everything: boolean,
  unreadOnly: boolean,
): Promise<string[]> {
  const data = await gql<RefsResponse>(REFS_QUERY, { first: MAX_PAGE });
  const nodes = data.notifications.nodes;

  if (everything) {
    return nodes.filter((node) => !unreadOnly || node.readAt === null).map((node) => node.id);
  }

  const ids: string[] = [];
  for (const ref of refs) {
    const wanted = ref.toLowerCase();
    const matches = nodes.filter((node) => node.id.toLowerCase().startsWith(wanted));
    const [first] = matches;

    if (first === undefined) {
      throw new LinError(EXIT.notFound, `no notification "${ref}"`, "run lin inbox --all to list refs");
    }
    if (matches.length > 1) {
      throw new LinError(
        EXIT.input,
        `notification "${ref}" is ambiguous`,
        `matches: ${matches.map((match) => inboxRef(match.id)).join(", ")}`,
      );
    }
    if (!ids.includes(first.id)) ids.push(first.id);
  }
  return ids;
}

function requireSelection(refs: readonly string[], everything: boolean, verb: string): void {
  if (everything || refs.length > 0) return;
  throw new LinError(
    EXIT.input,
    `inbox ${verb} needs a notification`,
    `pass one or more refs from lin inbox, or --all to ${verb} every notification`,
  );
}

// --- inbox read ---------------------------------------------------------------

// There is no "mark everything read" mutation: `notificationMarkReadAll` is
// scoped to one entity's notifications, so `--all` walks the unread list.
const READ_MUTATION = `mutation LinInboxRead($id: String!, $input: NotificationUpdateInput!) {
  notificationUpdate(id: $id, input: $input) { success }
}`;

export const inboxRead = defineCommand({
  name: "inbox read",
  group: "inbox",
  summary: "mark notifications as read",
  args: [{ name: "ref", doc: "notification ref from lin inbox", variadic: true }],
  flags: {
    all: { type: "boolean", doc: "mark every unread notification read" },
  },
  examples: ["lin inbox read 9f2ab41c", "lin inbox read --all"],
  async run({ args, flags }) {
    const everything = flagBool(flags, "all");
    requireSelection(args, everything, "read");

    const ids = await resolveRefs(args, everything, true);
    const readAt = new Date().toISOString();

    for (const id of ids) {
      await gql(READ_MUTATION, { id, input: { readAt } });
      simpleReceipt("read", inboxRef(id));
    }
  },
});

// --- inbox archive ------------------------------------------------------------

const ARCHIVE_MUTATION = `mutation LinInboxArchive($id: String!) {
  notificationArchive(id: $id) { success }
}`;

export const inboxArchive = defineCommand({
  name: "inbox archive",
  group: "inbox",
  summary: "archive notifications out of the inbox",
  args: [{ name: "ref", doc: "notification ref from lin inbox", variadic: true }],
  flags: {
    all: { type: "boolean", doc: "archive every notification" },
  },
  examples: ["lin inbox archive 9f2ab41c", "lin inbox archive --all"],
  async run({ args, flags }) {
    const everything = flagBool(flags, "all");
    requireSelection(args, everything, "archive");

    const ids = await resolveRefs(args, everything, false);

    for (const id of ids) {
      await gql(ARCHIVE_MUTATION, { id });
      simpleReceipt("archived", inboxRef(id));
    }
  },
});
