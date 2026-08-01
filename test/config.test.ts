import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_LIMIT, findGitRoot, loadConfigFiles, parseToml, resolveConfig } from "../src/config.ts";
import { sandbox } from "./harness.ts";

describe("the flat TOML parser", () => {
  test("reads quoted strings, numbers and booleans", () => {
    expect(parseToml('team = "ENG"\nlimit = 25\nwide = true')).toEqual({ team: "ENG", limit: 25, wide: true });
  });

  test("ignores comments, blank lines and table headers", () => {
    expect(parseToml('# a comment\n\nteam = "ENG"  # trailing\n[section]\nlimit = 10')).toEqual({
      team: "ENG",
      limit: 10,
    });
  });

  test("keeps a # that lives inside a quoted string", () => {
    expect(parseToml('color = "#eb5757"')).toEqual({ color: "#eb5757" });
  });

  test("accepts single quotes and bare words", () => {
    expect(parseToml("team = 'DES'\nsort = updated")).toEqual({ team: "DES", sort: "updated" });
  });

  test("skips malformed lines instead of throwing", () => {
    expect(parseToml('nonsense\n= 5\nteam = "ENG"\nunterminated = "oops')).toEqual({ team: "ENG" });
  });

  test("handles negative and fractional numbers", () => {
    expect(parseToml("a = -3\nb = 2.5")).toEqual({ a: -3, b: 2.5 });
  });
});

describe("config discovery", () => {
  test("finds the nearest git root above the working directory", () => {
    const box = sandbox();
    try {
      const root = join(box.dir, "repo");
      const nested = join(root, "src", "deep");
      mkdirSync(join(root, ".git"), { recursive: true });
      mkdirSync(nested, { recursive: true });
      expect(findGitRoot(nested)).toBe(root);
    } finally {
      box.cleanup();
    }
  });

  test("a project file beats the global file", () => {
    const box = sandbox();
    try {
      const globalDir = join(box.env["XDG_CONFIG_HOME"] as string, "lin");
      mkdirSync(globalDir, { recursive: true });
      writeFileSync(join(globalDir, "config.toml"), 'team = "GLOBAL"\nlimit = 10\n');

      const project = join(box.dir, "project");
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, ".lin.toml"), 'team = "ENG"\n');

      // team comes from the project file, limit falls back to the global one
      expect(loadConfigFiles(project, box.env)).toEqual({ team: "ENG", limit: 10 });
    } finally {
      box.cleanup();
    }
  });

  test("a file at the git root applies from a subdirectory", () => {
    const box = sandbox();
    try {
      const root = join(box.dir, "repo");
      const nested = join(root, "src");
      mkdirSync(join(root, ".git"), { recursive: true });
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(root, ".lin.toml"), 'team = "ROOT"\n');
      expect(loadConfigFiles(nested, box.env).team).toBe("ROOT");
    } finally {
      box.cleanup();
    }
  });
});

describe("precedence: flag > env > project > global", () => {
  function withFiles(): ReturnType<typeof sandbox> & { project: string } {
    const box = sandbox();
    const globalDir = join(box.env["XDG_CONFIG_HOME"] as string, "lin");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, "config.toml"), 'team = "GLOBAL"\nlimit = 10\n');
    const project = join(box.dir, "project");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, ".lin.toml"), 'team = "PROJECT"\nlimit = 20\n');
    return Object.assign(box, { project });
  }

  test("files alone: the project file wins", () => {
    const box = withFiles();
    try {
      expect(resolveConfig({}, box.project, box.env)).toEqual({ team: "PROJECT", limit: 20 });
    } finally {
      box.cleanup();
    }
  });

  test("env twins beat both files", () => {
    const box = withFiles();
    try {
      const env = { ...box.env, LIN_TEAM: "ENVTEAM", LIN_LIMIT: "30" };
      expect(resolveConfig({}, box.project, env)).toEqual({ team: "ENVTEAM", limit: 30 });
    } finally {
      box.cleanup();
    }
  });

  test("flags beat everything", () => {
    const box = withFiles();
    try {
      const env = { ...box.env, LIN_TEAM: "ENVTEAM", LIN_LIMIT: "30" };
      expect(resolveConfig({ team: "FLAG", limit: 5 }, box.project, env)).toEqual({ team: "FLAG", limit: 5 });
    } finally {
      box.cleanup();
    }
  });

  test("limit defaults to 50 when nothing sets it", () => {
    const box = sandbox();
    try {
      expect(resolveConfig({}, box.dir, box.env)).toEqual({ team: undefined, limit: DEFAULT_LIMIT });
    } finally {
      box.cleanup();
    }
  });

  test("an unparseable LIN_LIMIT is ignored rather than fatal", () => {
    const box = sandbox();
    try {
      expect(resolveConfig({}, box.dir, { ...box.env, LIN_LIMIT: "many" }).limit).toBe(DEFAULT_LIMIT);
    } finally {
      box.cleanup();
    }
  });
});
