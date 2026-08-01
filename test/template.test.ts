import { describe, expect, test } from "bun:test";
import { toMeta, writeCached } from "../src/cache.ts";
import { keyFingerprint } from "../src/client.ts";
import { templateDataKeys, templateList, templateView } from "../src/commands/template.ts";
import { captureStdout, mock, sandbox, type RecordedCall } from "./harness.ts";
import { WARM_DATA } from "./fixtures.ts";

async function cli(
  responses: Parameters<typeof mock>[0],
  invoke: () => Promise<void> | void,
): Promise<{ calls: RecordedCall[]; output: string }> {
  const box = sandbox();
  writeCached(
    { ...toMeta(WARM_DATA, keyFingerprint(box.env)), fetchedAt: new Date().toISOString() },
    box.env,
  );
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

const TEMPLATES = {
  templates: [
    { id: "aaaa1111-2222-4333-8444-555566667777", name: "Bug report", type: "issue", team: { key: "ENG" } },
    { id: "bbbb1111-2222-4333-8444-555566667777", name: "Design brief", type: "issue", team: { key: "DES" } },
    { id: "cccc1111-2222-4333-8444-555566667777", name: "RFC", type: "document", team: null },
  ],
};

describe("template list", () => {
  test("lists every template in the workspace", async () => {
    const { calls, output } = await cli([{ match: "LinTemplateList", data: TEMPLATES }], () =>
      templateList.run({ args: [], flags: {}, config: { limit: 50 }, command: templateList }),
    );

    expect(calls[0]?.operation).toBe("LinTemplateList");
    expect(calls[0]?.variables).toBeUndefined();
    expect(output).toBe(
      [
        "templates[3]{id,name,type}:",
        "  aaaa1111-2222-4333-8444-555566667777,Bug report,issue",
        "  bbbb1111-2222-4333-8444-555566667777,Design brief,issue",
        "  cccc1111-2222-4333-8444-555566667777,RFC,document",
        "",
      ].join("\n"),
    );
  });

  test("a team scope keeps the team's templates and the workspace-wide ones", async () => {
    const { output } = await cli([{ match: "LinTemplateList", data: TEMPLATES }], () =>
      templateList.run({ args: [], flags: {}, config: { team: "ENG", limit: 50 }, command: templateList }),
    );

    expect(output).toBe(
      [
        "templates[2]{id,name,type}:",
        "  aaaa1111-2222-4333-8444-555566667777,Bug report,issue",
        "  cccc1111-2222-4333-8444-555566667777,RFC,document",
        "",
      ].join("\n"),
    );
  });
});

describe("template view", () => {
  test("summarises templateData by the fields it pre-fills", async () => {
    const { calls, output } = await cli(
      [
        {
          match: "LinTemplateView",
          data: {
            template: {
              id: "tpl-bug",
              name: "Bug report",
              type: "issue",
              description: "Report a defect",
              team: { key: "ENG" },
              templateData: {
                title: "",
                description: "## Steps\n",
                labelIds: ["lb-bug"],
                priority: 2,
              },
            },
          },
        },
      ],
      () =>
        templateView.run({
          args: ["bug report"],
          flags: {},
          config: { team: "ENG", limit: 50 },
          command: templateView,
        }),
    );

    expect(calls[0]?.operation).toBe("LinTemplateView");
    expect(calls[0]?.variables).toEqual({ id: "tpl-bug" });
    expect(output).toBe(
      [
        "id: tpl-bug",
        "name: Bug report",
        "type: issue",
        "team: ENG",
        "description: Report a defect",
        "fills[4]: description,labelIds,priority,title",
        "",
      ].join("\n"),
    );
  });
});

describe("templateDataKeys", () => {
  test("reads an object", () => {
    expect(templateDataKeys({ title: "", teamId: "x" })).toEqual(["teamId", "title"]);
  });

  test("reads the JSON-encoded string form the API documents", () => {
    expect(templateDataKeys('{"priority":2,"title":""}')).toEqual(["priority", "title"]);
  });

  test("gives up quietly on anything that is not an object", () => {
    expect(templateDataKeys("not json")).toBeUndefined();
    expect(templateDataKeys([1, 2])).toBeUndefined();
    expect(templateDataKeys(null)).toBeUndefined();
    expect(templateDataKeys({})).toBeUndefined();
  });
});
