// owned by: project agent
// doc list / view / create / update.
//
// A document is addressed by the slug id `doc list` prints, by its UUID, or by
// an exact title. `document(id:)` accepts the first two directly.

import { gql } from "../client.ts";
import { changed, created, EXIT, LinError, record, table, type Row } from "../out.ts";
import { defineCommand, flagString, type Flags } from "../registry.ts";
import { resolveProject } from "../resolve.ts";
import {
  contentChange,
  diff,
  isUuid,
  limitOf,
  readBody,
  requireArg,
  resolveInitiativeId,
} from "./project.ts";

const LIST_COLUMNS = ["id", "title", "project", "updated"];

const SCOPE_FLAGS = {
  project: { type: "string", valueHint: "ref", doc: "project name, slug id, or UUID" },
  initiative: { type: "string", valueHint: "ref", doc: "initiative name, slug id, or UUID" },
} as const;

/** `--project` / `--initiative` as document filter or write-input scope. */
async function scope(flags: Flags): Promise<{ projectId?: string; initiativeId?: string }> {
  const result: { projectId?: string; initiativeId?: string } = {};

  const project = flagString(flags, "project");
  if (project !== undefined) result.projectId = (await resolveProject(project)).id;

  const initiative = flagString(flags, "initiative");
  if (initiative !== undefined) result.initiativeId = await resolveInitiativeId(initiative);

  return result;
}

// --- doc list ---------------------------------------------------------------

export const LIST_QUERY = `query LinDocList($filter: DocumentFilter, $first: Int, $after: String) {
  documents(filter: $filter, first: $first, after: $after, orderBy: updatedAt) {
    nodes { slugId title updatedAt project { name } }
  }
}`;

interface ListResponse {
  documents: {
    nodes: { slugId: string; title: string; updatedAt: string; project: { name: string } | null }[];
  };
}

export const docList = defineCommand({
  name: "doc list",
  group: "doc",
  summary: "list documents",
  fields: LIST_COLUMNS,
  flags: SCOPE_FLAGS,
  examples: ["lin doc list", "lin doc list --project Onboarding"],
  async run({ flags, config }) {
    const { projectId, initiativeId } = await scope(flags);

    const filter: Row = {};
    if (projectId !== undefined) filter["project"] = { id: { eq: projectId } };
    if (initiativeId !== undefined) filter["initiative"] = { id: { eq: initiativeId } };

    const data = await gql<ListResponse>(LIST_QUERY, {
      filter,
      first: limitOf(config.limit),
      after: flagString(flags, "after"),
    });

    table(
      "docs",
      data.documents.nodes.map((node) => ({
        id: node.slugId,
        title: node.title,
        project: node.project?.name,
        updated: node.updatedAt,
      })),
      LIST_COLUMNS,
    );
  },
});

// --- resolution -------------------------------------------------------------

export const TITLE_QUERY = `query LinDocByTitle($title: String!) {
  documents(filter: { title: { eqIgnoreCase: $title } }, first: 5) { nodes { slugId } }
}`;

interface TitleResponse {
  documents: { nodes: { slugId: string }[] };
}

// The slug is a bare hex handle, e.g. 189b7e925950.
const SLUG = /^[0-9a-f]{8,}$/i;

/** An id or slug goes straight through; anything else is matched on title. */
export async function resolveDocRef(ref: string): Promise<string> {
  if (isUuid(ref) || SLUG.test(ref)) return ref;

  const data = await gql<TitleResponse>(TITLE_QUERY, { title: ref });
  const nodes = data.documents.nodes;

  const [first] = nodes;
  if (nodes.length === 1 && first !== undefined) return first.slugId;
  if (nodes.length > 1) {
    throw new LinError(
      EXIT.input,
      `document "${ref}" is ambiguous`,
      `matches: ${nodes.map((node) => node.slugId).join(", ")}`,
    );
  }
  throw new LinError(EXIT.input, `no document "${ref}"`, "run lin doc list to see the documents you can reach");
}

// --- doc view ---------------------------------------------------------------

export const VIEW_QUERY = `query LinDocView($id: String!) {
  document(id: $id) {
    slugId title content updatedAt url
    project { name }
    initiative { name }
  }
}`;

interface ViewResponse {
  document: {
    slugId: string;
    title: string;
    content: string | null;
    updatedAt: string;
    url: string;
    project: { name: string } | null;
    initiative: { name: string } | null;
  };
}

export const docView = defineCommand({
  name: "doc view",
  group: "doc",
  summary: "show a document with its full markdown content",
  args: [{ name: "doc", doc: "document slug id, UUID, or exact title", required: true }],
  examples: ["lin doc view 189b7e925950", 'lin doc view "Launch plan"'],
  async run({ args }) {
    const ref = requireArg(args, 0, "doc view needs a document", 'example: lin doc view "Launch plan"');

    const { document } = await gql<ViewResponse>(VIEW_QUERY, { id: await resolveDocRef(ref) });

    record(
      {
        id: document.slugId,
        title: document.title,
        project: document.project?.name,
        initiative: document.initiative?.name,
        updated: document.updatedAt,
        url: document.url,
      },
      { body: document.content ?? undefined },
    );
  },
});

// --- doc create / update ----------------------------------------------------

const WRITE_FLAGS = {
  ...SCOPE_FLAGS,
  title: { type: "string", short: "t", valueHint: "text", doc: "document title" },
  body: { type: "string", short: "d", valueHint: "text|@file|-", doc: "document content as markdown" },
} as const;

export const CREATE_MUTATION = `mutation LinDocCreate($input: DocumentCreateInput!) {
  documentCreate(input: $input) { document { slugId url } }
}`;

interface CreateResponse {
  documentCreate: { document: { slugId: string; url: string } };
}

export const docCreate = defineCommand({
  name: "doc create",
  group: "doc",
  summary: "create a document",
  flags: WRITE_FLAGS,
  examples: ['lin doc create -t "Launch plan" --project Onboarding -d @plan.md'],
  async run({ flags }) {
    const title = flagString(flags, "title");
    if (title === undefined) {
      throw new LinError(EXIT.input, "doc create needs a title", 'pass -t "Document title"');
    }

    const content = readBody(flagString(flags, "body"));
    const { projectId, initiativeId } = await scope(flags);

    const data = await gql<CreateResponse>(
      CREATE_MUTATION,
      {
        input: {
          title,
          ...(content !== undefined && { content }),
          ...(projectId !== undefined && { projectId }),
          ...(initiativeId !== undefined && { initiativeId }),
        },
      },
      { retry: false },
    );

    created(data.documentCreate.document.slugId, data.documentCreate.document.url);
  },
});

export const BEFORE_QUERY = `query LinDocBefore($id: String!, $withContent: Boolean!) {
  document(id: $id) {
    title
    project { name }
    initiative { name }
    content @include(if: $withContent)
  }
}`;

export const UPDATE_MUTATION = `mutation LinDocUpdate($id: String!, $input: DocumentUpdateInput!, $withContent: Boolean!) {
  documentUpdate(id: $id, input: $input) {
    document {
      slugId title
      project { name }
      initiative { name }
      content @include(if: $withContent)
    }
  }
}`;

interface Fields {
  title: string;
  project: { name: string } | null;
  initiative: { name: string } | null;
  content?: string | null;
}

interface BeforeResponse {
  document: Fields;
}

interface UpdateResponse {
  documentUpdate: { document: Fields & { slugId: string } };
}

function docFields(fields: Fields): Row {
  return {
    title: fields.title,
    project: fields.project?.name,
    initiative: fields.initiative?.name,
  };
}

export const docUpdate = defineCommand({
  name: "doc update",
  group: "doc",
  summary: "edit a document's title, content, or owner",
  args: [{ name: "doc", doc: "document slug id, UUID, or exact title", required: true }],
  flags: WRITE_FLAGS,
  examples: ['lin doc update 189b7e925950 -d @plan.md', 'lin doc update "Launch plan" -t "Launch plan v2"'],
  async run({ args, flags }) {
    const ref = requireArg(args, 0, "doc update needs a document", 'example: lin doc update "Launch plan" -d @plan.md');

    const input: Row = {};
    const title = flagString(flags, "title");
    if (title !== undefined) input["title"] = title;
    const content = readBody(flagString(flags, "body"));
    if (content !== undefined) input["content"] = content;

    const { projectId, initiativeId } = await scope(flags);
    if (projectId !== undefined) input["projectId"] = projectId;
    if (initiativeId !== undefined) input["initiativeId"] = initiativeId;

    if (Object.keys(input).length === 0) {
      throw new LinError(
        EXIT.input,
        "doc update needs at least one field",
        "flags: --title, --body, --project, --initiative",
      );
    }

    const id = await resolveDocRef(ref);
    const withContent = content !== undefined;
    const before = await gql<BeforeResponse>(BEFORE_QUERY, { id, withContent });
    const data = await gql<UpdateResponse>(UPDATE_MUTATION, { id, input, withContent }, { retry: false });

    const after = data.documentUpdate.document;
    const changes = diff(docFields(before.document), docFields(after));
    if (withContent) {
      const change = contentChange(before.document.content ?? null, after.content ?? null);
      if (change) changes.push(change);
    }
    changed(after.slugId, changes);
  },
});
