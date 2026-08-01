// owned by: workspace agent
// user list / me — who can be assigned work, and who this key is.

import { gql } from "../client.ts";
import { DEFAULT_LIMIT } from "../config.ts";
import { record, table } from "../out.ts";
import { defineCommand } from "../registry.ts";

// --- user list --------------------------------------------------------------

// Disabled members are included so the `active` column carries information:
// an inactive member still owns history but cannot be assigned new work.
const LIST_QUERY = `query LinUserList($first: Int) {
  users(first: $first, includeDisabled: true) {
    nodes { name email active }
  }
}`;

interface ListResponse {
  users: { nodes: { name: string; email: string; active: boolean }[] };
}

export const userList = defineCommand({
  name: "user list",
  group: "user",
  summary: "list the workspace's members",
  examples: ["lin user list"],
  async run({ config }) {
    const data = await gql<ListResponse>(LIST_QUERY, { first: config.limit ?? DEFAULT_LIMIT });

    const rows = data.users.nodes.map((user) => ({
      name: user.name,
      email: user.email,
      active: user.active,
    }));

    table("users", rows, ["name", "email", "active"]);
  },
});

// --- user me ----------------------------------------------------------------

const ME_QUERY = `query LinUserMe {
  viewer { name displayName email admin organization { urlKey } }
}`;

interface MeResponse {
  viewer: {
    name: string;
    displayName: string;
    email: string;
    admin: boolean;
    organization: { urlKey: string };
  };
}

export const userMe = defineCommand({
  name: "user me",
  group: "user",
  summary: "show the identity behind LINEAR_API_KEY",
  examples: ["lin user me"],
  async run() {
    const { viewer } = await gql<MeResponse>(ME_QUERY);

    record({
      name: viewer.name,
      displayName: viewer.displayName,
      email: viewer.email,
      admin: viewer.admin,
      workspace: viewer.organization.urlKey,
    });
  },
});
