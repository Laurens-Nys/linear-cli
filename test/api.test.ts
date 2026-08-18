import { describe, expect, test } from "bun:test";
import apiCommand, { findConnections, parseVarFlags } from "../src/commands/api.ts";
import { EXIT, LinError } from "../src/out.ts";
import { MAX_PAGES } from "../src/page.ts";
import type { Flags } from "../src/registry.ts";
import { captureStdout, mock, sandbox, type Mock } from "./harness.ts";

async function runApi(
  args: string[],
  flags: Flags,
  responses: Parameters<typeof mock>[0],
  body: (output: string, stub: Mock) => void,
): Promise<void> {
  const box = sandbox();
  const stub = mock(responses);
  const captured = captureStdout();
  try {
    await apiCommand.run({ args, flags, config: { limit: 50 }, command: apiCommand });
    captured.restore();
    body(captured.text(), stub);
  } finally {
    captured.restore();
    stub.restore();
    box.cleanup();
  }
}

describe("--var parsing", () => {
  test("splits on the first equals so values may contain one", () => {
    expect(parseVarFlags(["id=ENG-42", "q=a=b"])).toEqual({ id: "ENG-42", q: "a=b" });
  });

  test("a value with no equals is exit 2 and shows the form", () => {
    try {
      parseVarFlags(["oops"]);
      throw new Error("expected a LinError");
    } catch (error) {
      expect(error).toBeInstanceOf(LinError);
      expect((error as LinError).exitCode).toBe(EXIT.input);
      expect((error as LinError).hint).toContain("--var name=value");
    }
  });
});

describe("connection discovery", () => {
  test("finds a nested connection", () => {
    const data = { team: { issues: { nodes: [{ id: "1" }], pageInfo: { hasNextPage: false } } } };
    const sites = findConnections(data);
    expect(sites).toHaveLength(1);
    expect(sites[0]?.key).toBe("issues");
  });

  test("counts every connection so --paginate can refuse an ambiguous response", () => {
    const data = {
      issues: { nodes: [], pageInfo: {} },
      projects: { nodes: [], pageInfo: {} },
    };
    expect(findConnections(data)).toHaveLength(2);
  });

  test("a plain object with nodes but no pageInfo is not a connection", () => {
    expect(findConnections({ thing: { nodes: [] } })).toHaveLength(0);
  });
});

describe("lin api", () => {
  test("sends the document and prints data as raw JSON", async () => {
    await runApi(
      ["query Q { viewer { id } }"],
      {},
      [{ match: "Q", data: { viewer: { id: "u1" } } }],
      (output, stub) => {
        expect(stub.calls[0]?.document).toBe("query Q { viewer { id } }");
        expect(JSON.parse(output)).toEqual({ viewer: { id: "u1" } });
      },
    );
  });

  test("--var values reach the request as string variables", async () => {
    await runApi(
      ["query Q($id: String!) { issue(id: $id) { title } }"],
      { var: ["id=ENG-42"] },
      [{ match: "Q", data: { issue: { title: "Fix login redirect loop" } } }],
      (_output, stub) => {
        expect(stub.calls[0]?.variables).toEqual({ id: "ENG-42" });
      },
    );
  });

  test("--vars-json supplies typed variables and --var overrides them", async () => {
    await runApi(
      ["query Q($n: Int!, $id: String!) { issues(first: $n) { nodes { id } } }"],
      { "vars-json": '{"n":2,"id":"OLD"}', var: ["id=ENG-42"] },
      [{ match: "Q", data: { issues: { nodes: [] } } }],
      (_output, stub) => {
        expect(stub.calls[0]?.variables).toEqual({ n: 2, id: "ENG-42" });
      },
    );
  });

  test("--toon re-encodes the same data as TOON", async () => {
    await runApi(
      ["query Q { issues { nodes { id title } } }"],
      { toon: true },
      [
        {
          match: "Q",
          data: {
            issues: {
              nodes: [
                { id: "ENG-42", title: "Fix login redirect loop" },
                { id: "ENG-41", title: "Rotate webhook secrets, again" },
              ],
            },
          },
        },
      ],
      (output) => {
        expect(output).toBe(
          [
            "issues:",
            "  nodes[2]{id,title}:",
            "    ENG-42,Fix login redirect loop",
            '    ENG-41,"Rotate webhook secrets, again"',
            "",
          ].join("\n"),
        );
      },
    );
  });

  test("--paginate follows the cursor and concatenates nodes", async () => {
    await runApi(
      ["query Q($after: String) { issues(first: 1, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } }"],
      { paginate: true },
      [
        {
          match: "Q",
          data: { issues: { nodes: [{ id: "ENG-42" }], pageInfo: { hasNextPage: true, endCursor: "c1" } } },
        },
        {
          match: "Q",
          data: { issues: { nodes: [{ id: "ENG-41" }], pageInfo: { hasNextPage: true, endCursor: "c2" } } },
        },
        {
          match: "Q",
          data: { issues: { nodes: [{ id: "ENG-40" }], pageInfo: { hasNextPage: false, endCursor: "c3", startCursor: "s3" } } },
        },
      ],
      (output, stub) => {
        expect(stub.calls).toHaveLength(3);
        expect(stub.calls[1]?.variables).toEqual({ after: "c1" });
        expect(stub.calls[2]?.variables).toEqual({ after: "c2" });
        expect(JSON.parse(output).issues.nodes).toEqual([{ id: "ENG-42" }, { id: "ENG-41" }, { id: "ENG-40" }]);
        expect(JSON.parse(output).issues.pageInfo).toEqual({ hasNextPage: false, endCursor: "c3", startCursor: "s3" });
      },
    );
  });

  test("--paginate fails when hasNextPage has no cursor", async () => {
    await expect(
      runApi(
        ["query Q($after: String) { issues(first: 1, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } }"],
        { paginate: true },
        [
          {
            match: "Q",
            data: { issues: { nodes: [{ id: "ENG-42" }], pageInfo: { hasNextPage: true, endCursor: null } } },
          },
        ],
        () => {},
      ),
    ).rejects.toMatchObject({ exitCode: EXIT.api, message: "pagination cursor missing" });
  });

  test("--paginate fails when the cursor repeats", async () => {
    await expect(
      runApi(
        ["query Q($after: String) { issues(first: 1, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } }"],
        { paginate: true },
        [
          {
            match: "Q",
            data: { issues: { nodes: [{ id: "ENG-42" }], pageInfo: { hasNextPage: true, endCursor: "loop" } } },
          },
          {
            match: "Q",
            data: { issues: { nodes: [{ id: "ENG-41" }], pageInfo: { hasNextPage: true, endCursor: "loop" } } },
          },
        ],
        () => {},
      ),
    ).rejects.toMatchObject({ exitCode: EXIT.api, message: "pagination cursor repeated" });
  });

  test("--paginate fails at MAX_PAGES instead of stopping silently", async () => {
    const box = sandbox();
    const stub = mock(
      Array.from({ length: MAX_PAGES }, (_, index) => ({
        match: "Q",
        data: {
          issues: {
            nodes: [{ id: `ENG-${index}` }],
            pageInfo: { hasNextPage: true, endCursor: `c${index}` },
          },
        },
      })),
    );
    const captured = captureStdout();
    try {
      await expect(
        apiCommand.run({
          args: [
            "query Q($after: String) { issues(first: 1, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } }",
          ],
          flags: { paginate: true },
          config: { limit: 50 },
          command: apiCommand,
        }),
      ).rejects.toMatchObject({ exitCode: EXIT.api, message: "pagination exceeded maximum pages" });
      expect(stub.calls).toHaveLength(MAX_PAGES);
    } finally {
      captured.restore();
      stub.restore();
      box.cleanup();
    }
  });

  test("--paginate without $after names the fix instead of failing at the API", async () => {
    await expect(
      runApi(["query Q { issues { nodes { id } } }"], { paginate: true }, [], () => {}),
    ).rejects.toMatchObject({ exitCode: EXIT.input, hint: expect.stringContaining("$after") });
  });

  test("GraphQL errors are exit 1 and carry the raw payload as the correction", async () => {
    await expect(
      runApi(
        ["query Q { viewer { nope } }"],
        {},
        [{ match: "Q", status: 400, errors: [{ message: 'Cannot query field "nope" on type "User".' }] }],
        () => {},
      ),
    ).rejects.toMatchObject({
      exitCode: EXIT.api,
      message: 'Cannot query field "nope" on type "User".',
    });
  });

  test("an empty query is exit 2", async () => {
    await expect(runApi(["   "], {}, [], () => {})).rejects.toMatchObject({ exitCode: EXIT.input });
  });

  test("malformed --vars-json is exit 2 with an example", async () => {
    await expect(
      runApi(["query Q { viewer { id } }"], { "vars-json": "{not json" }, [], () => {}),
    ).rejects.toMatchObject({ exitCode: EXIT.input, hint: expect.stringContaining("--vars-json") });
  });
});
