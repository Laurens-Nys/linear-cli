// doc list / view / create / update.

import { describe, expect, test } from "bun:test";
import { toMeta, writeCached } from "../src/cache.ts";
import { keyFingerprint } from "../src/client.ts";
import { docCreate, docList, docUpdate, docView } from "../src/commands/doc.ts";
import type { Config } from "../src/config.ts";
import { EXIT, LinError } from "../src/out.ts";
import type { CommandSpec, Flags } from "../src/registry.ts";
import { WARM_DATA } from "./fixtures.ts";
import { captureStdout, mock, sandbox, type Mock, type MockResponse } from "./harness.ts";

interface Invocation {
  args?: string[];
  flags?: Flags;
  config?: Config;
}

async function run(
  command: CommandSpec,
  invocation: Invocation,
  responses: MockResponse[],
  check: (output: string, stub: Mock) => void,
): Promise<void> {
  const box = sandbox();
  writeCached(toMeta(WARM_DATA, keyFingerprint(box.env)), box.env);
  const stub = mock(responses);
  const captured = captureStdout();

  try {
    await command.run({
      args: invocation.args ?? [],
      flags: invocation.flags ?? {},
      config: invocation.config ?? { limit: 50 },
      command,
    });
    captured.restore();
    check(captured.text(), stub);
  } finally {
    captured.restore();
    stub.restore();
    box.cleanup();
  }
}

async function expectFailure(
  command: CommandSpec,
  invocation: Invocation,
  responses: MockResponse[],
): Promise<LinError> {
  const box = sandbox();
  writeCached(toMeta(WARM_DATA, keyFingerprint(box.env)), box.env);
  const stub = mock(responses);
  const captured = captureStdout();

  try {
    await command.run({
      args: invocation.args ?? [],
      flags: invocation.flags ?? {},
      config: invocation.config ?? { limit: 50 },
      command,
    });
    throw new Error("expected a LinError");
  } catch (error) {
    expect(error).toBeInstanceOf(LinError);
    return error as LinError;
  } finally {
    captured.restore();
    stub.restore();
    box.cleanup();
  }
}

const ONBOARDING = "cccccccc-3333-4333-8333-cccccccccccc";
const SLUG = "189b7e925950";

describe("doc list", () => {
  test("renders id, title, project and updated", async () => {
    await run(
      docList,
      {},
      [
        {
          match: "LinDocList",
          data: {
            documents: {
              nodes: [
                {
                  slugId: SLUG,
                  title: "Launch plan",
                  updatedAt: "2026-07-02T12:02:34.485Z",
                  project: { name: "Onboarding" },
                },
                { slugId: "204bb0b969a5", title: "Runbook", updatedAt: "2026-06-30T08:00:00.000Z", project: null },
              ],
            },
          },
        },
      ],
      (output, stub) => {
        expect(stub.calls[0]?.operation).toBe("LinDocList");
        expect(stub.calls[0]?.variables).toEqual({ filter: {}, first: 50, after: undefined });
        expect(output).toBe(
          "docs[2]{id,title,project,updated}:\n" +
            "  189b7e925950,Launch plan,Onboarding,2026-07-02\n" +
            "  204bb0b969a5,Runbook,,2026-06-30\n",
        );
      },
    );
  });

  test("--project narrows the filter to that project's id", async () => {
    await run(
      docList,
      { flags: { project: "Onboarding" } },
      [{ match: "LinDocList", data: { documents: { nodes: [] } } }],
      (output, stub) => {
        expect(stub.calls[0]?.variables).toEqual({
          filter: { project: { id: { eq: ONBOARDING } } },
          first: 50,
          after: undefined,
        });
        expect(output).toBe("docs[0]:\n");
      },
    );
  });
});

describe("doc view", () => {
  const DOCUMENT = {
    document: {
      slugId: SLUG,
      title: "Launch plan",
      content: "# Launch plan\n\nShip the beta on the 15th.",
      updatedAt: "2026-07-02T12:02:34.485Z",
      url: "https://linear.app/acme/document/launch-plan-189b7e925950",
      project: { name: "Onboarding" },
      initiative: null,
    },
  };

  test("a slug id goes straight to the document, content unclipped", async () => {
    await run(docView, { args: [SLUG] }, [{ match: "LinDocView", data: DOCUMENT }], (output, stub) => {
      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0]?.variables).toEqual({ id: SLUG });
      expect(output).toBe(
        [
          "id: 189b7e925950",
          "title: Launch plan",
          "project: Onboarding",
          "updated: 2026-07-02",
          "url: https://linear.app/acme/document/launch-plan-189b7e925950",
          "---",
          "# Launch plan",
          "",
          "Ship the beta on the 15th.",
          "---",
          "",
        ].join("\n"),
      );
    });
  });

  test("an exact title is resolved to a slug first", async () => {
    await run(
      docView,
      { args: ["Launch plan"] },
      [
        { match: "LinDocByTitle", data: { documents: { nodes: [{ slugId: SLUG }] } } },
        { match: "LinDocView", data: DOCUMENT },
      ],
      (_output, stub) => {
        expect(stub.calls.map((call) => call.operation)).toEqual(["LinDocByTitle", "LinDocView"]);
        expect(stub.calls[0]?.variables).toEqual({ title: "Launch plan" });
        expect(stub.calls[1]?.variables).toEqual({ id: SLUG });
      },
    );
  });

  test("an unknown title is exit 2 and names the command that lists them", async () => {
    const error = await expectFailure(docView, { args: ["Missing plan"] }, [
      { match: "LinDocByTitle", data: { documents: { nodes: [] } } },
    ]);
    expect(error.exitCode).toBe(EXIT.input);
    expect(error.message).toBe('no document "Missing plan"');
    expect(error.hint).toBe("run lin doc list to see the documents you can reach");
  });
});

describe("doc create", () => {
  test("title, body and project become one create input", async () => {
    await run(
      docCreate,
      { flags: { title: "Launch plan", body: "Ship the beta.", project: "Onboarding" } },
      [
        {
          match: "LinDocCreate",
          data: {
            documentCreate: {
              document: { slugId: SLUG, url: "https://linear.app/acme/document/launch-plan-189b7e925950" },
            },
          },
        },
      ],
      (output, stub) => {
        expect(stub.calls[0]?.variables).toEqual({
          input: { title: "Launch plan", content: "Ship the beta.", projectId: ONBOARDING },
        });
        expect(output).toBe(
          "created: 189b7e925950\nurl: https://linear.app/acme/document/launch-plan-189b7e925950\n",
        );
      },
    );
  });

  test("a missing title is exit 2 and names -t", async () => {
    const error = await expectFailure(docCreate, { flags: { body: "Ship it." } }, []);
    expect(error.exitCode).toBe(EXIT.input);
    expect(error.message).toBe("doc create needs a title");
    expect(error.hint).toBe('pass -t "Document title"');
  });
});

describe("doc update", () => {
  test("a body rewrite reports the character counts from the read-back", async () => {
    await run(
      docUpdate,
      { args: [SLUG], flags: { body: "Ship the beta on the 22nd." } },
      [
        {
          match: "LinDocBefore",
          data: {
            document: {
              title: "Launch plan",
              project: { name: "Onboarding" },
              initiative: null,
              content: "Ship the beta.",
            },
          },
        },
        {
          match: "LinDocUpdate",
          data: {
            documentUpdate: {
              document: {
                slugId: SLUG,
                title: "Launch plan",
                project: { name: "Onboarding" },
                initiative: null,
                content: "Ship the beta on the 22nd.",
              },
            },
          },
        },
      ],
      (output, stub) => {
        expect(stub.calls[0]?.variables).toEqual({ id: SLUG, withContent: true });
        expect(stub.calls[1]?.variables).toEqual({
          id: SLUG,
          input: { content: "Ship the beta on the 22nd." },
          withContent: true,
        });
        expect(output).toBe("189b7e925950:\n  content: 14 chars -> 26 chars\n");
      },
    );
  });

  test("no fields is exit 2 and lists the flags", async () => {
    const error = await expectFailure(docUpdate, { args: [SLUG] }, []);
    expect(error.exitCode).toBe(EXIT.input);
    expect(error.message).toBe("doc update needs at least one field");
  });
});
