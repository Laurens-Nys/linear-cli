// owned by: core agent
// Raw GraphQL. The escape hatch for everything the typed verbs do not cover.

import { encode } from "@toon-format/toon";
import { gqlRaw } from "../client.ts";
import { EXIT, LinError, raw } from "../out.ts";
import { missingCursor, repeatedCursor, tooManyPages, walkPages, type PageInfo } from "../page.ts";
import { defineCommand, flagBool, flagList, flagString } from "../registry.ts";

interface ConnectionSite {
  /** Object holding the connection, e.g. `data.team`. */
  container: Record<string, unknown>;
  /** Key of the connection on that object, e.g. `issues`. */
  key: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isConnection(value: unknown): value is { nodes: unknown[]; pageInfo: Record<string, unknown> } {
  return isRecord(value) && Array.isArray(value["nodes"]) && isRecord(value["pageInfo"]);
}

function asPageInfo(pageInfo: Record<string, unknown>): PageInfo {
  return {
    hasNextPage: pageInfo["hasNextPage"] === true,
    endCursor: typeof pageInfo["endCursor"] === "string" ? pageInfo["endCursor"] : null,
  };
}

/** Every Relay connection in the response tree. */
export function findConnections(node: unknown, sites: ConnectionSite[] = []): ConnectionSite[] {
  if (!isRecord(node)) return sites;
  for (const [key, value] of Object.entries(node)) {
    if (isConnection(value)) sites.push({ container: node, key });
    if (isRecord(value)) findConnections(value, sites);
    else if (Array.isArray(value)) for (const item of value) findConnections(item, sites);
  }
  return sites;
}

/** `--var k=v`, repeatable. Values are always strings. */
export function parseVarFlags(pairs: readonly string[]): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const pair of pairs) {
    const equals = pair.indexOf("=");
    if (equals <= 0) {
      throw new LinError(EXIT.input, `--var "${pair}" is not k=v`, "write it as --var name=value");
    }
    variables[pair.slice(0, equals)] = pair.slice(equals + 1);
  }
  return variables;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new LinError(
      EXIT.input,
      "no query given",
      "pass the query as an argument or pipe it on stdin",
    );
  }
  return Bun.stdin.text();
}

function failFromGraphQL(errors: NonNullable<Awaited<ReturnType<typeof gqlRaw>>["errors"]>): never {
  const first = errors[0];
  throw new LinError(
    EXIT.api,
    first?.message ?? "the Linear API returned an error",
    JSON.stringify(errors, null, 2),
  );
}

export default defineCommand({
  name: "api",
  group: "meta",
  summary: "run a raw GraphQL query against the Linear API",
  args: [{ name: "query", doc: "GraphQL document; read from stdin when omitted" }],
  flags: {
    var: {
      type: "repeatable",
      valueHint: "k=v",
      doc: "set a string variable; repeat for more than one",
    },
    "vars-json": { type: "string", valueHint: "json", doc: "set variables from a JSON object" },
    paginate: {
      type: "boolean",
      doc: "follow pageInfo on the response's single connection; the query must accept $after",
    },
    toon: { type: "boolean", doc: "re-encode the response data as TOON instead of JSON" },
  },
  examples: [
    'lin api "query { viewer { id name } }"',
    'lin api "query(\\$id: String!) { issue(id: \\$id) { title } }" --var id=ENG-42',
    'lin api "query(\\$after: String) { issues(first: 50, after: \\$after) { nodes { identifier } pageInfo { hasNextPage endCursor } } }" --paginate',
  ],
  async run({ args, flags }) {
    const document = args[0] ?? (await readStdin());
    if (document.trim() === "") {
      throw new LinError(EXIT.input, "the query is empty", "pass a GraphQL document as an argument or on stdin");
    }

    const variables: Record<string, unknown> = {};
    const varsJson = flagString(flags, "vars-json");
    if (varsJson !== undefined) {
      try {
        Object.assign(variables, JSON.parse(varsJson) as Record<string, unknown>);
      } catch (cause) {
        throw new LinError(
          EXIT.input,
          `--vars-json is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
          "pass a JSON object, e.g. --vars-json '{\"id\":\"ENG-42\"}'",
        );
      }
    }
    Object.assign(variables, parseVarFlags(flagList(flags, "var")));

    const paginate = flagBool(flags, "paginate");
    if (paginate && !/\$after\b/.test(document)) {
      throw new LinError(
        EXIT.input,
        "--paginate needs the query to accept a cursor",
        "declare ($after: String) on the operation and pass after: $after to the connection",
      );
    }

    const first = await gqlRaw<Record<string, unknown>>(document, variables);
    if (first.errors && first.errors.length > 0) failFromGraphQL(first.errors);
    const data = first.data ?? {};

    if (paginate) await followPages(document, variables, data);

    raw(flagBool(flags, "toon") ? `${encode(data)}\n` : `${JSON.stringify(data, null, 2)}\n`);
  },
});

/** Walk `pageInfo` until it runs out, appending nodes into the first response. */
async function followPages(
  document: string,
  variables: Record<string, unknown>,
  data: Record<string, unknown>,
): Promise<void> {
  const sites = findConnections(data);
  if (sites.length !== 1) {
    throw new LinError(
      EXIT.input,
      sites.length === 0
        ? "--paginate found no connection in the response"
        : `--paginate needs exactly one connection in the response, found ${sites.length}`,
      "select a single connection with nodes and pageInfo { hasNextPage endCursor }",
    );
  }

  const site = sites[0] as ConnectionSite;
  const target = site.container[site.key] as { nodes: unknown[]; pageInfo: Record<string, unknown> };
  const missing = missingCursor(
    "pagination cursor missing",
    "the query must return pageInfo { hasNextPage endCursor }",
  );
  const repeated = repeatedCursor(
    "pagination cursor repeated",
    "stop --paginate or change the query",
  );
  const after = typeof variables["after"] === "string" && variables["after"] !== "" ? variables["after"] : null;
  let lastPageInfo = target.pageInfo;
  const walked = await walkPages(
    { nodes: target.nodes, pageInfo: asPageInfo(target.pageInfo) },
    async (cursor) => {
      const next = await gqlRaw<Record<string, unknown>>(document, { ...variables, after: cursor });
      if (next.errors && next.errors.length > 0) failFromGraphQL(next.errors);

      const nextSites = findConnections(next.data ?? {});
      const nextSite = nextSites[0];
      if (!nextSite) throw missing;
      const connection = nextSite.container[nextSite.key] as {
        nodes: unknown[];
        pageInfo: Record<string, unknown>;
      };
      lastPageInfo = connection.pageInfo;
      return { nodes: connection.nodes, pageInfo: asPageInfo(connection.pageInfo) };
    },
    after,
    {
      missing,
      repeated,
      tooMany: tooManyPages(
        "pagination exceeded maximum pages",
        "stop --paginate or change the query",
      ),
    },
  );

  target.nodes.splice(0, target.nodes.length, ...walked.nodes);
  target.pageInfo = {
    ...lastPageInfo,
    hasNextPage: walked.pageInfo.hasNextPage,
    endCursor: walked.pageInfo.endCursor,
  };
}
