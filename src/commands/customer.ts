// owned by: workspace agent
// customer list / view / create, plus the customer needs that tie a customer
// to an issue.
//
// Customers are not in the metadata cache, so a name is resolved with a
// filtered query rather than through resolve.ts.

import { gql } from "../client.ts";
import { DEFAULT_LIMIT } from "../config.ts";
import { created, EXIT, LinError, record, table } from "../out.ts";
import { defineCommand, flagList, flagString } from "../registry.ts";
import { resolveIssueUUID } from "../resolve.ts";

/** Needs are referred to by the first 8 hex characters of their UUID. */
export function needRef(id: string): string {
  return id.slice(0, 8);
}

/** Bodies are prose; a table cell only needs enough to recognise which one it is. */
export function clip(text: string | null, limit = 100): string {
  if (text === null) return "";
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}...` : collapsed;
}

// --- customer name resolution ------------------------------------------------

const FIND_QUERY = `query LinCustomerFind($name: String!) {
  customers(filter: { name: { eqIgnoreCase: $name } }, first: 5) {
    nodes { id name }
  }
}`;

interface FindResponse {
  customers: { nodes: { id: string; name: string }[] };
}

async function findCustomer(ref: string): Promise<{ id: string; name: string }> {
  const data = await gql<FindResponse>(FIND_QUERY, { name: ref });
  const matches = data.customers.nodes;
  const [first] = matches;

  if (matches.length === 1 && first !== undefined) return first;
  if (matches.length === 0) {
    throw new LinError(
      EXIT.notFound,
      `no customer "${ref}"`,
      "run lin customer list to see the customers in this workspace",
    );
  }
  throw new LinError(
    EXIT.input,
    `customer "${ref}" is ambiguous`,
    `matches: ${matches.map((match) => match.id).join(", ")}`,
  );
}

// --- customer list ----------------------------------------------------------

const LIST_QUERY = `query LinCustomerList($first: Int) {
  customers(first: $first) {
    nodes { name tier { name } status { name } }
  }
}`;

interface ListResponse {
  customers: {
    nodes: { name: string; tier: { name: string } | null; status: { name: string } | null }[];
  };
}

export const customerList = defineCommand({
  name: "customer list",
  group: "customer",
  summary: "list the workspace's customers",
  examples: ["lin customer list"],
  async run({ config }) {
    const data = await gql<ListResponse>(LIST_QUERY, { first: config.limit ?? DEFAULT_LIMIT });

    const rows = data.customers.nodes.map((customer) => ({
      name: customer.name,
      tier: customer.tier?.name,
      status: customer.status?.name,
    }));

    table("customers", rows, ["name", "tier", "status"]);
  },
});

// --- customer view ----------------------------------------------------------

// One request: the customer is matched by name, and its recent needs are
// matched by the same name through the need filter.
const VIEW_QUERY = `query LinCustomerView($name: String!, $needs: Int) {
  customers(filter: { name: { eqIgnoreCase: $name } }, first: 5) {
    nodes {
      name slugId domains revenue size url
      tier { name } status { name } owner { displayName }
    }
  }
  customerNeeds(filter: { customer: { name: { eqIgnoreCase: $name } } }, first: $needs) {
    nodes { id body issue { identifier } }
  }
}`;

interface ViewResponse {
  customers: {
    nodes: {
      name: string;
      slugId: string;
      domains: string[];
      revenue: number | null;
      size: number | null;
      url: string;
      tier: { name: string } | null;
      status: { name: string } | null;
      owner: { displayName: string } | null;
    }[];
  };
  customerNeeds: {
    nodes: { id: string; body: string | null; issue: { identifier: string } | null }[];
  };
}

const RECENT_NEEDS = 5;

export const customerView = defineCommand({
  name: "customer view",
  group: "customer",
  summary: "show a customer and its most recent needs",
  args: [{ name: "ref", doc: "customer name", required: true }],
  examples: ["lin customer view Northwind"],
  async run({ args }) {
    const ref = args[0];
    if (ref === undefined) {
      throw new LinError(
        EXIT.input,
        "customer view needs a customer",
        "run lin customer list to see the customers in this workspace",
      );
    }

    const data = await gql<ViewResponse>(VIEW_QUERY, { name: ref, needs: RECENT_NEEDS });
    const matches = data.customers.nodes;
    const [customer] = matches;

    if (customer === undefined) {
      throw new LinError(
        EXIT.notFound,
        `no customer "${ref}"`,
        "run lin customer list to see the customers in this workspace",
      );
    }
    if (matches.length > 1) {
      throw new LinError(
        EXIT.input,
        `customer "${ref}" is ambiguous`,
        `matches: ${matches.map((match) => match.slugId).join(", ")}`,
      );
    }

    record(
      {
        name: customer.name,
        tier: customer.tier?.name,
        status: customer.status?.name,
        owner: customer.owner?.displayName,
        domains: customer.domains,
        revenue: customer.revenue,
        size: customer.size,
        url: customer.url,
      },
      {
        children: [
          {
            key: "needs",
            rows: data.customerNeeds.nodes.map((need) => ({
              ref: needRef(need.id),
              issue: need.issue?.identifier,
              body: clip(need.body),
            })),
            columns: ["ref", "issue", "body"],
          },
        ],
      },
    );
  },
});

// --- customer create --------------------------------------------------------

const TIERS_QUERY = `query LinCustomerTiers($first: Int) {
  customerTiers(first: $first) { nodes { id name } }
}`;

interface TiersResponse {
  customerTiers: { nodes: { id: string; name: string }[] };
}

/** Tiers are a workspace-defined vocabulary, so a miss lists the real ones. */
async function resolveTier(name: string): Promise<string> {
  const data = await gql<TiersResponse>(TIERS_QUERY, { first: 50 });
  const tiers = data.customerTiers.nodes;
  const match = tiers.find((tier) => tier.name.toLowerCase() === name.toLowerCase());
  if (match) return match.id;

  throw new LinError(
    EXIT.input,
    `no customer tier "${name}"`,
    tiers.length > 0
      ? `tiers: ${tiers.map((tier) => tier.name).join(", ")}`
      : "this workspace has no customer tiers yet",
  );
}

const CREATE_MUTATION = `mutation LinCustomerCreate($input: CustomerCreateInput!) {
  customerCreate(input: $input) {
    customer { name url }
  }
}`;

interface CreateResponse {
  customerCreate: { customer: { name: string; url: string } };
}

export const customerCreate = defineCommand({
  name: "customer create",
  group: "customer",
  summary: "create a customer",
  flags: {
    name: { type: "string", valueHint: "text", doc: "the customer's name" },
    domain: { type: "repeatable", valueHint: "example.com", doc: "email domain; repeat to add more" },
    tier: { type: "string", valueHint: "name", doc: "customer tier name" },
  },
  examples: ["lin customer create --name Northwind --domain northwind.test --tier Enterprise"],
  async run({ flags }) {
    const name = flagString(flags, "name");
    if (name === undefined || name === "") {
      throw new LinError(EXIT.input, "customer create needs a name", "example: --name Northwind");
    }

    const domains = flagList(flags, "domain");
    const tier = flagString(flags, "tier");
    const tierId = tier === undefined ? undefined : await resolveTier(tier);

    const data = await gql<CreateResponse>(CREATE_MUTATION, {
      input: {
        name,
        ...(domains.length > 0 && { domains }),
        ...(tierId !== undefined && { tierId }),
      },
    });

    const customer = data.customerCreate.customer;
    created(customer.name, customer.url);
  },
});

// --- need add ---------------------------------------------------------------

const NEED_CREATE_MUTATION = `mutation LinCustomerNeedCreate($input: CustomerNeedCreateInput!) {
  customerNeedCreate(input: $input) {
    need { id url }
  }
}`;

interface NeedCreateResponse {
  customerNeedCreate: { need: { id: string; url: string | null } };
}

export const needAdd = defineCommand({
  name: "need add",
  group: "customer",
  summary: "attach a customer's request to an issue",
  args: [{ name: "customer", doc: "customer name", required: true }],
  flags: {
    issue: { type: "string", valueHint: "id", doc: "issue the request is about" },
    message: { type: "string", short: "m", valueHint: "text", doc: "what the customer asked for" },
  },
  examples: ["lin need add Northwind --issue ENG-42 -m 'blocks their rollout'"],
  async run({ args, flags }) {
    const ref = args[0];
    if (ref === undefined) {
      throw new LinError(
        EXIT.input,
        "need add needs a customer",
        "example: lin need add Northwind --issue ENG-42",
      );
    }

    const issue = flagString(flags, "issue");
    if (issue === undefined || issue === "") {
      throw new LinError(EXIT.input, "need add needs an issue", "example: --issue ENG-42");
    }

    const customer = await findCustomer(ref);
    const issueId = await resolveIssueUUID(issue);
    const body = flagString(flags, "message");

    const data = await gql<NeedCreateResponse>(NEED_CREATE_MUTATION, {
      input: {
        customerId: customer.id,
        issueId,
        ...(body !== undefined && { body }),
      },
    });

    const need = data.customerNeedCreate.need;
    created(needRef(need.id), need.url ?? undefined);
  },
});

// --- need list --------------------------------------------------------------

const NEED_LIST_QUERY = `query LinCustomerNeedList($filter: CustomerNeedFilter, $first: Int) {
  customerNeeds(filter: $filter, first: $first) {
    nodes { id body customer { name } issue { identifier } }
  }
}`;

interface NeedListResponse {
  customerNeeds: {
    nodes: {
      id: string;
      body: string | null;
      customer: { name: string } | null;
      issue: { identifier: string } | null;
    }[];
  };
}

export const needList = defineCommand({
  name: "need list",
  group: "customer",
  summary: "list customer requests",
  flags: {
    customer: { type: "string", valueHint: "name", doc: "only this customer's requests" },
    issue: { type: "string", valueHint: "id", doc: "only requests about this issue" },
  },
  examples: ["lin need list", "lin need list --customer Northwind", "lin need list --issue ENG-42"],
  async run({ flags, config }) {
    const customer = flagString(flags, "customer");
    const issue = flagString(flags, "issue");

    const filter: Record<string, unknown> = {};
    if (customer !== undefined) filter["customer"] = { name: { eqIgnoreCase: customer } };
    if (issue !== undefined) filter["issue"] = { id: { eq: await resolveIssueUUID(issue) } };

    const data = await gql<NeedListResponse>(NEED_LIST_QUERY, {
      filter: Object.keys(filter).length > 0 ? filter : undefined,
      first: config.limit ?? DEFAULT_LIMIT,
    });

    const rows = data.customerNeeds.nodes.map((need) => ({
      ref: needRef(need.id),
      customer: need.customer?.name,
      issue: need.issue?.identifier,
      body: clip(need.body),
    }));

    table("needs", rows, ["ref", "customer", "issue", "body"]);
  },
});
