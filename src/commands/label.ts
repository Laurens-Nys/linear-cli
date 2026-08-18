// owned by: workspace agent
// label list / create / update / archive.
//
// Archive maps onto `issueLabelRetire`, not `issueLabelDelete`: retiring keeps
// the label visible on the issues that already carry it and only stops new
// applications, which is what "archive" means everywhere else in this CLI.

import { gql } from "../client.ts";
import { DEFAULT_LIMIT } from "../config.ts";
import { changed, created, EXIT, LinError, simpleReceipt, table, type Change } from "../out.ts";
import { defineCommand, flagBool, flagString, type Flags } from "../registry.ts";
import { resolveLabel, resolveTeam } from "../resolve.ts";

const noCache = (flags: Flags) => ({ noCache: flagBool(flags, "no-cache") });

/** A label's full name inside its group, which is also what resolution accepts. */
function qualify(name: string, group: string | null | undefined): string {
  return group ? `${group}/${name}` : name;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function readColor(flags: Flags): string | undefined {
  const color = flagString(flags, "color");
  if (color === undefined) return undefined;
  if (!HEX_COLOR.test(color)) {
    throw new LinError(EXIT.input, `"${color}" is not a hex color`, "example: --color #eb5757");
  }
  return color;
}

/** Just enough to build the qualified name a receipt prints. */
interface LabelName {
  name: string;
  parent: { name: string } | null;
}

interface LabelNode extends LabelName {
  color: string;
}

// --- label list -------------------------------------------------------------

const LIST_QUERY = `query LinLabelList($filter: IssueLabelFilter, $first: Int) {
  issueLabels(filter: $filter, first: $first) {
    nodes { name color parent { name } }
  }
}`;

interface ListResponse {
  issueLabels: { nodes: LabelNode[] };
}

export const labelList = defineCommand({
  name: "label list",
  group: "label",
  summary: "list team and workspace labels",
  fields: ["name", "group", "color"],
  examples: ["lin label list", "lin label list --team ENG"],
  async run({ flags, config }) {
    // Scoped to a team: that team's labels plus the workspace-wide ones, since
    // both can be applied to the team's issues.
    const team = config.team ? await resolveTeam(config.team, noCache(flags)) : null;
    const filter = team
      ? { or: [{ team: { id: { eq: team.id } } }, { team: { null: true } }] }
      : undefined;

    const data = await gql<ListResponse>(LIST_QUERY, {
      filter,
      first: config.limit ?? DEFAULT_LIMIT,
    });

    const rows = data.issueLabels.nodes.map((label) => ({
      name: label.name,
      group: label.parent?.name,
      color: label.color,
    }));

    table("labels", rows, ["name", "group", "color"]);
  },
});

// --- label create -----------------------------------------------------------

const CREATE_MUTATION = `mutation LinLabelCreate($input: IssueLabelCreateInput!) {
  issueLabelCreate(input: $input) {
    issueLabel { name parent { name } }
  }
}`;

interface CreateResponse {
  issueLabelCreate: { issueLabel: LabelName };
}

export const labelCreate = defineCommand({
  name: "label create",
  group: "label",
  summary: "create a team or workspace label",
  flags: {
    name: { type: "string", valueHint: "text", doc: "the label's name" },
    workspace: { type: "boolean", doc: "create the label for the whole workspace" },
    color: { type: "string", valueHint: "#hex", doc: "hex color, e.g. #eb5757" },
    parent: { type: "string", valueHint: "group", doc: "label group to create it inside" },
  },
  examples: [
    "lin label create --team ENG --name Flaky --color #eb5757",
    "lin label create --workspace --name Compliance --parent Governance",
  ],
  async run({ flags, config }) {
    const name = flagString(flags, "name");
    if (name === undefined || name === "") {
      throw new LinError(EXIT.input, "label create needs a name", "example: --name Flaky");
    }

    const workspaceWide = flagBool(flags, "workspace");
    const teamRef = workspaceWide ? undefined : config.team;
    if (!workspaceWide && teamRef === undefined) {
      throw new LinError(
        EXIT.input,
        "no scope for the new label",
        "pass --team KEY for a team label, or --workspace for a workspace label",
      );
    }

    const color = readColor(flags);
    const team = teamRef === undefined ? null : await resolveTeam(teamRef, noCache(flags));
    const group = flagString(flags, "parent");
    const parent = group === undefined ? null : await resolveLabel(teamRef, group, noCache(flags));

    const data = await gql<CreateResponse>(CREATE_MUTATION, {
      input: {
        name,
        ...(team && { teamId: team.id }),
        ...(color !== undefined && { color }),
        ...(parent && { parentId: parent.id }),
      },
    });

    const label = data.issueLabelCreate.issueLabel;
    created(qualify(label.name, label.parent?.name));
  },
});

// --- label update -----------------------------------------------------------

const UPDATE_MUTATION = `mutation LinLabelUpdate($id: String!, $input: IssueLabelUpdateInput!) {
  issueLabelUpdate(id: $id, input: $input) {
    issueLabel { name color parent { name } }
  }
}`;

interface UpdateResponse {
  issueLabelUpdate: { issueLabel: LabelNode };
}

export const labelUpdate = defineCommand({
  name: "label update",
  group: "label",
  summary: "rename, recolor, or regroup a label",
  args: [{ name: "label", doc: "label name, or group/label", required: true }],
  flags: {
    name: { type: "string", valueHint: "text", doc: "new name" },
    color: { type: "string", valueHint: "#hex", doc: "new hex color, e.g. #eb5757" },
    parent: { type: "string", valueHint: "group", doc: "label group to move it into" },
  },
  examples: ["lin label update Bug --name Defect", "lin label update Priority/P0 --color #eb5757"],
  async run({ args, flags, config }) {
    const ref = args[0];
    if (ref === undefined) {
      throw new LinError(EXIT.input, "label update needs a label", "example: lin label update Bug");
    }

    // Validate the flags before spending a lookup on them.
    const name = flagString(flags, "name");
    const color = readColor(flags);
    const group = flagString(flags, "parent");
    if (name === undefined && color === undefined && group === undefined) {
      throw new LinError(
        EXIT.input,
        `nothing to change on label "${ref}"`,
        "pass --name, --color, or --parent",
      );
    }

    const current = await resolveLabel(config.team, ref, noCache(flags));
    const parent = group === undefined ? null : await resolveLabel(config.team, group, noCache(flags));

    const data = await gql<UpdateResponse>(UPDATE_MUTATION, {
      id: current.id,
      input: {
        ...(name !== undefined && { name }),
        ...(color !== undefined && { color }),
        ...(parent && { parentId: parent.id }),
      },
    });

    // `to` is read back from the mutation; `from` is the cached pre-state, the
    // only record of what the label looked like before the write.
    const label = data.issueLabelUpdate.issueLabel;
    const changes: Change[] = [
      { field: "name", from: current.name, to: label.name },
      { field: "color", from: current.color, to: label.color },
      { field: "group", from: current.parent, to: label.parent?.name ?? null },
    ].filter((change) => (change.from ?? "") !== (change.to ?? ""));

    changed(qualify(label.name, label.parent?.name), changes);
  },
});

// --- label archive ----------------------------------------------------------

const ARCHIVE_MUTATION = `mutation LinLabelArchive($id: String!) {
  issueLabelRetire(id: $id) {
    issueLabel { name parent { name } }
  }
}`;

interface ArchiveResponse {
  issueLabelRetire: { issueLabel: LabelName };
}

export const labelArchive = defineCommand({
  name: "label archive",
  group: "label",
  summary: "retire a label so it cannot be applied to new issues",
  args: [{ name: "label", doc: "label name, or group/label", required: true }],
  examples: ["lin label archive Flaky"],
  async run({ args, flags, config }) {
    const ref = args[0];
    if (ref === undefined) {
      throw new LinError(EXIT.input, "label archive needs a label", "example: lin label archive Flaky");
    }

    const current = await resolveLabel(config.team, ref, noCache(flags));
    const data = await gql<ArchiveResponse>(ARCHIVE_MUTATION, { id: current.id });

    const label = data.issueLabelRetire.issueLabel;
    simpleReceipt("archived", qualify(label.name, label.parent?.name));
  },
});
