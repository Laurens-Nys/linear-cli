import { describe, expect, test } from "bun:test";
import { parseArgs, renderCommandHelp, renderGlobalHelp, renderGroupHelp, run, VERSION } from "../src/main.ts";
import { EXIT, selectColumns } from "../src/out.ts";
import { allCommands, getCommand, GLOBAL_FLAGS, type FlagSpec } from "../src/registry.ts";
import { captureStdout, mock, sandbox } from "./harness.ts";

const SPECS: Record<string, FlagSpec> = {
  ...GLOBAL_FLAGS,
  title: { type: "string", short: "t", valueHint: "text", doc: "the title" },
  label: { type: "repeatable", valueHint: "name", doc: "a label; repeat for more" },
  estimate: { type: "number", valueHint: "N", doc: "points" },
  mine: { type: "boolean", doc: "only my issues" },
};

describe("flag parsing", () => {
  test("separates positionals from flags", () => {
    expect(parseArgs(["ENG-42", "--mine"], SPECS)).toEqual({ args: ["ENG-42"], flags: { mine: true } });
  });

  test("takes a value from the next token or from an equals sign", () => {
    expect(parseArgs(["--title", "Fix login"], SPECS).flags["title"]).toBe("Fix login");
    expect(parseArgs(["--title=Fix login"], SPECS).flags["title"]).toBe("Fix login");
  });

  test("resolves short forms", () => {
    expect(parseArgs(["-t", "Fix"], SPECS).flags["title"]).toBe("Fix");
    expect(parseArgs(["-n", "20"], SPECS).flags["limit"]).toBe(20);
    expect(parseArgs(["-q"], SPECS).flags["quiet"]).toBe(true);
  });

  test("repeatable flags collect into an array", () => {
    expect(parseArgs(["--label", "Bug", "--label", "P0"], SPECS).flags["label"]).toEqual(["Bug", "P0"]);
  });

  test("number flags are parsed, and a non-number is exit 2", () => {
    expect(parseArgs(["--estimate", "3"], SPECS).flags["estimate"]).toBe(3);
    expect(() => parseArgs(["--estimate", "big"], SPECS)).toThrow(/needs a number/);
    expect(() => parseArgs(["--limit", "many"], SPECS)).toThrow(/--limit needs a number, got "many"/);
  });

  test("an unknown flag is exit 2 and lists the valid ones", () => {
    try {
      parseArgs(["--nope"], SPECS);
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as { exitCode: number }).exitCode).toBe(EXIT.input);
      expect((error as { hint: string }).hint).toContain("--title");
    }
  });

  test("a flag missing its value reports that, rather than eating the next flag", () => {
    try {
      parseArgs(["--title", "--mine"], SPECS);
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as { message: string }).message).toBe("--title needs a value");
    }
  });

  test("a value that merely looks like a flag is still consumed", () => {
    // Cursors are opaque and may start with a dash; only known flags stop consumption.
    expect(parseArgs(["--after", "-Nzc5"], SPECS).flags["after"]).toBe("-Nzc5");
  });

  test("a bareOk flag may stand alone or take a value", () => {
    expect(parseArgs(["--fields"], SPECS).flags["fields"]).toBe(true);
    expect(parseArgs(["--fields", "id,title"], SPECS).flags["fields"]).toBe("id,title");
    expect(parseArgs(["--all-pages"], SPECS).flags["all-pages"]).toBe(true);
  });

  test("--all is not a global flag", () => {
    expect(() => parseArgs(["--all"], SPECS)).toThrow(/unknown flag --all/);
  });

  test("-- ends flag parsing", () => {
    expect(parseArgs(["--mine", "--", "--not-a-flag"], SPECS)).toEqual({
      args: ["--not-a-flag"],
      flags: { mine: true },
    });
  });

  test("a lone dash is a positional, the stdin convention", () => {
    expect(parseArgs(["-"], SPECS).args).toEqual(["-"]);
  });

  test("--flag=false turns a boolean off", () => {
    expect(parseArgs(["--mine=false"], SPECS).flags["mine"]).toBe(false);
  });
});

describe("dispatch", () => {
  test("--version prints the package version", async () => {
    const captured = captureStdout();
    const code = await run(["--version"]);
    captured.restore();
    expect(code).toBe(EXIT.ok);
    expect(captured.text().trim()).toBe(VERSION);
  });

  test("no arguments print the global help and exit 0", async () => {
    const captured = captureStdout();
    const code = await run([]);
    captured.restore();
    expect(code).toBe(EXIT.ok);
    expect(captured.text()).toContain("usage: lin <noun> <verb>");
  });

  test("a two-word command wins over the one-word command it starts with", async () => {
    const captured = captureStdout();
    await run(["cache", "warm", "-h"]);
    captured.restore();
    expect(captured.text()).toContain("lin cache warm —");
  });

  test("a one-word command that shares a group name still shows its own help", async () => {
    const captured = captureStdout();
    const code = await run(["comment", "--help"]);
    captured.restore();
    expect(code).toBe(EXIT.ok);
    const help = captured.text();
    expect(help).toContain("lin comment — list an issue's comments");
    expect(help).toContain("usage: lin comment <issue>");
    expect(help).not.toContain("comment add");
  });

  test("-h on a command shows its own flags and examples", async () => {
    const captured = captureStdout();
    await run(["schema", "-h"]);
    captured.restore();
    const help = captured.text();
    expect(help).toContain("lin schema —");
    expect(help).toContain("--type Name");
    expect(help).toContain("lin schema issueUpdate");
  });

  test("a noun with -h lists that noun's commands", async () => {
    for (const flag of ["-h", "--help"] as const) {
      const captured = captureStdout();
      const code = await run(["issue", flag]);
      captured.restore();
      expect(code).toBe(EXIT.ok);
      const help = captured.text();
      expect(help).toContain("lin issue");
      expect(help).toContain("issue list");
      expect(help).toContain("issue view");
      expect(help).toContain("issue create");
      expect(help).toContain("react");
      expect(help).not.toContain("project list");
    }
  });

  test("a bare noun prints the same group help", async () => {
    const captured = captureStdout();
    const code = await run(["project"]);
    captured.restore();
    expect(code).toBe(EXIT.ok);
    expect(captured.text()).toBe(renderGroupHelp("project") + "\n");
  });

  test("an unknown verb under a known noun lists that noun's commands", async () => {
    await expect(run(["issue", "frobnicate"])).rejects.toMatchObject({
      exitCode: EXIT.input,
      hint: expect.stringContaining("issue list"),
    });
  });

  test("a bare identifier routes to issue view", async () => {
    // The mock proves dispatch without touching the network: the view query
    // fires for the identifier and nothing else runs.
    const box = sandbox();
    const m = mock([{ match: "LinIssueView", errors: [{ message: "Entity not found" }] }]);
    const captured = captureStdout();
    try {
      await expect(run(["ENG-42"])).rejects.toMatchObject({ exitCode: EXIT.notFound });
    } finally {
      captured.restore();
      m.restore();
      box.cleanup();
    }
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]?.operation).toBe("LinIssueView");
    expect(JSON.stringify(m.calls[0]?.variables)).toContain("ENG-42");
  });

  test("an issue URL routes the same way", async () => {
    const box = sandbox();
    const m = mock([{ match: "LinIssueView", errors: [{ message: "Entity not found" }] }]);
    const captured = captureStdout();
    try {
      await expect(run(["https://linear.app/acme/issue/ENG-42/fix-login"])).rejects.toMatchObject({
        exitCode: EXIT.notFound,
      });
    } finally {
      captured.restore();
      m.restore();
      box.cleanup();
    }
    expect(m.calls[0]?.operation).toBe("LinIssueView");
    expect(JSON.stringify(m.calls[0]?.variables)).toContain("ENG-42");
  });

  test("an unknown command is exit 2 and suggests real ones", async () => {
    await expect(run(["frobnicate"])).rejects.toMatchObject({
      exitCode: EXIT.input,
      hint: expect.stringContaining("auth"),
    });
  });

  test("--all is unknown on issue list; pagination is --all-pages", async () => {
    await expect(run(["issue", "list", "--all"])).rejects.toMatchObject({
      exitCode: EXIT.input,
      message: "unknown flag --all",
      hint: expect.stringContaining("--all-pages"),
    });
  });

  test("only declared commands accept --all-pages and --fields", () => {
    expect(allCommands().filter((command) => command.allPages).map((command) => command.name)).toEqual([
      "comment",
      "issue list",
      "ls",
      "search",
      "triage",
    ]);
    expect(allCommands().filter((command) => command.fields !== undefined).map((command) => command.name)).toEqual([
      "comment",
      "customer list",
      "cycle list",
      "doc list",
      "doctor",
      "inbox",
      "initiative list",
      "initiative posts",
      "issue list",
      "label list",
      "ls",
      "milestone list",
      "need list",
      "project list",
      "project posts",
      "search",
      "team list",
      "team states",
      "template list",
      "triage",
      "user list",
    ]);
  });

  test("--all-pages on a non-list command fails before the network", async () => {
    const box = sandbox();
    const stub = mock([]);
    try {
      await expect(run(["issue", "view", "ENG-42", "--all-pages"])).rejects.toMatchObject({
        exitCode: EXIT.input,
        message: "--all-pages is not supported on issue view",
        hint: expect.stringContaining("issue list"),
      });
      expect(stub.calls).toHaveLength(0);
    } finally {
      stub.restore();
      box.cleanup();
    }
  });

  test("--fields on raw output fails before the network", async () => {
    const box = sandbox();
    const stub = mock([]);
    try {
      await expect(run(["api", "query { viewer { id } }", "--fields", "id"])).rejects.toMatchObject({
        exitCode: EXIT.input,
        message: "--fields is not supported on api",
      });
      expect(stub.calls).toHaveLength(0);
    } finally {
      stub.restore();
      box.cleanup();
    }
  });

  test("--fields on a record command fails before the network", async () => {
    const box = sandbox();
    const stub = mock([]);
    try {
      await expect(run(["issue", "view", "ENG-42", "--fields", "id"])).rejects.toMatchObject({
        exitCode: EXIT.input,
        message: "--fields is not supported on issue view",
        hint: expect.stringContaining("issue list"),
      });
      expect(stub.calls).toHaveLength(0);
    } finally {
      stub.restore();
      box.cleanup();
    }
  });

  test("bare --fields on issue list validates before any page walk", async () => {
    const box = sandbox();
    const stub = mock([]);
    try {
      await expect(run(["issue", "list", "--team", "ENG", "--fields", "--all-pages"])).rejects.toMatchObject({
        exitCode: EXIT.input,
        message: "--fields needs a column list",
        hint: expect.stringContaining("blockers"),
      });
      expect(stub.calls).toHaveLength(0);
    } finally {
      stub.restore();
      box.cleanup();
    }
  });

  test("invalid --fields on issue list validates before any page walk", async () => {
    const box = sandbox();
    const stub = mock([]);
    try {
      await expect(run(["issue", "list", "--team", "ENG", "--fields", "nope", "--all-pages"])).rejects.toMatchObject({
        exitCode: EXIT.input,
        message: "unknown field nope",
      });
      expect(stub.calls).toHaveLength(0);
    } finally {
      stub.restore();
      box.cleanup();
    }
  });

  test("--mine --fields assignee is rejected before the network", async () => {
    const box = sandbox();
    const stub = mock([]);
    try {
      await expect(run(["issue", "list", "--mine", "--fields", "assignee"])).rejects.toMatchObject({
        exitCode: EXIT.input,
        message: "unknown field assignee",
        hint: "fields: id, title, state, priority, updated, parent, project, labels, blockers, url",
      });
      expect(stub.calls).toHaveLength(0);
    } finally {
      stub.restore();
      box.cleanup();
    }
  });

  test("inbox --all is still the local include-read flag", async () => {
    const box = sandbox();
    const stub = mock([
      {
        match: "LinInbox",
        data: { notifications: { nodes: [] } },
      },
    ]);
    const captured = captureStdout();
    try {
      const code = await run(["inbox", "--all"]);
      expect(code).toBe(EXIT.ok);
      expect(stub.calls).toHaveLength(1);
    } finally {
      captured.restore();
      stub.restore();
      box.cleanup();
    }
  });

  test("fields state resets when config resolution throws", async () => {
    const box = sandbox({ LIN_LIMIT: "nope" });
    try {
      await expect(run(["ls", "--fields", "id"])).rejects.toMatchObject({
        exitCode: EXIT.input,
        message: expect.stringMatching(/LIN_LIMIT/),
      });
    } finally {
      box.cleanup();
    }

    expect(selectColumns(["id", "title"])).toEqual(["id", "title"]);

    const again = sandbox();
    const stub = mock([
      { match: "LinIssueList", data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } },
    ]);
    const captured = captureStdout();
    try {
      const code = await run(["ls"]);
      expect(code).toBe(EXIT.ok);
      expect(captured.text()).toBe("issues[0]:\n");
    } finally {
      captured.restore();
      stub.restore();
      again.cleanup();
    }
  });
});

describe("help rendering comes from the registry", () => {
  test("the global help lists every registered command with its summary", () => {
    const help = renderGlobalHelp();
    for (const name of ["api", "auth", "cache", "cache clear", "cache warm", "doctor", "schema"]) {
      expect(help).toContain(name);
    }
    expect(help).toContain("--all-pages");
    expect(help).toContain("--fields");
    expect(help).not.toMatch(/--all[^-]/);
    expect(help).toContain("lin ENG-42 is shorthand for lin issue view ENG-42");
  });

  test("command help is built from the spec, so docs cannot drift", () => {
    const command = getCommand("api");
    expect(command).toBeDefined();
    const help = renderCommandHelp(command as NonNullable<typeof command>);
    expect(help).toContain("lin api — run a raw GraphQL query");
    expect(help).toContain("--vars-json json");
    expect(help).toContain("--paginate");
    for (const example of (command as NonNullable<typeof command>).examples) {
      expect(help).toContain(example);
    }
  });

  test("group help lists every command in that noun", async () => {
    const { commandsInGroup } = await import("../src/registry.ts");
    const help = renderGroupHelp("issue");
    expect(help).toContain("usage: lin issue <verb>");
    for (const command of commandsInGroup("issue")) {
      expect(help).toContain(command.name);
      expect(help).toContain(command.summary);
    }
    expect(help).not.toContain("project list");
  });

  test("every registered command carries a summary and at least one example", async () => {
    const { allCommands } = await import("../src/registry.ts");
    for (const command of allCommands()) {
      expect(command.summary.length).toBeGreaterThan(0);
      expect(command.examples.length).toBeGreaterThan(0);
      expect(command.examples.every((example) => example.startsWith("lin "))).toBe(true);
    }
  });
});
