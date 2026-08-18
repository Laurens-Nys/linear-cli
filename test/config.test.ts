import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_LIMIT, findGitRoot, loadConfigFiles, parseLimitInput, parseToml, resolveConfig } from "../src/config.ts";
import { EXIT, LinError } from "../src/out.ts";
import { sandbox } from "./harness.ts";

function expectLinError(run: () => unknown): LinError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(LinError);
    return error as LinError;
  }
  throw new Error("expected a LinError, but the call returned");
}

describe("the flat TOML parser", () => {
  test("reads quoted strings and numbers", () => {
    expect(parseToml('team = "ENG"\nlimit = 25')).toEqual({ team: "ENG", limit: 25 });
  });

  test("ignores comments and blank lines", () => {
    expect(parseToml('# a comment\n\nteam = "ENG"  # trailing\nlimit = 10')).toEqual({
      team: "ENG",
      limit: 10,
    });
  });

  test("keeps a # that lives inside a quoted string", () => {
    expect(parseToml('team = "#eb5757"')).toEqual({ team: "#eb5757" });
  });

  test("accepts single quotes and bare words", () => {
    expect(parseToml("team = 'DES'")).toEqual({ team: "DES" });
    expect(parseToml("team = ENG")).toEqual({ team: "ENG" });
  });

  test("throws on a malformed line without echoing its potentially sensitive text", () => {
    const error = expectLinError(() => parseToml('LINEAR_API_KEY secret\nteam = "ENG"', "/tmp/.lin.toml"));
    expect(error.exitCode).toBe(EXIT.input);
    expect(error.message).toContain("/tmp/.lin.toml:1");
    expect(error.message).toContain("malformed line");
    expect(error.message).not.toContain("secret");
    expect(error.hint).toContain("team = \"ENG\"");
  });

  test("throws on an empty key, an unterminated string, and a table header", () => {
    expect(expectLinError(() => parseToml("= 5")).message).toContain("malformed line");
    expect(expectLinError(() => parseToml('team = "oops')).message).toContain("unterminated string");
    expect(expectLinError(() => parseToml("[section]\nteam = \"ENG\"")).message).toContain(
      "tables are not supported",
    );
  });

  test("throws on an unknown key instead of ignoring it", () => {
    const error = expectLinError(() => parseToml('team = "ENG"\nwide = true', "/tmp/.lin.toml"));
    expect(error.exitCode).toBe(EXIT.input);
    expect(error.message).toContain("/tmp/.lin.toml:2");
    expect(error.message).toContain("unknown key wide");
    expect(error.hint).toBe("supported keys: team, limit");
  });

  test("throws when limit is not a number", () => {
    const error = expectLinError(() => parseToml("limit = true", "/tmp/.lin.toml"));
    expect(error.message).toContain("/tmp/.lin.toml:1");
    expect(error.message).toContain("limit needs a number, got true");
    expect(error.hint).toContain("--limit 20");
  });

  test("handles negative and fractional numbers", () => {
    expect(parseToml("limit = -3")).toEqual({ limit: -3 });
    expect(parseToml("limit = 2.5")).toEqual({ limit: 2.5 });
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

  test("an unparseable LIN_LIMIT is fatal with the same wording as --limit", () => {
    const box = sandbox();
    try {
      const error = expectLinError(() => resolveConfig({}, box.dir, { ...box.env, LIN_LIMIT: "many" }));
      expect(error.exitCode).toBe(EXIT.input);
      expect(error.message).toBe('LIN_LIMIT needs a number, got "many"');
      expect(error.hint).toBe("example: --limit 20");
      const flagError = expectLinError(() => parseLimitInput("many", "--limit"));
      expect(flagError.message).toBe('--limit needs a number, got "many"');
      expect(flagError.hint).toBe(error.hint);
    } finally {
      box.cleanup();
    }
  });

  test("an unknown key in a project file fails with the path instead of being skipped", () => {
    const box = withFiles();
    try {
      writeFileSync(join(box.project, ".lin.toml"), 'team = "ENG"\napi_key = "secret"\n');
      const error = expectLinError(() => resolveConfig({}, box.project, box.env));
      expect(error.exitCode).toBe(EXIT.input);
      expect(error.message).toContain(join(box.project, ".lin.toml"));
      expect(error.message).toContain("unknown key api_key");
      expect(error.message).not.toContain("secret");
    } finally {
      box.cleanup();
    }
  });

  test("an unreadable config file fails with its path", () => {
    const box = sandbox();
    try {
      const project = join(box.dir, "project");
      const path = join(project, ".lin.toml");
      mkdirSync(path, { recursive: true });
      const error = expectLinError(() => loadConfigFiles(project, box.env));
      expect(error.exitCode).toBe(EXIT.input);
      expect(error.message).toBe(`cannot read config ${path}`);
      expect(error.hint).toContain("readable file");
    } finally {
      box.cleanup();
    }
  });
});
