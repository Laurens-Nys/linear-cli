import {
  BoxRenderable,
  createMarkdownCodeBlockRenderer,
  TextRenderable,
  type CliRenderer,
  type MarkdownCodeBlockRenderer,
  type MarkdownOptions,
} from "@opentui/core";
import { renderMermaidASCII } from "beautiful-mermaid";
import { sortTuiComments, type TuiComment, type TuiIssue, type TuiIssueDetail } from "./data.ts";
import { GROK_NIGHT as C } from "./theme.ts";

export type TuiDetailView = TuiIssueDetail | "loading" | { error: string };

const PRIORITIES = ["No priority", "Urgent", "High", "Medium", "Low"] as const;

// Width-aware padding ladder from pi-mermaid (beautiful-mermaid in the Pi TUI).
const ASCII_PRESETS = [
  { paddingX: 5, boxBorderPadding: 1 },
  { paddingX: 3, boxBorderPadding: 1 },
  { paddingX: 2, boxBorderPadding: 1 },
  { paddingX: 1, boxBorderPadding: 0 },
] as const;

interface AsciiVariant {
  ascii: string;
  maxWidth: number;
}

function date(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "";
}

function maxLineWidth(text: string): number {
  let max = 0;
  for (const line of text.split("\n")) {
    if (line.length > max) max = line.length;
  }
  return max;
}

function renderVariants(source: string): AsciiVariant[] {
  const variants: AsciiVariant[] = [];
  for (const preset of ASCII_PRESETS) {
    try {
      const ascii = renderMermaidASCII(source, { ...preset, colorMode: "none" }).trimEnd();
      if (ascii) variants.push({ ascii, maxWidth: maxLineWidth(ascii) });
    } catch {
      // Try a tighter preset; the caller falls back to a fenced code block if none work.
    }
  }
  return variants;
}

function selectMermaidAscii(variants: readonly AsciiVariant[], width: number): string {
  const fit = Math.max(1, width);
  return (variants.find((variant) => variant.maxWidth <= fit) ?? variants[variants.length - 1])!.ascii;
}

export function renderMermaidForWidth(source: string, width: number): string {
  const variants = renderVariants(source);
  if (variants.length === 0) throw new Error("mermaid render failed");
  return selectMermaidAscii(variants, width);
}

class MermaidAsciiRenderable extends TextRenderable {
  private readonly variants: AsciiVariant[];
  private applied = "";

  constructor(renderer: CliRenderer, source: string) {
    const variants = renderVariants(source);
    if (variants.length === 0) throw new Error("mermaid render failed");
    const initial = variants[0]!.ascii;
    super(renderer, {
      content: initial, width: "100%", wrapMode: "none", fg: C.text, selectable: true,
      height: initial.split("\n").length,
    });
    this.variants = variants;
    this.applied = initial;
  }

  protected override onResize(width: number, height: number): void {
    super.onResize(width, height);
    if (width < 1) return;
    const next = selectMermaidAscii(this.variants, width);
    if (next === this.applied) return;
    this.applied = next;
    this.height = next.split("\n").length;
    queueMicrotask(() => {
      if (!this.isDestroyed) this.content = next;
    });
  }
}

function mermaidFenceRenderer(renderer: CliRenderer): MarkdownCodeBlockRenderer {
  return (token, context) => {
    if (!token.text.trim()) return context.defaultRender();
    try {
      const diagram = new MermaidAsciiRenderable(renderer, token.text);
      const box = new BoxRenderable(renderer, { width: "100%", flexDirection: "column" });
      box.add(diagram);
      return box;
    } catch {
      return context.defaultRender();
    }
  };
}

export function issueMarkdownRenderNode(renderer: CliRenderer): MarkdownOptions["renderNode"] {
  return createMarkdownCodeBlockRenderer({ mermaid: mermaidFenceRenderer(renderer) });
}

function commentAuthor(comment: TuiComment): string {
  return comment.user?.displayName ?? comment.botActor?.name ?? "Unknown";
}

function commentsMarkdown(comments: readonly TuiComment[]): string {
  if (comments.length === 0) return "*No comments.*";
  return comments.map((comment) => [
    `**${commentAuthor(comment)}** · ${date(comment.createdAt)}`,
    "",
    comment.body.trim() || "*Empty comment.*",
  ].join("\n")).join("\n\n");
}

function isDetailError(detail: TuiDetailView | undefined): detail is { error: string } {
  return typeof detail === "object" && detail !== null && "error" in detail && !("description" in detail);
}

export function issueDetail(issue: TuiIssue | undefined, detail?: TuiDetailView): string {
  if (!issue) return "Select an issue to view its details.";
  const facts = [
    `**${issue.identifier}** · ${issue.state.name} · ${issue.team.name} (${issue.team.key})`,
    issue.project ? `Project: ${issue.project.name}` : "",
    `Priority: ${PRIORITIES[issue.priority] ?? "No priority"}`,
    issue.dueDate ? `Due: ${date(issue.dueDate)}` : "",
    `Updated: ${date(issue.updatedAt)}`,
    issue.labels.nodes.length ? `Labels: ${issue.labels.nodes.map((label) => label.name).join(", ")}` : "",
  ].filter(Boolean);
  let body: string;
  let comments: string[] = [];
  if (detail === "loading") {
    body = "Loading description…";
  } else if (isDetailError(detail)) {
    body = `Could not load description.\n\n${detail.error}\n\nPress r to retry.`;
  } else if (detail) {
    body = detail.description?.trim() || "*No description.*";
    comments = ["", "## Recent comments", "", commentsMarkdown(sortTuiComments(detail.comments))];
  } else {
    body = "*No description.*";
  }
  return [
    `# ${issue.title}`,
    "",
    facts.join("  \n"),
    "",
    "---",
    "",
    body,
    ...comments,
  ].join("\n");
}
