// owned by: workspace agent
// team list / view / states — the vocabulary every write path keys off.

import type { CachedState } from "../cache.ts";
import { gql } from "../client.ts";
import { DEFAULT_LIMIT } from "../config.ts";
import { EXIT, LinError, record, table, type Row } from "../out.ts";
import { defineCommand, flagBool, type Flags } from "../registry.ts";
import { resolveTeam } from "../resolve.ts";

const noCache = (flags: Flags) => ({ noCache: flagBool(flags, "no-cache") });

interface StateShape {
  name: string;
  type: string;
  position: number;
}

const STATE_COLUMNS = ["name", "type", "position"];

/** States arrive unordered; board position is the only meaningful order. */
function stateRows(states: readonly StateShape[] | readonly CachedState[]): Row[] {
  return [...states]
    .sort((a, b) => a.position - b.position)
    .map((state) => ({ name: state.name, type: state.type, position: state.position }));
}

// --- team list --------------------------------------------------------------

const LIST_QUERY = `query LinTeamList($first: Int) {
  teams(first: $first) {
    nodes { key name cyclesEnabled issueCount }
  }
}`;

interface ListResponse {
  teams: {
    nodes: { key: string; name: string; cyclesEnabled: boolean; issueCount: number }[];
  };
}

export const teamList = defineCommand({
  name: "team list",
  group: "team",
  summary: "list the workspace's teams",
  examples: ["lin team list"],
  async run({ config }) {
    const data = await gql<ListResponse>(LIST_QUERY, { first: config.limit ?? DEFAULT_LIMIT });

    const rows = data.teams.nodes.map((team) => ({
      key: team.key,
      name: team.name,
      cycles: team.cyclesEnabled,
      issues: team.issueCount,
    }));

    table("teams", rows, ["key", "name", "cycles", "issues"]);
  },
});

// --- team view --------------------------------------------------------------

const VIEW_QUERY = `query LinTeamView($id: String!) {
  team(id: $id) {
    key name description cyclesEnabled issueCount
    states(first: 50) { nodes { name type position } }
    labels(first: 100) { nodes { name color parent { name } } }
    members(first: 100) { nodes { name email } }
  }
}`;

interface ViewResponse {
  team: {
    key: string;
    name: string;
    description: string | null;
    cyclesEnabled: boolean;
    issueCount: number;
    states: { nodes: StateShape[] };
    labels: { nodes: { name: string; color: string; parent: { name: string } | null }[] };
    members: { nodes: { name: string; email: string }[] };
  };
}

export const teamView = defineCommand({
  name: "team view",
  group: "team",
  summary: "show a team with its states, labels, and members",
  args: [{ name: "key", doc: "team key, defaulting to the configured team" }],
  examples: ["lin team view ENG"],
  async run({ args, flags, config }) {
    const team = await resolveTeam(args[0] ?? config.team, noCache(flags));
    const { team: found } = await gql<ViewResponse>(VIEW_QUERY, { id: team.id });

    record(
      {
        key: found.key,
        name: found.name,
        description: found.description,
        cycles: found.cyclesEnabled,
        issues: found.issueCount,
      },
      {
        children: [
          { key: "states", rows: stateRows(found.states.nodes), columns: STATE_COLUMNS },
          {
            key: "labels",
            rows: found.labels.nodes.map((label) => ({
              name: label.name,
              group: label.parent?.name,
              color: label.color,
            })),
            columns: ["name", "group", "color"],
          },
          {
            key: "members",
            rows: found.members.nodes.map((member) => ({ name: member.name, email: member.email })),
            columns: ["name", "email"],
          },
        ],
      },
    );
  },
});

// --- team states ------------------------------------------------------------

export const teamStates = defineCommand({
  name: "team states",
  group: "team",
  summary: "list a team's workflow states, in board order",
  args: [{ name: "key", doc: "team key, defaulting to the configured team" }],
  examples: ["lin team states ENG"],
  async run({ args, flags, config }) {
    // Served from the metadata cache: these are exactly the states name
    // resolution accepts on a write, so the two can never disagree.
    const team = await resolveTeam(args[0] ?? config.team, noCache(flags));
    if (team.states.length === 0) {
      throw new LinError(
        EXIT.notFound,
        `team ${team.key} has no workflow states`,
        "run lin cache warm to refetch the workspace vocabulary",
      );
    }
    table("states", stateRows(team.states), STATE_COLUMNS);
  },
});
