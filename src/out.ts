// The only module that prints. Commands never touch stdout/stderr directly.
//
// Output is TOON. `@toon-format/toon` owns structure, indentation and escaping;
// this module owns the four shapes in DESIGN.md and the few places where the
// encoder is more conservative than the spec requires (see `bareOk` below).

import { encode, rawString } from "@toon-format/toon";

/** Exit codes are a contract. See DESIGN.md. */
export const EXIT = {
  ok: 0,
  api: 1,
  input: 2,
  auth: 3,
  notFound: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Every failure is a LinError, and every LinError names the correction. */
export class LinError extends Error {
  readonly exitCode: ExitCode;
  readonly hint: string | undefined;

  constructor(exitCode: ExitCode, message: string, hint?: string) {
    super(message);
    this.name = "LinError";
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

// --- quiet mode -------------------------------------------------------------

let quiet = false;

/** `-q/--quiet`: receipts collapse to the bare identifier. */
export function setQuiet(value: boolean): void {
  quiet = value;
}

export function isQuiet(): boolean {
  return quiet;
}

// --- value formatting -------------------------------------------------------

const ISO_DATETIME = /^(\d{4}-\d{2}-\d{2})T[\d:.]+/;

/** Priority is an Int in Linear; agents read words. Index is the API value. */
export const PRIORITY_WORDS = ["none", "urgent", "high", "medium", "low"] as const;

export function priorityWord(value: number): string {
  return PRIORITY_WORDS[value] ?? String(value);
}

/** Inverse of `priorityWord`, for `--priority` flags on write commands. */
export function priorityNumber(word: string): number | undefined {
  const index = PRIORITY_WORDS.indexOf(word.toLowerCase() as (typeof PRIORITY_WORDS)[number]);
  return index === -1 ? undefined : index;
}

/** ISO timestamps and Dates render as YYYY-MM-DD. Anything else passes through. */
export function formatDate(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return ISO_DATETIME.exec(value)?.[1] ?? value;
}

/**
 * Collapse one API value to a printable scalar.
 * `field` is consulted only for the priority-number-to-word rule.
 */
function scalar(field: string, value: unknown): string | number | boolean {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return formatDate(value);
  if (typeof value === "number") return field === "priority" ? priorityWord(value) : value;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => scalar(field, item)).join(",");
  if (typeof value === "object") return JSON.stringify(value);
  return formatDate(String(value));
}

// A conservative allowlist of strings that are safe to emit without quotes.
// The encoder quotes anything containing `:` or `/`, which would put quotes
// around every URL we print; the TOON decoder accepts those bare, so we don't
// pay the tokens. Number-like and boolean-like strings stay quoted so they
// survive a round trip as strings. `test/out.test.ts` round-trips a nasty
// corpus through decode() to keep this honest.
const NUMBER_LIKE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const RESERVED = new Set(["true", "false", "null"]);
const UNSAFE_CHARS = /["\\,\n\r\t[\]{}]/;
const UNSAFE_START = /^[-#'|>&*!%@`:]/;

function bareOk(value: string): boolean {
  if (value === "") return true; // an empty table cell is genuinely empty
  if (value !== value.trim()) return false;
  if (UNSAFE_CHARS.test(value)) return false;
  if (UNSAFE_START.test(value)) return false;
  if (NUMBER_LIKE.test(value)) return false;
  return !RESERVED.has(value.toLowerCase());
}

/** Hand a value to the encoder, unquoted when that is safe. */
function toon(value: string | number | boolean): unknown {
  return typeof value === "string" && bareOk(value) ? rawString(value) : value;
}

// --- shape 1: tables --------------------------------------------------------

export interface MoreInfo {
  /** How many rows exist beyond the ones printed; absent when the connection reports no total. */
  count?: number | undefined;
  /** The exact command that fetches the next page. */
  command: string;
}

export interface TableOptions {
  more?: MoreInfo | undefined;
}

export type Row = Record<string, unknown>;

export function renderTable(
  key: string,
  rows: readonly Row[],
  columns: readonly string[],
  options: TableOptions = {},
): string {
  const parts: string[] = [];

  if (rows.length === 0) {
    // The encoder writes `key: []`; DESIGN.md pins `key[0]:`.
    parts.push(`${key}[0]:`);
  } else {
    const projected = rows.map((row) => {
      const cells: Record<string, unknown> = {};
      for (const column of columns) cells[column] = toon(scalar(column, row[column]));
      return cells;
    });
    parts.push(encode({ [key]: projected }));
  }

  if (options.more) {
    const count = options.more.count === undefined ? "" : `${options.more.count} `;
    parts.push(`# ${count}more \u00b7 ${options.more.command}`);
  }
  return parts.join("\n");
}

// --- shape 2: records -------------------------------------------------------

export interface RecordChild {
  key: string;
  rows: readonly Row[];
  columns: readonly string[];
}

export interface RecordOptions {
  /** Raw markdown, printed between `---` fences. Never TOON-escaped. */
  body?: string | undefined;
  children?: readonly RecordChild[] | undefined;
}

export function renderRecord(fields: Row, options: RecordOptions = {}): string {
  const head: Record<string, unknown> = {};

  for (const [field, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      head[field] = value.map((item) => toon(scalar(field, item)));
      continue;
    }
    const cell = scalar(field, value);
    if (cell === "") continue; // never print an empty field
    head[field] = toon(cell);
  }

  const parts: string[] = [];
  const encoded = encode(head);
  if (encoded) parts.push(encoded);

  const body = options.body?.trim();
  if (body) parts.push(`---\n${body}\n---`);

  for (const child of options.children ?? []) {
    parts.push(renderTable(child.key, child.rows, child.columns));
  }

  return parts.join("\n");
}

// --- shape 3: receipts ------------------------------------------------------

export interface Change {
  field: string;
  from: unknown;
  to: unknown;
}

export function renderCreated(identifier: string, url?: string): string {
  if (quiet) return identifier;
  const fields: Row = { created: identifier };
  if (url) fields["url"] = url;
  return renderRecord(fields);
}

/** `archived: ENG-42`, `deleted: ENG-42`, ... */
export function renderSimpleReceipt(label: string, identifier: string): string {
  if (quiet) return identifier;
  return renderRecord({ [label]: identifier });
}

export function renderChanged(identifier: string, changes: readonly Change[]): string {
  if (quiet) return identifier;
  if (changes.length === 0) return `${identifier}: unchanged`;

  const diffs: Record<string, unknown> = {};
  for (const change of changes) {
    const from = scalar(change.field, change.from) || "none";
    const to = scalar(change.field, change.to) || "none";
    diffs[change.field] = toon(`${from} -> ${to}`);
  }

  // The encoder quotes `ENG-42` as an object key because of the dash, and
  // rawString() is not accepted in key position; render the one header line by
  // hand and let the encoder own the indented value lines.
  const indented = encode(diffs)
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
  return `${identifier}:\n${indented}`;
}

// --- shape 4: errors --------------------------------------------------------

export function renderError(message: string, hint?: string): string {
  return hint ? `error: ${message}\n${hint}` : `error: ${message}`;
}

// --- writers ----------------------------------------------------------------

function write(text: string): void {
  if (text.length === 0) return;
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

export function table(
  key: string,
  rows: readonly Row[],
  columns: readonly string[],
  options?: TableOptions,
): void {
  write(renderTable(key, rows, columns, options));
}

export function record(fields: Row, options?: RecordOptions): void {
  write(renderRecord(fields, options));
}

export function created(identifier: string, url?: string): void {
  write(renderCreated(identifier, url));
}

export function simpleReceipt(label: string, identifier: string): void {
  write(renderSimpleReceipt(label, identifier));
}

export function changed(identifier: string, changes: readonly Change[]): void {
  write(renderChanged(identifier, changes));
}

/** A single unadorned line, e.g. `issue branch` / `issue url`. */
export function line(text: string): void {
  write(text);
}

/** Verbatim stdout, no trailing newline added: `api` JSON and `schema` dumps. */
export function raw(text: string): void {
  process.stdout.write(text);
}

/** Writes shape 4 to stderr and returns the exit code for main.ts to use. */
export function fail(exitCode: ExitCode, message: string, hint?: string): ExitCode {
  process.stderr.write(`${renderError(message, hint)}\n`);
  return exitCode;
}

export function failFrom(error: LinError): ExitCode {
  return fail(error.exitCode, error.message, error.hint);
}
