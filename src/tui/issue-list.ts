import {
  BoxRenderable,
  type CliRenderer,
  fg,
  type KeyEvent,
  RenderableEvents,
  ScrollBoxRenderable,
  type SelectOption,
  t,
  TextRenderable,
} from "@opentui/core";
import type { TuiIssue, TuiWorkflowStateType } from "./data.ts";
import { GROK_NIGHT as C } from "./theme.ts";

export type TuiGroupMode = "status" | "none";

export interface StatusPresentation {
  glyph: string;
  group: string;
  fallbackColor: string;
}

const STATUS_PRESENTATION: Record<TuiWorkflowStateType, StatusPresentation> = {
  started: { glyph: "◐", group: "IN PROGRESS", fallbackColor: C.yellow },
  unstarted: { glyph: "○", group: "TODO", fallbackColor: C.secondary },
  backlog: { glyph: "◍", group: "BACKLOG", fallbackColor: C.muted },
  triage: { glyph: "◌", group: "TRIAGE", fallbackColor: C.teal },
  completed: { glyph: "✓", group: "COMPLETED", fallbackColor: C.green },
  canceled: { glyph: "×", group: "CANCELED", fallbackColor: C.red },
  duplicate: { glyph: "×", group: "DUPLICATE", fallbackColor: C.muted },
};

const STATUS_ORDER: TuiWorkflowStateType[] = [
  "started", "unstarted", "backlog", "triage", "completed", "canceled", "duplicate",
];

export function statusPresentation(type: TuiWorkflowStateType): StatusPresentation {
  return STATUS_PRESENTATION[type];
}

export function groupIssuesByStatus(issues: readonly TuiIssue[]): { type: TuiWorkflowStateType; issues: TuiIssue[] }[] {
  return STATUS_ORDER.map((type) => ({ type, issues: issues.filter((issue) => issue.state.type === type) }))
    .filter((group) => group.issues.length > 0);
}

function date(value: string): string {
  return value.slice(0, 10);
}

export const IssueListEvents = {
  SELECTION_CHANGED: "issueSelectionChanged",
} as const;

export class IssueListRenderable extends ScrollBoxRenderable {
  private issues: TuiIssue[] = [];
  private selectedIndex = 0;
  private readonly issueRows = new Map<number, BoxRenderable>();

  constructor(renderer: CliRenderer) {
    super(renderer, {
      id: "tui-list", width: "42%", height: "100%", backgroundColor: C.panel,
      scrollY: true, focusable: true, viewportCulling: true,
      verticalScrollbarOptions: { showArrows: false },
    });
    this.onMouseScroll = (event) => {
      if (event.scroll?.direction === "up") this.moveUp();
      if (event.scroll?.direction === "down") this.moveDown();
      this.focus();
      event.preventDefault();
    };
    this.onMouseOver = () => renderer.setMousePointer("pointer");
    this.onMouseOut = () => renderer.setMousePointer("default");
    this.on(RenderableEvents.FOCUSED, () => this.updateSelectionFill());
    this.on(RenderableEvents.BLURRED, () => this.updateSelectionFill());
  }

  get options(): SelectOption[] {
    return this.issues.map((issue) => ({
      name: `${issue.identifier}  ${issue.title}`,
      description: `${issue.state.name}  ·  updated ${date(issue.updatedAt)}`,
      value: issue,
    }));
  }

  setIssues(issues: readonly TuiIssue[], groupMode: TuiGroupMode, selectedIdentifier?: string): void {
    for (const child of [...this.getChildren()]) child.destroyRecursively();
    this.issueRows.clear();
    const groups = groupIssuesByStatus(issues);
    this.issues = groupMode === "status" ? groups.flatMap((group) => group.issues) : [...issues];
    const selected = selectedIdentifier
      ? this.issues.findIndex((issue) => issue.identifier === selectedIdentifier)
      : 0;
    this.selectedIndex = Math.max(0, selected);

    if (groupMode === "status") {
      let index = 0;
      for (const group of groups) {
        const presentation = statusPresentation(group.type);
        const heading = new TextRenderable(this.ctx, {
          id: `tui-status-group-${group.type}`, width: "100%", height: 1,
          content: `${presentation.group} · ${group.issues.length}`, fg: C.secondary, selectable: false,
          onMouseDown: (event) => { this.focus(); event.preventDefault(); },
        });
        this.add(heading);
        for (const issue of group.issues) this.addIssueRow(issue, index++);
      }
    } else {
      for (const [index, issue] of this.issues.entries()) this.addIssueRow(issue, index);
    }

    this.scrollTo(0);
    this.updateSelectionFill();
    queueMicrotask(() => this.scrollSelectedIntoView());
  }

  getSelectedIndex(): number {
    return this.selectedIndex;
  }

  getSelectedIssue(): TuiIssue | undefined {
    return this.issues[this.selectedIndex];
  }

  getSelectedOption(): SelectOption | null {
    const issue = this.getSelectedIssue();
    return issue ? this.options[this.selectedIndex] ?? null : null;
  }

  setSelectedIndex(index: number): void {
    if (this.issues.length === 0) return;
    const next = Math.max(0, Math.min(index, this.issues.length - 1));
    if (next === this.selectedIndex) return;
    this.selectedIndex = next;
    this.selectionChanged();
  }

  moveUp(steps = 1): void {
    this.setSelectedIndex(this.selectedIndex - steps);
  }

  moveDown(steps = 1): void {
    this.setSelectedIndex(this.selectedIndex + steps);
  }

  override handleKeyPress(key: KeyEvent): boolean {
    if (key.name === "up" || key.name === "k") { this.moveUp(); return true; }
    if (key.name === "down" || key.name === "j") { this.moveDown(); return true; }
    return super.handleKeyPress(key);
  }

  private addIssueRow(issue: TuiIssue, index: number): void {
    const presentation = statusPresentation(issue.state.type);
    const row = new BoxRenderable(this.ctx, {
      id: `tui-issue-row-${issue.identifier}`, width: "100%", height: 2,
      flexDirection: "column", backgroundColor: C.panel,
      onMouseDown: (event) => {
        this.setSelectedIndex(index);
        this.focus();
        event.preventDefault();
      },
    });
    row.add(new TextRenderable(this.ctx, {
      width: "100%", height: 1, paddingLeft: 1, selectable: false,
      content: t`${fg(issue.state.color || presentation.fallbackColor)(presentation.glyph)} ${issue.identifier}  ${issue.title}`,
      fg: C.text,
    }));
    row.add(new TextRenderable(this.ctx, {
      width: "100%", height: 1, paddingLeft: 3, selectable: false,
      content: `${issue.state.name}  ·  updated ${date(issue.updatedAt)}`, fg: C.muted,
    }));
    this.issueRows.set(index, row);
    this.add(row);
  }

  private selectionChanged(): void {
    this.updateSelectionFill();
    this.scrollSelectedIntoView();
    this.emit(IssueListEvents.SELECTION_CHANGED, this.selectedIndex, this.getSelectedIssue());
  }

  private updateSelectionFill(): void {
    for (const [index, row] of this.issueRows) {
      row.backgroundColor = index === this.selectedIndex
        ? (this.focused ? C.surface2 : C.surface1)
        : C.panel;
    }
  }

  private scrollSelectedIntoView(): void {
    const issue = this.getSelectedIssue();
    if (issue && !this.isDestroyed) this.scrollChildIntoView(`tui-issue-row-${issue.identifier}`);
  }
}
