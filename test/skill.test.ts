// The cheatsheet is rendered from whatever commands it is handed, so these
// tests hand it a synthetic registry: they stay green no matter which real
// commands exist, and they fail the moment the renderer stops being generic.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import skill, { renderSkill, synopsis } from "../src/commands/skill.ts";
import { EXIT } from "../src/out.ts";
import { allCommands, GLOBAL_FLAGS, type CommandSpec } from "../src/registry.ts";
import { captureStdout, sandbox } from "./harness.ts";

const noop = (): void => {};

const WIDGET_LIST: CommandSpec = {
  name: "widget list",
  group: "widget",
  aliases: ["wl"],
  summary: "list widgets",
  args: [{ name: "query", doc: "free text to match" }],
  flags: {
    mine: { type: "boolean", doc: "only widgets assigned to me" },
    label: { type: "repeatable", valueHint: "name", doc: "filter by label; repeat to AND" },
  },
  examples: ["lin widget list --mine", "lin widget list --label Bug"],
  run: noop,
};

const WIDGET_CREATE: CommandSpec = {
  name: "widget create",
  group: "widget",
  summary: "create a widget",
  flags: {
    title: { type: "string", short: "t", valueHint: "text", doc: "the title" },
    a: { type: "boolean", doc: "a" },
    b: { type: "boolean", doc: "b" },
    c: { type: "boolean", doc: "c" },
    d: { type: "boolean", doc: "d" },
    e: { type: "boolean", doc: "e" },
    f: { type: "boolean", doc: "f" },
    g: { type: "boolean", doc: "g" },
    h: { type: "boolean", doc: "h" },
  },
  examples: ["lin widget create -t Sprocket"],
  run: noop,
};

const GADGET_PING: CommandSpec = {
  name: "gadget ping",
  group: "gadget",
  summary: "ping the gadget service",
  examples: ["lin gadget ping"],
  run: noop,
};

const GADGET_VIEW: CommandSpec = {
  name: "gadget view",
  group: "gadget",
  summary: "view one gadget",
  args: [
    { name: "ref", doc: "gadget identifier", required: true },
    { name: "extra", doc: "more refs", variadic: true },
  ],
  examples: ["lin gadget view GAD-1"],
  run: noop,
};

const SYNTHETIC: CommandSpec[] = [WIDGET_CREATE, GADGET_VIEW, GADGET_PING, WIDGET_LIST];

describe("synopsis", () => {
  test("shows args by requirement and prefers short flag forms", () => {
    expect(synopsis(WIDGET_LIST)).toBe("lin widget list [query] [--mine --label name]");
    expect(synopsis(GADGET_VIEW)).toBe("lin gadget view <ref> [extra...]");
  });

  test("stops at six flags and defers the rest to -h", () => {
    expect(synopsis(WIDGET_CREATE)).toBe("lin widget create [-t text --a --b --c --d --e ...]");
  });
});

describe("renderSkill", () => {
  test("renders SKILL.md frontmatter and the output contract", () => {
    const text = renderSkill(SYNTHETIC);

    expect(text.startsWith("---\nname: linear\ndescription: ")).toBe(true);
    expect(text).toContain("\n---\n\n# lin - Linear for coding agents\n");
    expect(text).toContain("Exit codes: 0 ok, 1 API or network, 2 correctable input");
    expect(text).toContain("LINEAR_API_KEY");
    expect(text).toContain('`.lin.toml`');
    expect(text).toContain("`lin ENG-42` is `lin issue view ENG-42`");
    // The four shapes, one example each.
    for (const shape of ["issues[2]{id,title,state}:", "created: ENG-57", "state: Todo -> In Progress", "error: team ENG has no state"]) {
      expect(text).toContain(shape);
    }
    expect(text.endsWith("\n")).toBe(true);
  });

  test("the global flag table comes from the registry, every row of it", () => {
    const text = renderSkill(SYNTHETIC);
    expect(text).toContain("| global flag | meaning |\n|---|---|\n");
    for (const [name, spec] of Object.entries(GLOBAL_FLAGS)) {
      expect(text).toContain(`--${name}`);
      expect(text).toContain(`| ${spec.doc} |`);
    }
    expect(text).toContain("| `-n, --limit N` | maximum rows to return (default 50) |");
  });

  test("groups commands, one synopsis line and one example each", () => {
    const text = renderSkill(SYNTHETIC);
    const commandSections = text.slice(text.indexOf("## gadget"));

    expect(commandSections).toBe(
      [
        "## gadget",
        "",
        "```",
        // No second line: the only example would repeat the synopsis.
        "lin gadget ping - ping the gadget service",
        "lin gadget view <ref> [extra...] - view one gadget",
        "  lin gadget view GAD-1",
        "```",
        "",
        "## widget",
        "",
        "```",
        "lin widget create [-t text --a --b --c --d --e ...] - create a widget",
        "  lin widget create -t Sprocket",
        "lin widget list [query] [--mine --label name] - list widgets (alias: wl)",
        "  lin widget list --mine",
        "```",
        "",
      ].join("\n"),
    );
  });

  test("knows nothing but the commands it is given", () => {
    const text = renderSkill([GADGET_VIEW]);
    expect(text).toContain("lin gadget view");
    expect(text).not.toContain("widget");
    // Real commands only appear when the real registry is passed.
    expect(renderSkill(allCommands())).toContain("## meta");
  });

  test("stays compact: at most two lines per command", () => {
    const body = renderSkill(SYNTHETIC).split("## gadget")[1] as string;
    const lines = body.split("\n").filter((line) => line.trim().startsWith("lin "));
    expect(lines.length).toBeLessThanOrEqual(SYNTHETIC.length * 2);
    expect(body.split("\n").filter((line) => line.startsWith("lin ")).length).toBe(SYNTHETIC.length);
  });
});

describe("lin skill", () => {
  test("prints the cheatsheet for the live registry", () => {
    const captured = captureStdout();
    try {
      skill.run({ args: [], flags: {}, config: { team: "ENG", limit: 50 }, command: skill });
      captured.restore();
      expect(captured.text()).toBe(renderSkill(allCommands()));
    } finally {
      captured.restore();
    }
  });

  test("--install writes <dir>/SKILL.md, creating the directory, and prints the receipt", () => {
    const box = sandbox();
    const dir = join(box.dir, "agents", ".claude", "skills", "linear");
    const captured = captureStdout();

    try {
      skill.run({
        args: [],
        flags: { install: dir },
        config: { team: "ENG", limit: 50 },
        command: skill,
      });
      captured.restore();

      const path = join(dir, "SKILL.md");
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf8")).toBe(renderSkill(allCommands()));
      expect(captured.text()).toBe(`installed: ${path}\n`);
    } finally {
      captured.restore();
      box.cleanup();
    }
  });

  test("an unwritable install directory is exit 2 and names the correction", () => {
    const box = sandbox();
    try {
      // A file where the directory should be, so mkdir cannot proceed.
      const path = join(box.dir, "occupied");
      writeFileSync(path, "x", "utf8");

      try {
        skill.run({
          args: [],
          flags: { install: path },
          config: { team: "ENG", limit: 50 },
          command: skill,
        });
        throw new Error("expected a throw");
      } catch (error) {
        expect((error as { exitCode: number }).exitCode).toBe(EXIT.input);
        expect((error as { message: string }).message).toContain("cannot write");
        expect((error as { hint: string }).hint).toContain("--install <dir>");
      }
    } finally {
      box.cleanup();
    }
  });
});
