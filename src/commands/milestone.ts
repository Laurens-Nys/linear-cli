// owned by: project agent
// milestone list / create / update / delete.
//
// Milestones have no slug, so a milestone is addressed by its name inside a
// project or by the 8-char id the `id` column prints; a full UUID also works.

import { gql } from "../client.ts";
import { changed, created, EXIT, LinError, simpleReceipt, table, type Row } from "../out.ts";
import { defineCommand, flagString, type Flags } from "../registry.ts";
import { resolveProject } from "../resolve.ts";
import {
  dateFlag,
  diff,
  isUuid,
  limitOf,
  MILESTONE_COLUMNS,
  milestoneRows,
  requireArg,
  shortRef,
  type MilestoneNode,
} from "./project.ts";

const PROJECT_FLAG = {
  project: { type: "string", valueHint: "ref", doc: "project name, slug id, or UUID" },
} as const;

function projectRef(flags: Flags): string {
  const ref = flagString(flags, "project");
  if (ref === undefined) {
    throw new LinError(EXIT.input, "no project given", "pass --project <name>");
  }
  return ref;
}

// --- milestone list ---------------------------------------------------------

export const LIST_QUERY = `query LinMilestoneList($id: String!, $first: Int) {
  project(id: $id) {
    projectMilestones(first: $first) { nodes { id name targetDate progress } }
  }
}`;

interface ListResponse {
  project: { projectMilestones: { nodes: MilestoneNode[] } };
}

export const milestoneList = defineCommand({
  name: "milestone list",
  group: "milestone",
  summary: "list a project's milestones",
  fields: MILESTONE_COLUMNS,
  flags: PROJECT_FLAG,
  examples: ["lin milestone list --project Onboarding"],
  async run({ flags, config }) {
    const project = await resolveProject(projectRef(flags));
    const data = await gql<ListResponse>(LIST_QUERY, { id: project.id, first: limitOf(config.limit) });
    table("milestones", milestoneRows(data.project.projectMilestones.nodes), MILESTONE_COLUMNS);
  },
});

// --- resolution -------------------------------------------------------------

export const LOOKUP_QUERY = `query LinMilestoneLookup($id: String!) {
  project(id: $id) { projectMilestones(first: 100) { nodes { id name } } }
}`;

interface LookupResponse {
  project: { projectMilestones: { nodes: { id: string; name: string }[] } };
}

/** A UUID passes through; anything else is a name or an 8-char id inside a project. */
export async function resolveMilestoneId(ref: string, project: string | undefined): Promise<string> {
  if (isUuid(ref)) return ref;

  if (project === undefined) {
    throw new LinError(EXIT.input, `"${ref}" needs a project to resolve against`, "pass --project <name>");
  }

  const target = await resolveProject(project);
  const data = await gql<LookupResponse>(LOOKUP_QUERY, { id: target.id });
  const nodes = data.project.projectMilestones.nodes;

  const wanted = ref.toLowerCase();
  const matches = nodes.filter(
    (node) => node.name.toLowerCase() === wanted || shortRef(node.id).toLowerCase() === wanted,
  );

  const [first] = matches;
  if (matches.length === 1 && first !== undefined) return first.id;
  if (matches.length > 1) {
    throw new LinError(
      EXIT.input,
      `milestone "${ref}" is ambiguous in ${target.name}`,
      `matches: ${matches.map((node) => shortRef(node.id)).join(", ")}`,
    );
  }
  throw new LinError(
    EXIT.input,
    `project ${target.name} has no milestone "${ref}"`,
    `milestones: ${nodes.map((node) => node.name).join(", ")}`,
  );
}

// --- milestone create -------------------------------------------------------

export const CREATE_MUTATION = `mutation LinMilestoneCreate($input: ProjectMilestoneCreateInput!) {
  projectMilestoneCreate(input: $input) { projectMilestone { id } }
}`;

interface CreateResponse {
  projectMilestoneCreate: { projectMilestone: { id: string } };
}

export const milestoneCreate = defineCommand({
  name: "milestone create",
  group: "milestone",
  summary: "add a milestone to a project",
  flags: {
    ...PROJECT_FLAG,
    name: { type: "string", valueHint: "text", doc: "milestone name" },
    target: { type: "string", valueHint: "YYYY-MM-DD", doc: "target date" },
  },
  examples: ['lin milestone create --project Onboarding --name "Beta" --target 2026-09-30'],
  async run({ flags }) {
    const name = flagString(flags, "name");
    if (name === undefined) {
      throw new LinError(EXIT.input, "milestone create needs a name", 'pass --name "Milestone name"');
    }

    const project = await resolveProject(projectRef(flags));
    const target = dateFlag(flags, "target");

    const data = await gql<CreateResponse>(
      CREATE_MUTATION,
      { input: { projectId: project.id, name, ...(target !== undefined && { targetDate: target }) } },
      { retry: false },
    );

    created(shortRef(data.projectMilestoneCreate.projectMilestone.id));
  },
});

// --- milestone update -------------------------------------------------------

export const BEFORE_QUERY = `query LinMilestoneBefore($id: String!) {
  projectMilestone(id: $id) { name targetDate }
}`;

export const UPDATE_MUTATION = `mutation LinMilestoneUpdate($id: String!, $input: ProjectMilestoneUpdateInput!) {
  projectMilestoneUpdate(id: $id, input: $input) { projectMilestone { id name targetDate } }
}`;

interface Fields {
  name: string;
  targetDate: string | null;
}

interface BeforeResponse {
  projectMilestone: Fields;
}

interface UpdateResponse {
  projectMilestoneUpdate: { projectMilestone: Fields & { id: string } };
}

function milestoneFields(fields: Fields): Row {
  return { name: fields.name, target: fields.targetDate };
}

export const milestoneUpdate = defineCommand({
  name: "milestone update",
  group: "milestone",
  summary: "rename a milestone or move its target date",
  args: [{ name: "milestone", doc: "milestone name, 8-char id, or UUID", required: true }],
  flags: {
    ...PROJECT_FLAG,
    name: { type: "string", valueHint: "text", doc: "new milestone name" },
    target: { type: "string", valueHint: "YYYY-MM-DD", doc: "new target date" },
  },
  examples: ['lin milestone update "Beta" --project Onboarding --target 2026-10-15'],
  async run({ args, flags }) {
    const ref = requireArg(
      args,
      0,
      "milestone update needs a milestone",
      'example: lin milestone update "Beta" --project Onboarding --target 2026-10-15',
    );

    const input: Row = {};
    const name = flagString(flags, "name");
    if (name !== undefined) input["name"] = name;
    const target = dateFlag(flags, "target");
    if (target !== undefined) input["targetDate"] = target;

    if (Object.keys(input).length === 0) {
      throw new LinError(EXIT.input, "milestone update needs at least one field", "flags: --name, --target");
    }

    const id = await resolveMilestoneId(ref, flagString(flags, "project"));
    const before = await gql<BeforeResponse>(BEFORE_QUERY, { id });
    const data = await gql<UpdateResponse>(UPDATE_MUTATION, { id, input }, { retry: false });

    const after = data.projectMilestoneUpdate.projectMilestone;
    changed(shortRef(after.id), diff(milestoneFields(before.projectMilestone), milestoneFields(after)));
  },
});

// --- milestone delete -------------------------------------------------------

export const DELETE_MUTATION = `mutation LinMilestoneDelete($id: String!) {
  projectMilestoneDelete(id: $id) { entityId }
}`;

interface DeleteResponse {
  projectMilestoneDelete: { entityId: string };
}

export const milestoneDelete = defineCommand({
  name: "milestone delete",
  group: "milestone",
  summary: "delete a milestone",
  args: [{ name: "milestone", doc: "milestone name, 8-char id, or UUID", required: true }],
  flags: PROJECT_FLAG,
  examples: ['lin milestone delete "Beta" --project Onboarding'],
  async run({ args, flags }) {
    const ref = requireArg(
      args,
      0,
      "milestone delete needs a milestone",
      'example: lin milestone delete "Beta" --project Onboarding',
    );

    const id = await resolveMilestoneId(ref, flagString(flags, "project"));
    const data = await gql<DeleteResponse>(DELETE_MUTATION, { id }, { retry: false });
    simpleReceipt("deleted", shortRef(data.projectMilestoneDelete.entityId));
  },
});
