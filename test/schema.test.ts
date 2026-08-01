import { describe, expect, test } from "bun:test";
import schemaCommand, { indexBlocks, loadSdl, search, stripDocstrings } from "../src/commands/schema.ts";
import { EXIT } from "../src/out.ts";
import type { Flags } from "../src/registry.ts";
import { captureStdout } from "./harness.ts";

const SAMPLE = [
  '"""',
  "An issue.",
  '"""',
  "type Issue implements Node {",
  '  """',
  "  The issue's identifier.",
  '  """',
  "  identifier: String!",
  "  labels(",
  '    """',
  "    A cursor.",
  '    """',
  "    after: String",
  "    first: Int",
  "  ): IssueLabelConnection!",
  "  title: String!",
  "}",
  "",
  "input IssueFilter {",
  "  identifier: StringComparator",
  "}",
  "",
  "scalar DateTime",
].join("\n");

async function runSchema(args: string[], flags: Flags, limit = 50): Promise<string> {
  const captured = captureStdout();
  try {
    await schemaCommand.run({ args, flags, config: { limit }, command: schemaCommand });
    return captured.text();
  } finally {
    captured.restore();
  }
}

describe("SDL indexing", () => {
  const lines = SAMPLE.split("\n");

  test("indexes every top-level declaration", () => {
    expect(indexBlocks(lines).map((block) => block.name)).toEqual(["Issue", "IssueFilter", "DateTime"]);
  });

  test("a block runs to its closing brace", () => {
    const issue = indexBlocks(lines)[0];
    expect(lines[issue?.start ?? 0]).toBe("type Issue implements Node {");
    expect(lines[issue?.end ?? 0]).toBe("}");
  });

  test("a single-line declaration starts and ends on the same line", () => {
    const dateTime = indexBlocks(lines)[2];
    expect(dateTime?.start).toBe(dateTime?.end);
  });

  test("stripDocstrings removes descriptions and keeps declarations", () => {
    expect(stripDocstrings(lines).filter((line) => line.includes('"""'))).toEqual([]);
    expect(stripDocstrings(lines)).toContain("  identifier: String!");
  });
});

describe("search", () => {
  const lines = SAMPLE.split("\n");
  const blocks = indexBlocks(lines);

  test("matches field names and reports them under their type header", () => {
    const { groups } = search(lines, blocks, /identifier/i, 50);
    expect(groups.map((group) => group.header)).toEqual([
      "type Issue implements Node {",
      "input IssueFilter {",
    ]);
    expect(groups[0]?.units).toEqual([["  identifier: String!"]]);
    expect(groups[1]?.units).toEqual([["  identifier: StringComparator"]]);
  });

  test("a matching type name alone yields a bare header", () => {
    const { groups } = search(lines, blocks, /^DateTime$/i, 50);
    expect(groups).toEqual([{ header: "scalar DateTime", units: [] }]);
  });

  test("a field's whole signature comes back without argument descriptions", () => {
    const { groups } = search(lines, blocks, /labels/i, 50);
    expect(groups[0]?.units[0]).toEqual(["  labels(", "    after: String", "    first: Int", "  ): IssueLabelConnection!"]);
  });

  test("matching is case-insensitive", () => {
    expect(search(lines, blocks, /TITLE/i, 50).groups[0]?.units).toEqual([["  title: String!"]]);
  });

  test("the limit caps results and reports the overflow", () => {
    const { groups, truncated } = search(lines, blocks, /identifier/i, 1);
    expect(groups[0]?.units).toHaveLength(1);
    expect(truncated).toBe(1);
  });

  test("descriptions never match, only declarations", () => {
    // "An issue." and "A cursor." live in docstrings and must be invisible.
    expect(search(lines, blocks, /A cursor/i, 50).groups).toEqual([]);
  });
});

describe("the pinned schema", () => {
  test("loads and contains the Linear root types", async () => {
    const sdl = await loadSdl();
    expect(sdl).toContain("type Query {");
    expect(sdl).toContain("type Mutation {");
    expect(sdl.length).toBeGreaterThan(1_000_000);
  });

  test("finds issueUpdate with its signature", async () => {
    const output = await runSchema(["issueUpdate"], {});
    expect(output).toContain("type Mutation {");
    expect(output).toContain("  issueUpdate(");
    expect(output).toContain("    input: IssueUpdateInput!");
    expect(output).toContain("  ): IssuePayload!");
    expect(output).not.toContain('"""');
  });

  test("--type prints one block without descriptions", async () => {
    const output = await runSchema([], { type: "WorkflowState" });
    expect(output.startsWith("type WorkflowState implements Node {")).toBe(true);
    expect(output).toContain("  type: String!");
    expect(output).toContain("  position: Float!");
    expect(output).not.toContain('"""');
    expect(output.trimEnd().endsWith("}")).toBe(true);
  });

  test("--type on an unknown name suggests near matches", async () => {
    await expect(runSchema([], { type: "WorkflowStat" })).rejects.toMatchObject({
      exitCode: EXIT.input,
      hint: expect.stringContaining("WorkflowState"),
    });
  });

  test("no pattern at all names the three ways to call it", async () => {
    await expect(runSchema([], {})).rejects.toMatchObject({
      exitCode: EXIT.input,
      hint: expect.stringContaining("--full"),
    });
  });

  test("a pattern matching nothing is exit 4", async () => {
    await expect(runSchema(["zzzznotathing"], {})).rejects.toMatchObject({ exitCode: EXIT.notFound });
  });

  test("an invalid regular expression is exit 2, not a crash", async () => {
    await expect(runSchema(["issueUpdate("], {})).rejects.toMatchObject({
      exitCode: EXIT.input,
      hint: expect.stringContaining("regular expressions"),
    });
  });

  test("the limit caps a broad search and prints the overflow comment", async () => {
    const output = await runSchema(["id"], {}, 5);
    expect(output).toContain("# ");
    expect(output).toContain("more · raise --limit");
  });
});
