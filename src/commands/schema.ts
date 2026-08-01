// owned by: core agent
// Search the pinned Linear SDL. Bun embeds schema.graphql into the compiled
// binary via the import attribute below, so this works from source and from
// `dist/lin` alike.

import schemaPath from "../../schema.graphql" with { type: "file" };
import { EXIT, LinError, raw } from "../out.ts";
import { defineCommand, flagBool, flagString } from "../registry.ts";

const BLOCK_START = /^(?:type|input|enum|interface|union|scalar|directive|schema)\b/;
const BLOCK_NAME = /^(?:type|input|enum|interface|union|scalar)\s+(\w+)/;

export interface Block {
  name: string;
  /** Inclusive line indexes into the SDL. */
  start: number;
  end: number;
}

let cachedSdl: string | null = null;

export async function loadSdl(): Promise<string> {
  cachedSdl ??= await Bun.file(schemaPath).text();
  return cachedSdl;
}

/** Index every top-level declaration. Blocks close on a column-zero `}`. */
export function indexBlocks(lines: readonly string[]): Block[] {
  const blocks: Block[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (!BLOCK_START.test(line)) continue;

    let end = index;
    if (line.trimEnd().endsWith("{")) {
      for (let scan = index + 1; scan < lines.length; scan += 1) {
        if (lines[scan] === "}") {
          end = scan;
          break;
        }
      }
    }

    blocks.push({ name: BLOCK_NAME.exec(line)?.[1] ?? line.trim(), start: index, end });
    index = end;
  }

  return blocks;
}

/** Drop `"""` description blocks; they triple the size of a type for no gain. */
export function stripDocstrings(lines: readonly string[]): string[] {
  const kept: string[] = [];
  let inDoc = false;

  for (const line of lines) {
    const fences = (line.match(/"""/g) ?? []).length;
    if (inDoc) {
      if (fences > 0) inDoc = false;
      continue;
    }
    if (fences === 1) {
      inDoc = true;
      continue;
    }
    if (fences >= 2) continue; // single-line description
    kept.push(line);
  }

  return kept;
}

function compile(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "i");
  } catch (cause) {
    throw new LinError(
      EXIT.input,
      `"${pattern}" is not a valid pattern: ${cause instanceof Error ? cause.message : String(cause)}`,
      "patterns are case-insensitive regular expressions; escape ( ) [ ] to match them literally",
    );
  }
}

/**
 * A field plus its argument list, which the SDL spreads over many lines.
 * Argument descriptions are dropped; the signature is the useful part.
 * Returns the index after the unit.
 */
function fieldUnit(lines: readonly string[], start: number, limit: number): { text: string[]; next: number } {
  const first = lines[start] as string;
  if (!first.includes("(") || /\)\s*:/.test(first)) return { text: [first], next: start + 1 };

  const text: string[] = [first];
  for (let index = start + 1; index <= limit; index += 1) {
    const line = lines[index];
    if (line === undefined) break;
    text.push(line);
    if (/^\s*\)\s*:/.test(line)) return { text: stripDocstrings(text), next: index + 1 };
  }
  return { text: [first], next: start + 1 };
}

export interface SearchGroup {
  header: string;
  units: string[][];
}

export function search(lines: readonly string[], blocks: readonly Block[], pattern: RegExp, max: number): {
  groups: SearchGroup[];
  truncated: number;
} {
  const groups: SearchGroup[] = [];
  let total = 0;
  let truncated = 0;

  for (const block of blocks) {
    const header = lines[block.start] as string;
    const headerMatches = pattern.test(block.name);
    const units: string[][] = [];

    let index = block.start + 1;
    let inDoc = false;
    while (index <= block.end) {
      const line = lines[index] as string;
      const fences = (line.match(/"""/g) ?? []).length;

      if (inDoc) {
        if (fences > 0) inDoc = false;
        index += 1;
        continue;
      }
      if (fences === 1) {
        inDoc = true;
        index += 1;
        continue;
      }
      if (fences >= 2 || line.trim() === "") {
        index += 1;
        continue;
      }

      // Only field declarations, never argument lines inside a signature.
      if (/^ {2}\S/.test(line) && pattern.test(line)) {
        const unit = fieldUnit(lines, index, block.end);
        if (total < max) units.push(unit.text);
        else truncated += 1;
        total += 1;
        index = unit.next;
        continue;
      }
      index += 1;
    }

    if (units.length > 0 || headerMatches) groups.push({ header, units });
  }

  return { groups, truncated };
}

function renderGroups(groups: readonly SearchGroup[], truncated: number): string {
  const parts = groups.map((group) => [group.header, ...group.units.flat()].join("\n"));
  const body = parts.join("\n\n");
  return truncated > 0
    ? `${body}\n\n# ${truncated} more · raise --limit or narrow the pattern\n`
    : `${body}\n`;
}

export default defineCommand({
  name: "schema",
  group: "meta",
  summary: "search the pinned Linear GraphQL schema",
  args: [{ name: "pattern", doc: "case-insensitive regular expression" }],
  flags: {
    type: { type: "string", valueHint: "Name", doc: "print one type block in full" },
    full: { type: "boolean", doc: "dump the entire SDL" },
  },
  examples: [
    "lin schema issueUpdate",
    "lin schema --type IssueFilter",
    "lin schema 'labels?\\(' --limit 10",
  ],
  async run({ args, flags, config }) {
    const sdl = await loadSdl();

    if (flagBool(flags, "full")) {
      raw(sdl.endsWith("\n") ? sdl : `${sdl}\n`);
      return;
    }

    const lines = sdl.split("\n");
    const blocks = indexBlocks(lines);

    const typeName = flagString(flags, "type");
    if (typeName !== undefined) {
      const block = blocks.find((candidate) => candidate.name.toLowerCase() === typeName.toLowerCase());
      if (!block) {
        const near = blocks
          .filter((candidate) => candidate.name.toLowerCase().includes(typeName.toLowerCase()))
          .slice(0, 20)
          .map((candidate) => candidate.name);
        throw new LinError(
          EXIT.input,
          `no type "${typeName}" in the schema`,
          near.length > 0 ? `types: ${near.join(", ")}` : "run lin schema <pattern> to find one",
        );
      }
      raw(`${stripDocstrings(lines.slice(block.start, block.end + 1)).join("\n")}\n`);
      return;
    }

    const pattern = args[0];
    if (pattern === undefined || pattern === "") {
      throw new LinError(
        EXIT.input,
        "no pattern given",
        "pass a pattern, --type <Name>, or --full",
      );
    }

    const result = search(lines, blocks, compile(pattern), config.limit ?? 50);
    if (result.groups.length === 0) {
      throw new LinError(
        EXIT.notFound,
        `nothing in the schema matches "${pattern}"`,
        "patterns are case-insensitive regular expressions matched against type and field names",
      );
    }

    raw(renderGroups(result.groups, result.truncated));
  },
});
