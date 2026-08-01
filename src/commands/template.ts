// owned by: workspace agent
// template list / view — the issue, project and document templates a create
// command can name.

import { gql } from "../client.ts";
import { EXIT, LinError, record, table } from "../out.ts";
import { defineCommand, flagBool, type Flags } from "../registry.ts";
import { resolveTeam, resolveTemplate } from "../resolve.ts";

const noCache = (flags: Flags) => ({ noCache: flagBool(flags, "no-cache") });

// --- template list ----------------------------------------------------------

// `templates` is a plain list, not a connection: the workspace's templates all
// arrive at once, so there is nothing to paginate. `team { key }` is selected
// to scope the list, not to print it.
const LIST_QUERY = `query LinTemplateList {
  templates { id name type team { key } }
}`;

interface ListResponse {
  templates: { id: string; name: string; type: string; team: { key: string } | null }[];
}

export const templateList = defineCommand({
  name: "template list",
  group: "template",
  summary: "list issue, project, and document templates",
  examples: ["lin template list", "lin template list --team ENG"],
  async run({ flags, config }) {
    const team = config.team ? await resolveTeam(config.team, noCache(flags)) : null;
    const data = await gql<ListResponse>(LIST_QUERY);

    // Workspace templates (team null) are usable from any team, so a scoped
    // list keeps them alongside the team's own.
    const rows = data.templates
      .filter((template) => !team || template.team === null || template.team.key === team.key)
      .map((template) => ({ id: template.id, name: template.name, type: template.type }));

    table("templates", rows, ["id", "name", "type"]);
  },
});

// --- template view ----------------------------------------------------------

const VIEW_QUERY = `query LinTemplateView($id: String!) {
  template(id: $id) { id name type description team { key } templateData }
}`;

interface ViewResponse {
  template: {
    id: string;
    name: string;
    type: string;
    description: string | null;
    team: { key: string } | null;
    templateData: unknown;
  };
}

/**
 * `templateData` is the whole pre-filled entity — too large to print and of no
 * use verbatim. The top-level keys say what the template actually fills in.
 * The API types it as JSON but documents it as a JSON-encoded string, so accept
 * either.
 */
export function templateDataKeys(value: unknown): string[] | undefined {
  let data = value;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return undefined;
    }
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
  const keys = Object.keys(data as Record<string, unknown>).sort();
  return keys.length > 0 ? keys : undefined;
}

export const templateView = defineCommand({
  name: "template view",
  group: "template",
  summary: "show a template and the fields it pre-fills",
  args: [{ name: "ref", doc: "template name or id", required: true }],
  examples: ["lin template view 'Bug report'"],
  async run({ args, flags, config }) {
    const ref = args[0];
    if (ref === undefined) {
      throw new LinError(
        EXIT.input,
        "template view needs a template",
        "run lin template list to see the templates in this workspace",
      );
    }

    const template = await resolveTemplate(ref, config.team, noCache(flags));
    const { template: found } = await gql<ViewResponse>(VIEW_QUERY, { id: template.id });

    record({
      id: found.id,
      name: found.name,
      type: found.type,
      team: found.team?.key,
      description: found.description,
      fills: templateDataKeys(found.templateData),
    });
  },
});
