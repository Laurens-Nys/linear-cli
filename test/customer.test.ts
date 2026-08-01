import { describe, expect, test } from "bun:test";
import {
  clip,
  customerCreate,
  customerList,
  customerView,
  needAdd,
  needList,
} from "../src/commands/customer.ts";
import { EXIT, LinError } from "../src/out.ts";
import { captureStdout, mock, sandbox, type RecordedCall } from "./harness.ts";

/** No customer command reads the metadata cache; customers are not cached. */
async function cli(
  responses: Parameters<typeof mock>[0],
  invoke: () => Promise<void> | void,
): Promise<{ calls: RecordedCall[]; output: string }> {
  const box = sandbox();
  const stub = mock(responses);
  const captured = captureStdout();
  try {
    await invoke();
    return { calls: stub.calls, output: captured.text() };
  } finally {
    captured.restore();
    stub.restore();
    box.cleanup();
  }
}

async function cliError(
  responses: Parameters<typeof mock>[0],
  invoke: () => Promise<void> | void,
): Promise<LinError> {
  try {
    await cli(responses, invoke);
  } catch (error) {
    expect(error).toBeInstanceOf(LinError);
    return error as LinError;
  }
  throw new Error("expected a LinError, but the command succeeded");
}

const NORTHWIND = "77770000-1111-4222-8333-444455556666";

describe("customer list", () => {
  test("lists customers with tier and status", async () => {
    const { calls, output } = await cli(
      [
        {
          match: "LinCustomerList",
          data: {
            customers: {
              nodes: [
                { name: "Northwind", tier: { name: "Enterprise" }, status: { name: "Active" } },
                { name: "Contoso", tier: null, status: { name: "Prospect" } },
              ],
            },
          },
        },
      ],
      () => customerList.run({ args: [], flags: {}, config: { limit: 50 }, command: customerList }),
    );

    expect(calls[0]?.operation).toBe("LinCustomerList");
    expect(calls[0]?.variables).toEqual({ first: 50 });
    expect(output).toBe(
      "customers[2]{name,tier,status}:\n" +
        "  Northwind,Enterprise,Active\n" +
        "  Contoso,,Prospect\n",
    );
  });
});

describe("customer view", () => {
  test("matches the customer by name and lists its recent needs", async () => {
    const { calls, output } = await cli(
      [
        {
          match: "LinCustomerView",
          data: {
            customers: {
              nodes: [
                {
                  name: "Northwind",
                  slugId: "northwind-1a2b3c",
                  domains: ["northwind.test"],
                  revenue: 120000,
                  size: null,
                  url: "https://linear.app/acme/customer/northwind-1a2b3c",
                  tier: { name: "Enterprise" },
                  status: { name: "Active" },
                  owner: { displayName: "casey" },
                },
              ],
            },
            customerNeeds: {
              nodes: [
                {
                  id: "ee7057d3-3b37-4d31-a727-2aa2398fe25b",
                  body: "Blocks   their\nrollout",
                  issue: { identifier: "ENG-42" },
                },
                { id: "638f042e-d0c2-45b1-932e-3de9bc31516a", body: null, issue: { identifier: "ENG-41" } },
              ],
            },
          },
        },
      ],
      () =>
        customerView.run({
          args: ["northwind"],
          flags: {},
          config: { limit: 50 },
          command: customerView,
        }),
    );

    expect(calls[0]?.operation).toBe("LinCustomerView");
    expect(calls[0]?.variables).toEqual({ name: "northwind", needs: 5 });
    expect(output).toBe(
      [
        "name: Northwind",
        "tier: Enterprise",
        "status: Active",
        "owner: casey",
        "domains[1]: northwind.test",
        "revenue: 120000",
        "url: https://linear.app/acme/customer/northwind-1a2b3c",
        "needs[2]{ref,issue,body}:",
        "  ee7057d3,ENG-42,Blocks their rollout",
        "  638f042e,ENG-41,",
        "",
      ].join("\n"),
    );
  });

  test("an unknown customer is not found, and says where the names live", async () => {
    const error = await cliError(
      [
        {
          match: "LinCustomerView",
          data: { customers: { nodes: [] }, customerNeeds: { nodes: [] } },
        },
      ],
      () =>
        customerView.run({ args: ["Acme"], flags: {}, config: { limit: 50 }, command: customerView }),
    );

    expect(error.exitCode).toBe(EXIT.notFound);
    expect(error.message).toBe('no customer "Acme"');
    expect(error.hint).toBe("run lin customer list to see the customers in this workspace");
  });
});

describe("customer create", () => {
  test("resolves the tier by name before writing", async () => {
    const { calls, output } = await cli(
      [
        {
          match: "LinCustomerTiers",
          data: { customerTiers: { nodes: [{ id: "tier-ent", name: "Enterprise" }] } },
        },
        {
          match: "LinCustomerCreate",
          data: {
            customerCreate: {
              customer: {
                name: "Northwind",
                url: "https://linear.app/acme/customer/northwind-1a2b3c",
              },
            },
          },
        },
      ],
      () =>
        customerCreate.run({
          args: [],
          flags: { name: "Northwind", domain: ["northwind.test"], tier: "enterprise" },
          config: { limit: 50 },
          command: customerCreate,
        }),
    );

    expect(calls.map((call) => call.operation)).toEqual(["LinCustomerTiers", "LinCustomerCreate"]);
    expect(calls[1]?.variables).toEqual({
      input: { name: "Northwind", domains: ["northwind.test"], tierId: "tier-ent" },
    });
    expect(output).toBe(
      "created: Northwind\nurl: https://linear.app/acme/customer/northwind-1a2b3c\n",
    );
  });

  test("an unknown tier lists the tiers the workspace defines", async () => {
    const error = await cliError(
      [
        {
          match: "LinCustomerTiers",
          data: {
            customerTiers: {
              nodes: [
                { id: "tier-ent", name: "Enterprise" },
                { id: "tier-smb", name: "SMB" },
              ],
            },
          },
        },
      ],
      () =>
        customerCreate.run({
          args: [],
          flags: { name: "Northwind", tier: "Platinum" },
          config: { limit: 50 },
          command: customerCreate,
        }),
    );

    expect(error.exitCode).toBe(EXIT.input);
    expect(error.message).toBe('no customer tier "Platinum"');
    expect(error.hint).toBe("tiers: Enterprise, SMB");
  });

  test("a create with no name says which flag is missing", async () => {
    const error = await cliError([], () =>
      customerCreate.run({ args: [], flags: {}, config: { limit: 50 }, command: customerCreate }),
    );

    expect(error.exitCode).toBe(EXIT.input);
    expect(error.message).toBe("customer create needs a name");
  });
});

describe("need add", () => {
  test("resolves the customer and the issue, then attaches the request", async () => {
    const { calls, output } = await cli(
      [
        {
          match: "LinCustomerFind",
          data: { customers: { nodes: [{ id: NORTHWIND, name: "Northwind" }] } },
        },
        { match: "LinIssueId", data: { issue: { id: "99990000-1111-4222-8333-444455556666" } } },
        {
          match: "LinCustomerNeedCreate",
          data: {
            customerNeedCreate: {
              need: {
                id: "ee7057d3-3b37-4d31-a727-2aa2398fe25b",
                url: "https://linear.app/acme/customer-request/ee7057d3",
              },
            },
          },
        },
      ],
      () =>
        needAdd.run({
          args: ["Northwind"],
          flags: { issue: "ENG-42", message: "blocks their rollout" },
          config: { limit: 50 },
          command: needAdd,
        }),
    );

    expect(calls.map((call) => call.operation)).toEqual([
      "LinCustomerFind",
      "LinIssueId",
      "LinCustomerNeedCreate",
    ]);
    expect(calls[2]?.variables).toEqual({
      input: {
        customerId: NORTHWIND,
        issueId: "99990000-1111-4222-8333-444455556666",
        body: "blocks their rollout",
      },
    });
    expect(output).toBe(
      "created: ee7057d3\nurl: https://linear.app/acme/customer-request/ee7057d3\n",
    );
  });

  test("a missing --issue names the flag", async () => {
    const error = await cliError([], () =>
      needAdd.run({ args: ["Northwind"], flags: {}, config: { limit: 50 }, command: needAdd }),
    );

    expect(error.exitCode).toBe(EXIT.input);
    expect(error.message).toBe("need add needs an issue");
    expect(error.hint).toBe("example: --issue ENG-42");
  });
});

describe("need list", () => {
  test("filters by customer name and clips the body", async () => {
    const { calls, output } = await cli(
      [
        {
          match: "LinCustomerNeedList",
          data: {
            customerNeeds: {
              nodes: [
                {
                  id: "ee7057d3-3b37-4d31-a727-2aa2398fe25b",
                  body: "Blocks their rollout",
                  customer: { name: "Northwind" },
                  issue: { identifier: "ENG-42" },
                },
                {
                  id: "638f042e-d0c2-45b1-932e-3de9bc31516a",
                  body: null,
                  customer: { name: "Northwind" },
                  issue: null,
                },
              ],
            },
          },
        },
      ],
      () =>
        needList.run({
          args: [],
          flags: { customer: "Northwind" },
          config: { limit: 50 },
          command: needList,
        }),
    );

    expect(calls[0]?.operation).toBe("LinCustomerNeedList");
    expect(calls[0]?.variables).toEqual({
      filter: { customer: { name: { eqIgnoreCase: "Northwind" } } },
      first: 50,
    });
    expect(output).toBe(
      "needs[2]{ref,customer,issue,body}:\n" +
        "  ee7057d3,Northwind,ENG-42,Blocks their rollout\n" +
        "  638f042e,Northwind,,\n",
    );
  });

  test("filtering by issue resolves the identifier to a UUID first", async () => {
    const { calls } = await cli(
      [
        { match: "LinIssueId", data: { issue: { id: "99990000-1111-4222-8333-444455556666" } } },
        { match: "LinCustomerNeedList", data: { customerNeeds: { nodes: [] } } },
      ],
      () =>
        needList.run({
          args: [],
          flags: { issue: "ENG-42" },
          config: { limit: 50 },
          command: needList,
        }),
    );

    expect(calls.map((call) => call.operation)).toEqual(["LinIssueId", "LinCustomerNeedList"]);
    expect(calls[1]?.variables).toEqual({
      filter: { issue: { id: { eq: "99990000-1111-4222-8333-444455556666" } } },
      first: 50,
    });
  });

  test("with no filter the whole workspace's needs come back", async () => {
    const { calls } = await cli(
      [{ match: "LinCustomerNeedList", data: { customerNeeds: { nodes: [] } } }],
      () => needList.run({ args: [], flags: {}, config: { limit: 50 }, command: needList }),
    );

    expect(calls[0]?.variables).toEqual({ first: 50 });
  });
});

describe("clip", () => {
  test("collapses whitespace and marks a truncation", () => {
    expect(clip("a\n  b\tc ")).toBe("a b c");
    expect(clip(null)).toBe("");
    expect(clip("x".repeat(120))).toBe(`${"x".repeat(100)}...`);
  });
});
