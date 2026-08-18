// The four output shapes, asserted as exact strings. These are the contract
// every command renders through; changing an expectation here is a breaking
// change to the CLI.

import { decode } from "@toon-format/toon";
import { afterEach, describe, expect, test } from "bun:test";
import {
  EXIT,
  formatDate,
  priorityNumber,
  priorityWord,
  renderChanged,
  renderCreated,
  renderError,
  renderRecord,
  renderSimpleReceipt,
  renderTable,
  resetFields,
  selectColumns,
  setFields,
  setQuiet,
  table,
} from "../src/out.ts";
import { ISSUE_ROWS } from "./fixtures.ts";
import { captureStdout } from "./harness.ts";

afterEach(() => {
  resetFields();
  setQuiet(false);
});

describe("shape 1 — tables", () => {
  test("renders the DESIGN.md table, quoting only where it must", () => {
    expect(renderTable("issues", ISSUE_ROWS, ["id", "title", "state", "priority", "updated"])).toBe(
      [
        "issues[3]{id,title,state,priority,updated}:",
        "  ENG-42,Fix login redirect loop,In Progress,high,2026-07-30",
        '  ENG-41,"Rotate webhook secrets, again",Todo,medium,2026-07-29',
        '  ENG-40,"Handle \\"quoted\\" titles",Todo,none,2026-07-28',
      ].join("\n"),
    );
  });

  test("a null cell is empty, not the word null", () => {
    expect(renderTable("issues", ISSUE_ROWS, ["id", "assignee", "state"])).toBe(
      ["issues[3]{id,assignee,state}:", "  ENG-42,casey,In Progress", "  ENG-41,alex,Todo", "  ENG-40,,Todo"].join(
        "\n",
      ),
    );
  });

  test("an empty result is a header line and nothing else", () => {
    expect(renderTable("issues", [], ["id", "title"])).toBe("issues[0]:");
  });

  test("more pages append the exact continuation command as a comment", () => {
    const rendered = renderTable("issues", ISSUE_ROWS.slice(0, 1), ["id", "title"], {
      more: { count: 11, command: "lin issue list --team ENG --after abc123" },
    });
    expect(rendered).toBe(
      ["issues[1]{id,title}:", "  ENG-42,Fix login redirect loop", "# 11 more · lin issue list --team ENG --after abc123"].join(
        "\n",
      ),
    );
  });

  test("columns project and order the output, ignoring extra row keys", () => {
    expect(renderTable("issues", [{ id: "ENG-1", title: "a", extra: "dropped" }], ["title", "id"])).toBe(
      ["issues[1]{title,id}:", "  a,ENG-1"].join("\n"),
    );
  });
});

describe("--fields projection", () => {
  const defaults = ["id", "title", "state"] as const;
  const extra = ["url", "parent"] as const;

  test("absent --fields keeps the default columns in order", () => {
    expect(selectColumns(defaults, extra)).toEqual(["id", "title", "state"]);
  });

  test("a comma-separated list selects and orders available fields", () => {
    expect(selectColumns(defaults, extra, "url,id,title")).toEqual(["url", "id", "title"]);
  });

  test("bare --fields lists the available fields and exits 2", () => {
    try {
      selectColumns(defaults, extra, true);
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toMatchObject({
        exitCode: EXIT.input,
        message: "--fields needs a column list",
        hint: "fields: id, title, state, url, parent",
      });
    }
  });

  test("unknown or empty --fields fail with the available list", () => {
    try {
      selectColumns(defaults, extra, "id,nope,also");
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toMatchObject({
        exitCode: EXIT.input,
        message: "unknown fields nope, also",
        hint: "fields: id, title, state, url, parent",
      });
    }
    try {
      selectColumns(defaults, extra, "  ,  ");
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as { message: string }).message).toBe("--fields needs a column list");
    }
  });

  test("table() applies --fields; renderTable and records do not", () => {
    setFields("title,id");
    const captured = captureStdout();
    try {
      table("issues", ISSUE_ROWS.slice(0, 1), ["id", "title", "state"]);
    } finally {
      captured.restore();
    }
    expect(captured.text()).toBe("issues[1]{title,id}:\n  Fix login redirect loop,ENG-42\n");
    expect(renderTable("issues", ISSUE_ROWS.slice(0, 1), ["id", "title", "state"])).toBe(
      "issues[1]{id,title,state}:\n  ENG-42,Fix login redirect loop,In Progress",
    );
    expect(renderCreated("ENG-42", "https://linear.app/acme/issue/ENG-42")).toBe(
      "created: ENG-42\nurl: https://linear.app/acme/issue/ENG-42",
    );
    expect(renderChanged("ENG-42", [{ field: "state", from: "Todo", to: "In Progress" }])).toContain(
      "state: Todo -> In Progress",
    );
    expect(renderRecord({ id: "ENG-42", title: "Fix login redirect loop" })).toBe(
      "id: ENG-42\ntitle: Fix login redirect loop",
    );
  });
});

describe("shape 2 — records", () => {
  test("renders the DESIGN.md record and omits empty fields entirely", () => {
    const rendered = renderRecord({
      id: "ENG-42",
      title: "Fix login redirect loop",
      state: "In Progress",
      assignee: "casey",
      priority: 2,
      team: "ENG",
      labels: ["Bug"],
      blocks: ["ENG-43"],
      description: null,
      estimate: undefined,
      milestone: "",
      tags: [],
      updated: "2026-07-30T09:15:00.000Z",
      url: "https://linear.app/acme/issue/ENG-42",
    });

    expect(rendered).toBe(
      [
        "id: ENG-42",
        "title: Fix login redirect loop",
        "state: In Progress",
        "assignee: casey",
        "priority: high",
        "team: ENG",
        "labels[1]: Bug",
        "blocks[1]: ENG-43",
        "updated: 2026-07-30",
        "url: https://linear.app/acme/issue/ENG-42",
      ].join("\n"),
    );
  });

  test("body rides between fences and sub-collections follow as tables", () => {
    const rendered = renderRecord(
      { id: "ENG-42", title: "Fix login redirect loop" },
      {
        body: "## Context\nUsers bounce between /login and /app.",
        children: [
          {
            key: "comments",
            rows: [
              {
                ref: "9f2ab41c",
                author: "casey",
                date: "2026-07-29T10:00:00.000Z",
                body: "Repro: stale cookie, then any deep link",
              },
              { ref: "1c0d88ee", author: "agent", date: "2026-07-30T10:00:00.000Z", body: "Fix pushed for review" },
            ],
            columns: ["ref", "author", "date", "body"],
          },
        ],
      },
    );

    expect(rendered).toBe(
      [
        "id: ENG-42",
        "title: Fix login redirect loop",
        "---",
        "## Context",
        "Users bounce between /login and /app.",
        "---",
        "comments[2]{ref,author,date,body}:",
        '  9f2ab41c,casey,2026-07-29,"Repro: stale cookie, then any deep link"',
        "  1c0d88ee,agent,2026-07-30,Fix pushed for review",
      ].join("\n"),
    );
  });
});

describe("shape 3 — receipts", () => {
  test("create receipts carry the identifier and url", () => {
    expect(renderCreated("ENG-57", "https://linear.app/acme/issue/ENG-57")).toBe(
      "created: ENG-57\nurl: https://linear.app/acme/issue/ENG-57",
    );
  });

  test("update receipts show only what changed, with none for empty", () => {
    expect(
      renderChanged("ENG-42", [
        { field: "state", from: "Todo", to: "In Progress" },
        { field: "assignee", from: null, to: "casey" },
        { field: "priority", from: 4, to: 1 },
      ]),
    ).toBe(["ENG-42:", "  state: Todo -> In Progress", "  assignee: none -> casey", "  priority: low -> urgent"].join("\n"));
  });

  test("a no-op update says so rather than printing an empty block", () => {
    expect(renderChanged("ENG-42", [])).toBe("ENG-42: unchanged");
  });

  test("a diff value needing quotes still gets them", () => {
    expect(renderChanged("ENG-42", [{ field: "title", from: "Old, thing", to: "New" }])).toBe(
      ['ENG-42:', '  title: "Old, thing -> New"'].join("\n"),
    );
  });

  test("archive and delete receipts are one line", () => {
    expect(renderSimpleReceipt("archived", "ENG-42")).toBe("archived: ENG-42");
  });

  test("quiet collapses every receipt to the bare identifier", () => {
    setQuiet(true);
    expect(renderCreated("ENG-57", "https://linear.app/acme/issue/ENG-57")).toBe("ENG-57");
    expect(renderChanged("ENG-42", [{ field: "state", from: "Todo", to: "Done" }])).toBe("ENG-42");
    expect(renderSimpleReceipt("archived", "ENG-42")).toBe("ENG-42");
    setQuiet(false);
  });
});

describe("shape 4 — errors", () => {
  test("names the correction on a second line", () => {
    expect(renderError('team ENG has no state "In Progress"', "states: Triage, Todo, Doing, In Review, Done, Canceled")).toBe(
      ['error: team ENG has no state "In Progress"', "states: Triage, Todo, Doing, In Review, Done, Canceled"].join("\n"),
    );
  });

  test("omits the second line when there is no correction", () => {
    expect(renderError("the Linear API returned no data")).toBe("error: the Linear API returned no data");
  });
});

describe("value rendering", () => {
  test("priority numbers render as words, both directions", () => {
    expect([0, 1, 2, 3, 4].map(priorityWord)).toEqual(["none", "urgent", "high", "medium", "low"]);
    expect(priorityNumber("urgent")).toBe(1);
    expect(priorityNumber("NONE")).toBe(0);
    expect(priorityNumber("nonsense")).toBeUndefined();
  });

  test("only the priority field is translated, other numbers pass through", () => {
    expect(renderRecord({ priority: 1, estimate: 3, sortOrder: 2 })).toBe("priority: urgent\nestimate: 3\nsortOrder: 2");
  });

  test("ISO timestamps collapse to YYYY-MM-DD", () => {
    expect(formatDate("2026-07-30T09:15:00.000Z")).toBe("2026-07-30");
    expect(formatDate("2026-07-30")).toBe("2026-07-30");
    expect(formatDate(new Date("2026-07-30T09:15:00.000Z"))).toBe("2026-07-30");
  });

  test("booleans stay unquoted", () => {
    expect(renderRecord({ active: true, archived: false })).toBe("active: true\narchived: false");
  });
});

describe("quoting stays lossless", () => {
  // out.ts emits some values bare that the encoder would quote (URLs above all).
  // These round trips are what keeps that shortcut honest.
  const nasty = [
    "https://linear.app/acme/issue/ENG-42",
    "Fix: the thing",
    "Todo -> In Progress",
    "group/label",
    "42",
    "3.14",
    "true",
    "null",
    "- leading dash",
    "#hash",
    "trailing space ",
    " leading space",
    'quote " inside',
    "comma, inside",
    "brackets [x] {y}",
    "back\\slash",
    "café · naïve",
    "",
  ];

  test("every value survives encode then decode as a record field", () => {
    for (const value of nasty) {
      const rendered = renderRecord({ v: value });
      if (value === "") {
        expect(rendered).toBe(""); // empty fields are omitted, never printed
        continue;
      }
      expect(decode(rendered)).toEqual({ v: value });
    }
  });

  test("every value survives encode then decode as a table cell", () => {
    for (const value of nasty) {
      const rendered = renderTable("rows", [{ a: "x", v: value }], ["a", "v"]);
      expect(decode(rendered)).toEqual({ rows: [{ a: "x", v: value }] });
    }
  });
});
