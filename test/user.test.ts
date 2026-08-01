import { describe, expect, test } from "bun:test";
import { userList, userMe } from "../src/commands/user.ts";
import { captureStdout, mock, sandbox, type RecordedCall } from "./harness.ts";

/** Neither user command touches the metadata cache, so none is seeded. */
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

describe("user list", () => {
  test("lists members, including deactivated ones so `active` means something", async () => {
    const { calls, output } = await cli(
      [
        {
          match: "LinUserList",
          data: {
            users: {
              nodes: [
                { name: "Casey Jordan", email: "casey@acme.test", active: true },
                { name: "Alex Rivera", email: "alex@acme.test", active: false },
              ],
            },
          },
        },
      ],
      () => userList.run({ args: [], flags: {}, config: { limit: 50 }, command: userList }),
    );

    expect(calls[0]?.operation).toBe("LinUserList");
    expect(calls[0]?.variables).toEqual({ first: 50 });
    expect(calls[0]?.document).toContain("includeDisabled: true");
    expect(output).toBe(
      "users[2]{name,email,active}:\n" +
        "  Casey Jordan,casey@acme.test,true\n" +
        "  Alex Rivera,alex@acme.test,false\n",
    );
  });

  test("honours -n", async () => {
    const { calls } = await cli([{ match: "LinUserList", data: { users: { nodes: [] } } }], () =>
      userList.run({ args: [], flags: { limit: 5 }, config: { limit: 5 }, command: userList }),
    );

    expect(calls[0]?.variables).toEqual({ first: 5 });
  });
});

describe("user me", () => {
  test("renders the identity behind the API key", async () => {
    const { calls, output } = await cli(
      [
        {
          match: "LinUserMe",
          data: {
            viewer: {
              name: "Casey Jordan",
              displayName: "casey",
              email: "casey@acme.test",
              admin: true,
              organization: { urlKey: "acme" },
            },
          },
        },
      ],
      () => userMe.run({ args: [], flags: {}, config: { limit: 50 }, command: userMe }),
    );

    expect(calls[0]?.operation).toBe("LinUserMe");
    expect(output).toBe(
      [
        "name: Casey Jordan",
        "displayName: casey",
        "email: casey@acme.test",
        "admin: true",
        "workspace: acme",
        "",
      ].join("\n"),
    );
  });

  test("a non-admin key says so rather than staying silent", async () => {
    const { output } = await cli(
      [
        {
          match: "LinUserMe",
          data: {
            viewer: {
              name: "Alex Rivera",
              displayName: "alex",
              email: "alex@acme.test",
              admin: false,
              organization: { urlKey: "acme" },
            },
          },
        },
      ],
      () => userMe.run({ args: [], flags: {}, config: { limit: 50 }, command: userMe }),
    );

    expect(output).toContain("admin: false\n");
  });
});
