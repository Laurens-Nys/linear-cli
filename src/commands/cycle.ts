// owned by: project agent
// cycle list / view / create / update.
//
// Cycles belong to a team and are addressed by number or by the words current,
// next and previous — resolve.resolveCycle owns those.

import { gql } from "../client.ts";
import { changed, created, EXIT, LinError, record, table, type Row } from "../out.ts";
import { defineCommand, flagString } from "../registry.ts";
import { resolveCycle, resolveTeam } from "../resolve.ts";
import { dateFlag, diff, limitOf, percent, requireArg, startOfDay } from "./project.ts";

const LIST_COLUMNS = ["n", "name", "start", "end", "active"];

// --- cycle list -------------------------------------------------------------

export const LIST_QUERY = `query LinCycleList($filter: CycleFilter, $first: Int, $after: String) {
  cycles(filter: $filter, first: $first, after: $after) {
    nodes { number name startsAt endsAt isActive }
  }
}`;

interface ListResponse {
  cycles: {
    nodes: { number: number; name: string | null; startsAt: string; endsAt: string; isActive: boolean }[];
  };
}

export const cycleList = defineCommand({
  name: "cycle list",
  group: "cycle",
  summary: "list a team's cycles, newest first",
  examples: ["lin cycle list --team ENG"],
  async run({ flags, config }) {
    const team = await resolveTeam(config.team);

    const data = await gql<ListResponse>(LIST_QUERY, {
      filter: { team: { id: { eq: team.id } } },
      first: limitOf(config.limit),
      after: flagString(flags, "after"),
    });

    const rows = [...data.cycles.nodes]
      .sort((a, b) => b.number - a.number)
      .map((node) => ({
        n: node.number,
        name: node.name,
        start: node.startsAt,
        end: node.endsAt,
        active: node.isActive,
      }));

    table("cycles", rows, LIST_COLUMNS);
  },
});

// --- cycle view -------------------------------------------------------------

// resolveCycle already returned number, name and dates; ask only for the rest.
export const VIEW_QUERY = `query LinCycleView($id: String!) {
  cycle(id: $id) {
    isActive progress currentProgress
    team { key }
  }
}`;

/** Linear returns the cycle burn-up as an untyped object; these are its keys. */
interface CurrentProgress {
  scopeCount?: number;
  completedIssueCount?: number;
  startedIssueCount?: number;
  unstartedIssueCount?: number;
}

interface ViewResponse {
  cycle: {
    isActive: boolean;
    progress: number;
    currentProgress: CurrentProgress;
    team: { key: string };
  };
}

export const cycleView = defineCommand({
  name: "cycle view",
  group: "cycle",
  summary: "show a cycle with its scope and progress",
  args: [{ name: "cycle", doc: "current, next, previous, or a cycle number", required: true }],
  examples: ["lin cycle view current --team ENG", "lin cycle view 42 --team ENG"],
  async run({ args, config }) {
    const ref = requireArg(args, 0, "cycle view needs a cycle", "example: lin cycle view current --team ENG");

    const resolved = await resolveCycle(config.team, ref);
    const { cycle } = await gql<ViewResponse>(VIEW_QUERY, { id: resolved.id });
    const progress = cycle.currentProgress;

    record({
      n: resolved.number,
      name: resolved.name,
      team: cycle.team.key,
      start: resolved.startsAt,
      end: resolved.endsAt,
      active: cycle.isActive,
      progress: percent(cycle.progress * 100),
      scope: progress.scopeCount,
      completed: progress.completedIssueCount,
      started: progress.startedIssueCount,
      unstarted: progress.unstartedIssueCount,
    });
  },
});

// --- cycle create / update --------------------------------------------------

const WRITE_FLAGS = {
  name: { type: "string", valueHint: "text", doc: "cycle name" },
  start: { type: "string", valueHint: "YYYY-MM-DD", doc: "first day of the cycle" },
  end: { type: "string", valueHint: "YYYY-MM-DD", doc: "last day of the cycle" },
} as const;

export const CREATE_MUTATION = `mutation LinCycleCreate($input: CycleCreateInput!) {
  cycleCreate(input: $input) { cycle { number } }
}`;

interface CreateResponse {
  cycleCreate: { cycle: { number: number } | null };
}

export const cycleCreate = defineCommand({
  name: "cycle create",
  group: "cycle",
  summary: "create a cycle for a team",
  flags: WRITE_FLAGS,
  examples: ["lin cycle create --team ENG --start 2026-08-10 --end 2026-08-24"],
  async run({ flags, config }) {
    const start = dateFlag(flags, "start");
    const end = dateFlag(flags, "end");
    if (start === undefined || end === undefined) {
      throw new LinError(
        EXIT.input,
        "cycle create needs a start and an end",
        "example: --start 2026-08-10 --end 2026-08-24",
      );
    }

    const team = await resolveTeam(config.team);
    const name = flagString(flags, "name");

    const data = await gql<CreateResponse>(
      CREATE_MUTATION,
      {
        input: {
          teamId: team.id,
          startsAt: startOfDay(start),
          endsAt: startOfDay(end),
          ...(name !== undefined && { name }),
        },
      },
      { retry: false },
    );

    const cycle = data.cycleCreate.cycle;
    if (!cycle) throw new LinError(EXIT.api, "the cycle was not created");
    created(String(cycle.number));
  },
});

export const BEFORE_QUERY = `query LinCycleBefore($id: String!) {
  cycle(id: $id) { name startsAt endsAt }
}`;

export const UPDATE_MUTATION = `mutation LinCycleUpdate($id: String!, $input: CycleUpdateInput!) {
  cycleUpdate(id: $id, input: $input) { cycle { number name startsAt endsAt } }
}`;

interface Fields {
  name: string | null;
  startsAt: string;
  endsAt: string;
}

interface BeforeResponse {
  cycle: Fields;
}

interface UpdateResponse {
  cycleUpdate: { cycle: (Fields & { number: number }) | null };
}

function cycleFields(fields: Fields): Row {
  return { name: fields.name, start: fields.startsAt, end: fields.endsAt };
}

export const cycleUpdate = defineCommand({
  name: "cycle update",
  group: "cycle",
  summary: "rename a cycle or move its dates",
  args: [{ name: "cycle", doc: "current, next, previous, or a cycle number", required: true }],
  flags: WRITE_FLAGS,
  examples: ['lin cycle update 42 --team ENG --name "Hardening"'],
  async run({ args, flags, config }) {
    const ref = requireArg(args, 0, "cycle update needs a cycle", 'example: lin cycle update 42 --name "Hardening"');

    const input: Row = {};
    const name = flagString(flags, "name");
    if (name !== undefined) input["name"] = name;
    const start = dateFlag(flags, "start");
    if (start !== undefined) input["startsAt"] = startOfDay(start);
    const end = dateFlag(flags, "end");
    if (end !== undefined) input["endsAt"] = startOfDay(end);

    if (Object.keys(input).length === 0) {
      throw new LinError(EXIT.input, "cycle update needs at least one field", "flags: --name, --start, --end");
    }

    const resolved = await resolveCycle(config.team, ref);
    const before = await gql<BeforeResponse>(BEFORE_QUERY, { id: resolved.id });
    const data = await gql<UpdateResponse>(UPDATE_MUTATION, { id: resolved.id, input }, { retry: false });

    const after = data.cycleUpdate.cycle;
    if (!after) throw new LinError(EXIT.api, "the cycle was not updated");
    changed(String(after.number), diff(cycleFields(before.cycle), cycleFields(after)));
  },
});
