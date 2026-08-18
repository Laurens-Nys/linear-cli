// Completion scripts are generated from whatever commands they are handed, so
// these tests hand them a synthetic registry and assert the generated words.

import { describe, expect, test } from "bun:test";
import completions, { renderCompletions, roots, SHELLS, verbs } from "../src/commands/completions.ts";
import { EXIT } from "../src/out.ts";
import { allCommands, type CommandSpec } from "../src/registry.ts";
import { captureStdout } from "./harness.ts";

const noop = (): void => {};

const WIDGET_LIST: CommandSpec = {
  name: "widget list",
  group: "widget",
  aliases: ["wl"],
  summary: "list widgets",
  flags: {
    mine: { type: "boolean", doc: "only widgets assigned to me" },
    label: { type: "repeatable", valueHint: "name", doc: "filter by label; repeat to AND" },
  },
  examples: ["lin widget list --mine"],
  run: noop,
};

const WIDGET_VIEW: CommandSpec = {
  name: "widget view",
  group: "widget",
  summary: "view one widget",
  args: [{ name: "ref", doc: "widget identifier", required: true }],
  examples: ["lin widget view WID-1"],
  run: noop,
};

const PING: CommandSpec = {
  name: "ping",
  group: "meta",
  // An apostrophe, because fish descriptions are single-quoted.
  summary: "show the key's identity",
  flags: { title: { type: "string", short: "t", valueHint: "text", doc: "the title" } },
  examples: ["lin ping"],
  run: noop,
};

const SYNTHETIC: CommandSpec[] = [WIDGET_VIEW, PING, WIDGET_LIST];

describe("the command surface", () => {
  test("roots are nouns, one-word commands and aliases", () => {
    expect(roots(SYNTHETIC).map((root) => root.word)).toEqual(["ping", "widget", "wl"]);
  });

  test("verbs are grouped under their noun, sorted", () => {
    expect([...verbs(SYNTHETIC)]).toEqual([
      [
        "widget",
        [
          { word: "list", doc: "list widgets" },
          { word: "view", doc: "view one widget" },
        ],
      ],
    ]);
  });
});

describe("bash", () => {
  const script = renderCompletions("bash", SYNTHETIC);

  test("registers the completion function", () => {
    expect(script).toContain("_lin() {");
    expect(script.trimEnd().endsWith("complete -F _lin lin")).toBe(true);
  });

  test("offers nouns, aliases and one-word commands in first position", () => {
    expect(script).toContain("words='ping widget wl'");
  });

  test("offers verbs under their noun", () => {
    expect(script).toContain("'widget') words='list view' ;;");
  });

  test("offers a command's own flags plus the globals", () => {
    expect(script).toContain("'widget list') words='--mine --label' ;;");
    expect(script).toContain("'ping') words='--title -t' ;;");
    expect(script).toContain('words="$words --limit -n --after --all-pages --fields --team --quiet -q');
    expect(script).toContain("--all-pages");
    expect(script).toContain("--fields");
  });
});

describe("zsh", () => {
  const script = renderCompletions("zsh", SYNTHETIC);

  test("is an autoloadable compdef file", () => {
    expect(script.startsWith("#compdef lin\n")).toBe(true);
    expect(script).toContain('if [ "${funcstack[1]}" = "_lin" ]; then');
  });

  test("completes roots, verbs and flags", () => {
    expect(script).toContain("compadd -- ping widget wl");
    expect(script).toContain("'widget') compadd -- list view ;;");
    expect(script).toContain("'widget list') compadd -- --mine --label ;;");
  });
});

describe("fish", () => {
  const script = renderCompletions("fish", SYNTHETIC);

  test("completes roots with their summaries", () => {
    expect(script).toContain("complete -c lin -f");
    expect(script).toContain("complete -c lin -n '__fish_use_subcommand' -a widget -d 'widget commands'");
    expect(script).toContain("complete -c lin -n '__fish_use_subcommand' -a wl -d 'list widgets'");
  });

  test("completes verbs only before another verb is typed", () => {
    expect(script).toContain(
      "complete -c lin -n '__fish_seen_subcommand_from widget; and not __fish_seen_subcommand_from list view' -a list -d 'list widgets'",
    );
  });

  test("scopes flags to their command and marks the ones taking a value", () => {
    expect(script).toContain(
      "complete -c lin -n '__fish_seen_subcommand_from widget; and __fish_seen_subcommand_from list' -l mine -d 'only widgets assigned to me'",
    );
    expect(script).toContain("-l label -r -d 'filter by label; repeat to AND'");
    expect(script).toContain("complete -c lin -n '__fish_seen_subcommand_from ping' -s t -l title -r");
  });

  test("escapes quotes in descriptions", () => {
    expect(script).toContain("-a ping -d 'show the key\\'s identity'");
  });

  test("declares the global flags once, unconditionally", () => {
    expect(script).toContain("complete -c lin -s n -l limit -r -d 'maximum rows to return, 1-250 (default 50)'");
    expect(script).toContain("-l all-pages");
    expect(script).toContain("-l fields");
  });
});

describe("lin completions", () => {
  test("every advertised shell generates a non-empty script for the live registry", () => {
    for (const shell of SHELLS) {
      const script = renderCompletions(shell, allCommands());
      expect(script.length).toBeGreaterThan(200);
      // Every registered command contributes its words, whichever they are.
      for (const command of allCommands()) {
        for (const word of command.name.split(" ")) expect(script).toContain(word);
      }
    }
  });

  test("prints the requested script", () => {
    const captured = captureStdout();
    try {
      completions.run({
        args: ["fish"],
        flags: {},
        config: { team: "ENG", limit: 50 },
        command: completions,
      });
      captured.restore();
      expect(captured.text()).toBe(renderCompletions("fish", allCommands()));
    } finally {
      captured.restore();
    }
  });

  test("an unknown shell is exit 2 and lists the ones that work", () => {
    try {
      completions.run({
        args: ["powershell"],
        flags: {},
        config: { team: "ENG", limit: 50 },
        command: completions,
      });
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as { exitCode: number }).exitCode).toBe(EXIT.input);
      expect((error as { message: string }).message).toBe('no completions for "powershell"');
      expect((error as { hint: string }).hint).toBe("shells: bash, zsh, fish");
    }
  });

  test("a missing shell says so", () => {
    try {
      completions.run({
        args: [],
        flags: {},
        config: { team: "ENG", limit: 50 },
        command: completions,
      });
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as { message: string }).message).toBe("no shell given");
    }
  });
});
