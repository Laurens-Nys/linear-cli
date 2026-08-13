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

export interface StatusPresentation {
  glyph: string;
  fallbackColor: string;
}

const STATUS_PRESENTATION: Record<TuiWorkflowStateType, StatusPresentation> = {
  started: { glyph: "◐", fallbackColor: C.yellow },
  unstarted: { glyph: "○", fallbackColor: C.secondary },
  backlog: { glyph: "◍", fallbackColor: C.muted },
  triage: { glyph: "◌", fallbackColor: C.teal },
  completed: { glyph: "✓", fallbackColor: C.green },
  canceled: { glyph: "×", fallbackColor: C.red },
  duplicate: { glyph: "×", fallbackColor: C.muted },
};

const STATUS_ORDER: TuiWorkflowStateType[] = [
  "started", "unstarted", "backlog", "triage", "completed", "canceled", "duplicate",
];

export function statusPresentation(type: TuiWorkflowStateType): StatusPresentation {
  return STATUS_PRESENTATION[type];
}

export interface StateGroup {
  name: string;
  type: TuiWorkflowStateType;
  issues: TuiIssue[];
}

export function groupIssuesByState(issues: readonly TuiIssue[]): StateGroup[] {
  const groups: StateGroup[] = [];
  const indexByName = new Map<string, number>();
  for (const issue of issues) {
    const existing = indexByName.get(issue.state.name);
    if (existing !== undefined) {
      groups[existing]!.issues.push(issue);
      continue;
    }
    indexByName.set(issue.state.name, groups.length);
    groups.push({ name: issue.state.name, type: issue.state.type, issues: [issue] });
  }
  return groups.sort((a, b) => {
    const typeDelta = STATUS_ORDER.indexOf(a.type) - STATUS_ORDER.indexOf(b.type);
    return typeDelta !== 0 ? typeDelta : a.name.localeCompare(b.name);
  });
}

function date(value: string): string {
  return value.slice(0, 10);
}

export const IssueListEvents = {
  ITEM_ACTIVATED: "issueActivated",
  ITEM_OPENED: "issueOpened",
} as const;

export class IssueListRenderable extends ScrollBoxRenderable {
  private issues: TuiIssue[] = [];
  private selectedIndex = 0;
  private readonly issueRows = new Map<number, BoxRenderable>();

  constructor(renderer: CliRenderer) {
    super(renderer, {
      id: "tui-list", width: "42%", height: "100%", backgroundColor: "transparent",
      border: true, borderStyle: "single", borderColor: C.border, focusedBorderColor: C.lavender,
      title: "Issues", titleColor: C.secondary, padding: 1,
      scrollY: true, focusable: true, viewportCulling: true,
      verticalScrollbarOptions: { showArrows: false },
    });
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

  setIssues(issues: readonly TuiIssue[], selectedIdentifier?: string): void {
    for (const child of [...this.getChildren()]) child.destroyRecursively();
    this.issueRows.clear();
    const groups = groupIssuesByState(issues);
    this.issues = groups.flatMap((group) => group.issues);
    const selected = selectedIdentifier
      ? this.issues.findIndex((issue) => issue.identifier === selectedIdentifier)
      : 0;
    this.selectedIndex = Math.max(0, selected);

    let index = 0;
    for (const group of groups) {
      const heading = new TextRenderable(this.ctx, {
        id: `tui-status-group-${group.name}`, width: "100%", height: 1,
        content: `${group.name.toUpperCase()} · ${group.issues.length}`, fg: C.secondary, selectable: false,
        onMouseDown: (event) => { this.focus(); event.preventDefault(); },
      });
      this.add(heading);
      for (const issue of group.issues) this.addIssueRow(issue, index++);
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
    if (key.name === "return" || key.name === "enter") {
      if (this.getSelectedIssue()) {
        key.preventDefault();
        this.emit(IssueListEvents.ITEM_OPENED, this.getSelectedIssue());
        return true;
      }
    }
    return super.handleKeyPress(key);
  }

  private addIssueRow(issue: TuiIssue, index: number): void {
    const presentation = statusPresentation(issue.state.type);
    const row = new BoxRenderable(this.ctx, {
      id: `tui-issue-row-${issue.identifier}`, width: "100%", height: 2,
      flexDirection: "column", backgroundColor: "transparent",
      onMouseDown: (event) => {
        this.setSelectedIndex(index);
        this.focus();
        this.emit(IssueListEvents.ITEM_ACTIVATED, issue);
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
  }

  private updateSelectionFill(): void {
    for (const [index, row] of this.issueRows) {
      row.backgroundColor = index === this.selectedIndex
        ? (this.focused ? C.surface2 : C.surface1)
        : "transparent";
    }
  }

  private scrollSelectedIntoView(): void {
    const issue = this.getSelectedIssue();
    if (issue && !this.isDestroyed) this.scrollChildIntoView(`tui-issue-row-${issue.identifier}`);
  }
}
