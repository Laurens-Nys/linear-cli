// owned by: project agent
// initiative list / view / create / update / add-project / rm-project / post / posts.
//
// `initiative update` edits the initiative. `initiative post` creates an
// InitiativeUpdate, which is the status post — the same naming collision the
// project commands avoid.

import { gql } from "../client.ts";
import { changed, created, EXIT, LinError, record, simpleReceipt, table, type Row } from "../out.ts";
import { defineCommand, flagString, type Flags } from "../registry.ts";
import { resolveProject } from "../resolve.ts";
import {
  contentChange,
  dateFlag,
  diff,
  healthEnum,
  healthWord,
  limitOf,
  percent,
  POST_COLUMNS,
  postRows,
  readBody,
  requireArg,
  resolveInitiativeId,
  type PostNode,
} from "./project.ts";

const LIST_COLUMNS = ["id", "name", "state", "owner", "target"];
const ROLLUP_COLUMNS = ["id", "name", "state", "health", "progress"];

// Initiative status is a closed enum, so it is validated without a request.
const STATUSES = ["Proposed", "Planned", "Active", "Completed", "Canceled"];

function statusEnum(value: string): string {
  const match = STATUSES.find((status) => status.toLowerCase() === value.toLowerCase());
  if (match === undefined) {
    throw new LinError(EXIT.input, `no initiative state "${value}"`, `states: ${STATUSES.join(", ")}`);
  }
  return match;
}

// --- initiative list --------------------------------------------------------

export const LIST_QUERY = `query LinInitiativeList($first: Int, $after: String) {
  initiatives(first: $first, after: $after, orderBy: updatedAt) {
    nodes { slugId name status targetDate owner { displayName } }
  }
}`;

interface ListResponse {
  initiatives: {
    nodes: {
      slugId: string;
      name: string;
      status: string;
      targetDate: string | null;
      owner: { displayName: string } | null;
    }[];
  };
}

export const initiativeList = defineCommand({
  name: "initiative list",
  group: "initiative",
  summary: "list initiatives",
  fields: LIST_COLUMNS,
  examples: ["lin initiative list"],
  async run({ flags, config }) {
    const data = await gql<ListResponse>(LIST_QUERY, {
      first: limitOf(config.limit),
      after: flagString(flags, "after"),
    });

    table(
      "initiatives",
      data.initiatives.nodes.map((node) => ({
        id: node.slugId,
        name: node.name,
        state: node.status,
        owner: node.owner?.displayName,
        target: node.targetDate,
      })),
      LIST_COLUMNS,
    );
  },
});

// --- initiative view --------------------------------------------------------

export const VIEW_QUERY = `query LinInitiativeView($id: String!) {
  initiative(id: $id) {
    slugId name status content health targetDate updatedAt url
    owner { displayName }
    projects(first: 50) {
      nodes { slugId name progress health status { name } }
    }
  }
}`;

interface ViewResponse {
  initiative: {
    slugId: string;
    name: string;
    status: string;
    content: string | null;
    health: string | null;
    targetDate: string | null;
    updatedAt: string;
    url: string;
    owner: { displayName: string } | null;
    projects: {
      nodes: {
        slugId: string;
        name: string;
        progress: number;
        health: string | null;
        status: { name: string } | null;
      }[];
    };
  };
}

export const initiativeView = defineCommand({
  name: "initiative view",
  group: "initiative",
  summary: "show an initiative with its project rollup",
  args: [{ name: "initiative", doc: "initiative name, slug id, or UUID", required: true }],
  examples: ["lin initiative view Platform"],
  async run({ args }) {
    const ref = requireArg(args, 0, "initiative view needs an initiative", "example: lin initiative view Platform");

    const id = await resolveInitiativeId(ref);
    const { initiative } = await gql<ViewResponse>(VIEW_QUERY, { id });

    record(
      {
        id: initiative.slugId,
        name: initiative.name,
        state: initiative.status,
        health: healthWord(initiative.health),
        owner: initiative.owner?.displayName,
        target: initiative.targetDate,
        updated: initiative.updatedAt,
        url: initiative.url,
      },
      {
        body: initiative.content ?? undefined,
        children: [
          {
            key: "projects",
            rows: initiative.projects.nodes.map((node) => ({
              id: node.slugId,
              name: node.name,
              state: node.status?.name,
              health: healthWord(node.health),
              progress: percent(node.progress * 100),
            })),
            columns: ROLLUP_COLUMNS,
          },
        ],
      },
    );
  },
});

// --- initiative create / update ---------------------------------------------

const WRITE_FLAGS = {
  name: { type: "string", valueHint: "text", doc: "initiative name" },
  body: { type: "string", short: "d", valueHint: "text|@file|-", doc: "initiative content as markdown" },
  target: { type: "string", valueHint: "YYYY-MM-DD", doc: "target date" },
  state: { type: "string", valueHint: "name", doc: `initiative status: ${STATUSES.join(", ")}` },
} as const;

function writeInput(flags: Flags): Row {
  const input: Row = {};

  const name = flagString(flags, "name");
  if (name !== undefined) input["name"] = name;

  const content = readBody(flagString(flags, "body"));
  if (content !== undefined) input["content"] = content;

  const target = dateFlag(flags, "target");
  if (target !== undefined) input["targetDate"] = target;

  const state = flagString(flags, "state");
  if (state !== undefined) input["status"] = statusEnum(state);

  return input;
}

export const CREATE_MUTATION = `mutation LinInitiativeCreate($input: InitiativeCreateInput!) {
  initiativeCreate(input: $input) { initiative { slugId url } }
}`;

interface CreateResponse {
  initiativeCreate: { initiative: { slugId: string; url: string } };
}

export const initiativeCreate = defineCommand({
  name: "initiative create",
  group: "initiative",
  summary: "create an initiative",
  flags: WRITE_FLAGS,
  examples: ['lin initiative create --name "Platform" --state Planned --target 2026-12-31'],
  async run({ flags }) {
    const name = flagString(flags, "name");
    if (name === undefined) {
      throw new LinError(EXIT.input, "initiative create needs a name", 'pass --name "Initiative name"');
    }

    const data = await gql<CreateResponse>(
      CREATE_MUTATION,
      { input: { ...writeInput(flags), name } },
      { retry: false },
    );

    created(data.initiativeCreate.initiative.slugId, data.initiativeCreate.initiative.url);
  },
});

export const BEFORE_QUERY = `query LinInitiativeBefore($id: String!, $withContent: Boolean!) {
  initiative(id: $id) {
    name status targetDate
    content @include(if: $withContent)
  }
}`;

export const UPDATE_MUTATION = `mutation LinInitiativeUpdate($id: String!, $input: InitiativeUpdateInput!, $withContent: Boolean!) {
  initiativeUpdate(id: $id, input: $input) {
    initiative {
      slugId name status targetDate
      content @include(if: $withContent)
    }
  }
}`;

interface Fields {
  name: string;
  status: string;
  targetDate: string | null;
  content?: string | null;
}

interface BeforeResponse {
  initiative: Fields;
}

interface UpdateResponse {
  initiativeUpdate: { initiative: Fields & { slugId: string } };
}

function initiativeFields(fields: Fields): Row {
  return { name: fields.name, state: fields.status, target: fields.targetDate };
}

export const initiativeUpdate = defineCommand({
  name: "initiative update",
  group: "initiative",
  summary: "edit an initiative's fields",
  args: [{ name: "initiative", doc: "initiative name, slug id, or UUID", required: true }],
  flags: WRITE_FLAGS,
  examples: ["lin initiative update Platform --state Active"],
  async run({ args, flags }) {
    const ref = requireArg(
      args,
      0,
      "initiative update needs an initiative",
      "example: lin initiative update Platform --state Active",
    );

    const input = writeInput(flags);
    if (Object.keys(input).length === 0) {
      throw new LinError(
        EXIT.input,
        "initiative update needs at least one field",
        "flags: --name, --body, --target, --state",
      );
    }

    const id = await resolveInitiativeId(ref);
    const withContent = input["content"] !== undefined;
    const before = await gql<BeforeResponse>(BEFORE_QUERY, { id, withContent });
    const data = await gql<UpdateResponse>(UPDATE_MUTATION, { id, input, withContent }, { retry: false });

    const after = data.initiativeUpdate.initiative;
    const changes = diff(initiativeFields(before.initiative), initiativeFields(after));
    if (withContent) {
      const change = contentChange(before.initiative.content ?? null, after.content ?? null);
      if (change) changes.push(change);
    }
    changed(after.slugId, changes);
  },
});

// --- membership -------------------------------------------------------------

export const ADD_PROJECT_MUTATION = `mutation LinInitiativeAddProject($input: InitiativeToProjectCreateInput!) {
  initiativeToProjectCreate(input: $input) { initiativeToProject { project { slugId } } }
}`;

interface AddProjectResponse {
  initiativeToProjectCreate: { initiativeToProject: { project: { slugId: string } } };
}

export const initiativeAddProject = defineCommand({
  name: "initiative add-project",
  group: "initiative",
  summary: "add a project to an initiative",
  args: [
    { name: "initiative", doc: "initiative name, slug id, or UUID", required: true },
    { name: "project", doc: "project name, slug id, or UUID", required: true },
  ],
  examples: ["lin initiative add-project Platform Onboarding"],
  async run({ args }) {
    const initiativeRef = requireArg(
      args,
      0,
      "initiative add-project needs an initiative and a project",
      "example: lin initiative add-project Platform Onboarding",
    );
    const projectArg = requireArg(
      args,
      1,
      "initiative add-project needs a project",
      "example: lin initiative add-project Platform Onboarding",
    );

    const initiativeId = await resolveInitiativeId(initiativeRef);
    const project = await resolveProject(projectArg);

    const data = await gql<AddProjectResponse>(
      ADD_PROJECT_MUTATION,
      { input: { initiativeId, projectId: project.id } },
      { retry: false },
    );

    simpleReceipt("added", data.initiativeToProjectCreate.initiativeToProject.project.slugId);
  },
});

// The link between an initiative and a project is its own record; deleting the
// membership means finding that record's id first.
export const LINKS_QUERY = `query LinInitiativeLinks($id: String!) {
  project(id: $id) {
    initiativeToProjects(first: 50) { nodes { id initiative { id } } }
  }
}`;

interface LinksResponse {
  project: { initiativeToProjects: { nodes: { id: string; initiative: { id: string } }[] } };
}

export const RM_PROJECT_MUTATION = `mutation LinInitiativeRmProject($id: String!) {
  initiativeToProjectDelete(id: $id) { success }
}`;

export const initiativeRmProject = defineCommand({
  name: "initiative rm-project",
  group: "initiative",
  summary: "remove a project from an initiative",
  args: [
    { name: "initiative", doc: "initiative name, slug id, or UUID", required: true },
    { name: "project", doc: "project name, slug id, or UUID", required: true },
  ],
  examples: ["lin initiative rm-project Platform Onboarding"],
  async run({ args }) {
    const initiativeRef = requireArg(
      args,
      0,
      "initiative rm-project needs an initiative and a project",
      "example: lin initiative rm-project Platform Onboarding",
    );
    const projectArg = requireArg(
      args,
      1,
      "initiative rm-project needs a project",
      "example: lin initiative rm-project Platform Onboarding",
    );

    const initiativeId = await resolveInitiativeId(initiativeRef);
    const project = await resolveProject(projectArg);

    const data = await gql<LinksResponse>(LINKS_QUERY, { id: project.id });
    const link = data.project.initiativeToProjects.nodes.find((node) => node.initiative.id === initiativeId);
    if (!link) {
      throw new LinError(
        EXIT.notFound,
        `project ${project.name} is not in that initiative`,
        "run lin initiative view <initiative> to see its projects",
      );
    }

    await gql(RM_PROJECT_MUTATION, { id: link.id }, { retry: false });
    simpleReceipt("removed", project.slugId);
  },
});

// --- initiative post / posts ------------------------------------------------

export const POST_MUTATION = `mutation LinInitiativePost($input: InitiativeUpdateCreateInput!) {
  initiativeUpdateCreate(input: $input) { initiativeUpdate { slugId url } }
}`;

interface PostResponse {
  initiativeUpdateCreate: { initiativeUpdate: { slugId: string; url: string } };
}

export const initiativePost = defineCommand({
  name: "initiative post",
  group: "initiative",
  summary: "post an initiative status update",
  args: [{ name: "initiative", doc: "initiative name, slug id, or UUID", required: true }],
  flags: {
    health: { type: "string", valueHint: "on-track|at-risk|off-track", doc: "initiative health" },
    message: { type: "string", short: "m", valueHint: "text|@file|-", doc: "the post body" },
  },
  examples: ['lin initiative post Platform --health at-risk -m "Slipping a week"'],
  async run({ args, flags }) {
    const ref = requireArg(
      args,
      0,
      "initiative post needs an initiative",
      'example: lin initiative post Platform -m "shipped"',
    );

    const body = readBody(flagString(flags, "message"));
    if (body === undefined) {
      throw new LinError(EXIT.input, "initiative post needs a message", 'pass -m "text", -m @file, or -m -');
    }

    const health = flagString(flags, "health");
    const initiativeId = await resolveInitiativeId(ref);

    const data = await gql<PostResponse>(
      POST_MUTATION,
      { input: { initiativeId, body, ...(health !== undefined && { health: healthEnum(health) }) } },
      { retry: false },
    );

    const post = data.initiativeUpdateCreate.initiativeUpdate;
    created(post.slugId, post.url);
  },
});

export const POSTS_QUERY = `query LinInitiativePosts($id: String!, $first: Int) {
  initiative(id: $id) {
    initiativeUpdates(first: $first) { nodes { createdAt health body user { displayName } } }
  }
}`;

interface PostsResponse {
  initiative: { initiativeUpdates: { nodes: PostNode[] } };
}

export const initiativePosts = defineCommand({
  name: "initiative posts",
  group: "initiative",
  summary: "list an initiative's status updates, newest first",
  fields: POST_COLUMNS,
  args: [{ name: "initiative", doc: "initiative name, slug id, or UUID", required: true }],
  examples: ["lin initiative posts Platform"],
  async run({ args, config }) {
    const ref = requireArg(args, 0, "initiative posts needs an initiative", "example: lin initiative posts Platform");

    const id = await resolveInitiativeId(ref);
    const data = await gql<PostsResponse>(POSTS_QUERY, { id, first: limitOf(config.limit) });
    table("posts", postRows(data.initiative.initiativeUpdates.nodes), POST_COLUMNS);
  },
});
