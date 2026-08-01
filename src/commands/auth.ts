// owned by: core agent
// Who the key is, where it points, and how much budget is left.

import * as client from "../client.ts";
import { record } from "../out.ts";
import { defineCommand } from "../registry.ts";

export const AUTH_QUERY = `query LinAuth {
  viewer { id name email organization { urlKey name } }
}`;

interface AuthResponse {
  viewer: {
    id: string;
    name: string;
    email: string;
    organization: { urlKey: string; name: string };
  };
}

export default defineCommand({
  name: "auth",
  group: "meta",
  summary: "show the API key's identity, workspace, and rate-limit budget",
  examples: ["lin auth"],
  async run() {
    const data = await client.gql<AuthResponse>(AUTH_QUERY);
    const { viewer } = data;
    // Read after the request: the budget comes from that response's headers.
    const rate = client.lastRateInfo;

    record({
      id: viewer.id,
      name: viewer.name,
      email: viewer.email,
      workspace: viewer.organization.urlKey,
      organization: viewer.organization.name,
      requestsRemaining: rate?.requestsRemaining,
      requestsLimit: rate?.requestsLimit,
      requestsReset: rate?.requestsReset,
      complexityRemaining: rate?.complexityRemaining,
      complexityLimit: rate?.complexityLimit,
      complexityReset: rate?.complexityReset,
      lastQueryComplexity: rate?.complexity,
    });
  },
});
