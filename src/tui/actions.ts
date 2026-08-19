import {
  BoxRenderable,
  type CliRenderer,
  InputRenderable,
  InputRenderableEvents,
  type KeyEvent,
  RenderableEvents,
  SelectRenderable,
  SelectRenderableEvents,
  type SelectOption,
  TextRenderable,
} from "@opentui/core";
import type { CachedState, CachedTeam, Meta } from "../cache.ts";
import type { TuiIssue, TuiWorkflowStateType } from "./data.ts";
import { GROK_NIGHT as C } from "./theme.ts";

export type TuiActionId = "open" | "worktree" | "copy-id" | "copy-url" | "start" | "done" | "priority" | "comment";

export type TuiActionDispatch =
  | { type: "open" }
  | { type: "worktree" }
  | { type: "copy-id" }
  | { type: "copy-url" }
  | { type: "start" }
  | { type: "done" }
  | { type: "priority-menu" }
  | { type: "priority"; priority: number }
  | { type: "comment" }
  | { type: "select-issue"; identifier: string };

export interface TuiActionItem {
  id: TuiActionId;
  name: string;
  dispatch: TuiActionDispatch;
}

export const TUI_PRIORITY_CHOICES = [
  { priority: 1, name: "Urgent" },
  { priority: 2, name: "High" },
  { priority: 3, name: "Medium" },
  { priority: 4, name: "Low" },
  { priority: 0, name: "No priority" },
] as const;

export function priorityLabel(priority: number): string {
  return TUI_PRIORITY_CHOICES.find((choice) => choice.priority === priority)?.name ?? "No priority";
}

/** Mirrors OpenTUI 0.5.1 SelectRenderable's visible-window calculation without reading its private scrollOffset. */
export function visibleSelectOffset(
  selectedIndex: number,
  optionCount: number,
  height: number,
  linesPerItem: number,
): number {
  const visibleCount = Math.max(1, Math.floor(height / linesPerItem));
  return Math.max(0, Math.min(selectedIndex - Math.floor(visibleCount / 2), optionCount - visibleCount));
}

export function exactIssueOptionIndex(options: readonly SelectOption[], query: string): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return -1;
  return options.findIndex((option) => {
    const value = option.value as TuiActionDispatch | undefined;
    return value?.type === "select-issue" && value.identifier.toLowerCase() === needle;
  });
}

export function filterNamedOptions(options: readonly SelectOption[], query: string): SelectOption[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...options];
  const matches = options.filter((option) => option.name.toLowerCase().includes(needle));
  const exact = exactIssueOptionIndex(matches, needle);
  if (exact <= 0) return matches;
  const selected = matches[exact]!;
  return [selected, ...matches.slice(0, exact), ...matches.slice(exact + 1)];
}

export function firstTeamState(
  team: CachedTeam | undefined,
  type: TuiWorkflowStateType,
): CachedState | undefined {
  return team?.states
    .filter((state) => state.type === type)
    .slice()
    .sort((left, right) => left.position - right.position || left.name.localeCompare(right.name) || left.id.localeCompare(right.id))[0];
}

export function issueTeam(meta: Meta, issue: TuiIssue): CachedTeam | undefined {
  return meta.teams.find((team) => team.key === issue.team.key);
}

export function tuiIssueActions(
  issue: TuiIssue,
  team: CachedTeam | undefined,
  options?: { worktree?: boolean },
): TuiActionItem[] {
  const items: TuiActionItem[] = options?.worktree
    ? [{ id: "worktree", name: "Open as worktree", dispatch: { type: "worktree" } }]
    : [{ id: "open", name: "Open in Linear", dispatch: { type: "open" } }];
  items.push(
    { id: "copy-id", name: `Copy ${issue.identifier}`, dispatch: { type: "copy-id" } },
    { id: "copy-url", name: "Copy URL", dispatch: { type: "copy-url" } },
  );
  const started = firstTeamState(team, "started");
  const done = firstTeamState(team, "completed");
  if (started) items.push({ id: "start", name: `Move to ${started.name}`, dispatch: { type: "start" } });
  if (done) items.push({ id: "done", name: `Move to ${done.name}`, dispatch: { type: "done" } });
  items.push(
    { id: "priority", name: "Set priority", dispatch: { type: "priority-menu" } },
    { id: "comment", name: "Add comment", dispatch: { type: "comment" } },
  );
  return items;
}

export function actionSelectOptions(items: readonly TuiActionItem[]): SelectOption[] {
  return items.map((item) => ({ name: item.name, description: "", value: item.dispatch }));
}

export function issueSelectOptions(issues: readonly TuiIssue[]): SelectOption[] {
  return issues.map((issue) => ({
    name: `${issue.identifier}  ${issue.title}`,
    description: "",
    value: { type: "select-issue", identifier: issue.identifier } satisfies TuiActionDispatch,
  }));
}

export function prioritySelectOptions(): SelectOption[] {
  return TUI_PRIORITY_CHOICES.map((choice) => ({
    name: choice.name,
    description: "",
    value: { type: "priority", priority: choice.priority } satisfies TuiActionDispatch,
  }));
}

export class FocusSelect extends SelectRenderable {
  selectionFill: string = C.surface1;

  constructor(renderer: CliRenderer, options: ConstructorParameters<typeof SelectRenderable>[1]) {
    super(renderer, { ...options, selectedBackgroundColor: C.surface1 });
    this.on(RenderableEvents.FOCUSED, () => {
      this.selectionFill = C.surface2;
      this.selectedBackgroundColor = C.surface2;
    });
    this.on(RenderableEvents.BLURRED, () => {
      this.selectionFill = C.surface1;
      this.selectedBackgroundColor = C.surface1;
    });
  }
}

export class BrowserInput extends InputRenderable {
  onEscapePressed?: () => void;
  onDownPressed?: () => void;

  override handleKeyPress(key: KeyEvent): boolean {
    if (key.name === "escape" || key.name === "esc") {
      this.onEscapePressed?.();
      return true;
    }
    if (key.name === "down" && this.onDownPressed) {
      this.onDownPressed();
      return true;
    }
    return super.handleKeyPress(key);
  }
}

export class TuiActionMenu {
  readonly overlay: BoxRenderable;
  readonly modal: BoxRenderable;
  readonly input: BrowserInput;
  readonly list: FocusSelect;
  private mode: "actions" | "priority" = "actions";
  private readonly actions: SelectOption[];
  private readonly priorities = prioritySelectOptions();

  constructor(
    renderer: CliRenderer,
    root: BoxRenderable,
    readonly issue: TuiIssue,
    private readonly options: {
      items: readonly TuiActionItem[];
      issues?: readonly TuiIssue[];
      onCommit: (dispatch: TuiActionDispatch) => void;
      onClose: () => void;
    },
  ) {
    this.actions = [
      ...actionSelectOptions(options.items),
      ...issueSelectOptions(options.issues ?? []),
    ];
    this.modal = new BoxRenderable(renderer, {
      id: "tui-actions", width: renderer.terminalWidth < 80 ? "88%" : "42%", height: "58%",
      padding: 1, gap: 1, flexDirection: "column", border: true, borderStyle: "single",
      borderColor: C.border, focusedBorderColor: C.lavender, backgroundColor: C.panel,
      title: issue.identifier, titleColor: C.lavender,
      onMouseDown: (event) => event.preventDefault(),
    });
    this.overlay = new BoxRenderable(renderer, {
      id: "tui-actions-overlay", position: "absolute", top: 0, left: 0, width: "100%", height: "100%",
      zIndex: 110, backgroundColor: "transparent", alignItems: "center", justifyContent: "center",
      onMouseDown: (event) => {
        const inside = event.x >= this.modal.screenX && event.x < this.modal.screenX + this.modal.width
          && event.y >= this.modal.screenY && event.y < this.modal.screenY + this.modal.height;
        if (!inside) this.options.onClose();
        event.preventDefault();
      },
      onMouseScroll: (event) => event.preventDefault(),
    });
    this.input = new BrowserInput(renderer, {
      id: "tui-actions-search", width: "100%",
      placeholder: options.issues?.length ? "Search issues and actions…" : "Search actions…",
      backgroundColor: C.surface0, focusedBackgroundColor: C.surface1, textColor: C.text,
      focusedTextColor: C.text, placeholderColor: C.muted,
      onMouseDown: (event) => { this.input.focus(); event.preventDefault(); },
      onMouseOver: () => renderer.setMousePointer("text"),
      onMouseOut: () => renderer.setMousePointer("default"),
    });
    this.list = new FocusSelect(renderer, {
      id: "tui-actions-list", width: "100%", flexGrow: 1, options: this.actions, showDescription: false,
      showScrollIndicator: true, backgroundColor: C.panel, focusedBackgroundColor: C.panel,
      textColor: C.text, focusedTextColor: C.text, selectedTextColor: C.text, keyBindings: [
        { name: "up", action: "move-up" }, { name: "k", action: "move-up" },
        { name: "down", action: "move-down" }, { name: "j", action: "move-down" },
        { name: "enter", action: "select-current" },
      ],
      onMouseDown: (event) => {
        const row = Math.max(0, Math.floor(event.y - this.list.screenY));
        const offset = visibleSelectOffset(this.list.getSelectedIndex(), this.list.options.length, this.list.height, 1);
        const option = this.list.options[offset + row];
        if (option) this.options.onCommit(option.value as TuiActionDispatch);
        event.preventDefault();
      },
      onMouseScroll: (event) => {
        if (event.scroll?.direction === "up") this.list.moveUp();
        if (event.scroll?.direction === "down") this.list.moveDown();
        this.list.focus(); event.preventDefault();
      },
      onMouseOver: () => renderer.setMousePointer("pointer"),
      onMouseOut: () => renderer.setMousePointer("default"),
    });
    this.input.onEscapePressed = () => this.handleEscape();
    this.input.onDownPressed = () => this.list.focus();
    this.input.on(InputRenderableEvents.INPUT, (value: string) => {
      this.list.options = this.filtered(value);
      const exact = exactIssueOptionIndex(this.list.options, value);
      if (exact >= 0) this.list.setSelectedIndex(exact);
    });
    this.input.on(InputRenderableEvents.ENTER, () => {
      if (this.list.options.length > 0) this.options.onCommit(this.list.getSelectedOption()?.value as TuiActionDispatch);
    });
    this.list.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: SelectOption) => {
      this.options.onCommit(option.value as TuiActionDispatch);
    });
    this.modal.add(this.input);
    this.modal.add(this.list);
    this.overlay.add(this.modal);
    root.add(this.overlay);
    this.input.focus();
  }

  get nested(): boolean {
    return this.mode === "priority";
  }

  showPriority(): void {
    this.mode = "priority";
    this.modal.title = `Priority · ${this.issue.identifier}`;
    this.input.value = "";
    this.input.placeholder = "Search priorities…";
    this.list.options = this.priorities;
    this.input.focus();
  }

  handleEscape(): "closed" | "backed" {
    if (this.mode === "priority") {
      this.mode = "actions";
      this.modal.title = this.issue.identifier;
      this.input.value = "";
      this.input.placeholder = this.options.issues?.length ? "Search issues and actions…" : "Search actions…";
      this.list.options = this.actions;
      this.input.focus();
      return "backed";
    }
    this.options.onClose();
    return "closed";
  }

  destroy(): void {
    this.overlay.destroyRecursively();
  }

  private filtered(value: string): SelectOption[] {
    return filterNamedOptions(this.mode === "priority" ? this.priorities : this.actions, value);
  }
}

export class TuiCommentComposer {
  readonly overlay: BoxRenderable;
  readonly modal: BoxRenderable;
  readonly input: BrowserInput;
  readonly status: TextRenderable;
  private saving = false;

  constructor(
    renderer: CliRenderer,
    root: BoxRenderable,
    readonly issue: TuiIssue,
    private readonly options: {
      onSubmit: (body: string) => void;
      onClose: () => void;
    },
  ) {
    this.modal = new BoxRenderable(renderer, {
      id: "tui-comment", width: renderer.terminalWidth < 80 ? "88%" : "42%", height: 5,
      padding: 1, gap: 1, flexDirection: "column", border: true, borderStyle: "single",
      borderColor: C.border, focusedBorderColor: C.lavender, backgroundColor: C.panel,
      title: `Comment · ${issue.identifier}`, titleColor: C.lavender,
      onMouseDown: (event) => event.preventDefault(),
    });
    this.overlay = new BoxRenderable(renderer, {
      id: "tui-comment-overlay", position: "absolute", top: 0, left: 0, width: "100%", height: "100%",
      zIndex: 120, backgroundColor: "transparent", alignItems: "center", justifyContent: "center",
      onMouseDown: (event) => {
        if (this.saving) { event.preventDefault(); return; }
        const inside = event.x >= this.modal.screenX && event.x < this.modal.screenX + this.modal.width
          && event.y >= this.modal.screenY && event.y < this.modal.screenY + this.modal.height;
        if (!inside) this.options.onClose();
        event.preventDefault();
      },
      onMouseScroll: (event) => event.preventDefault(),
    });
    this.input = new BrowserInput(renderer, {
      id: "tui-comment-input", width: "100%", placeholder: "Write a comment…",
      backgroundColor: C.surface0, focusedBackgroundColor: C.surface1, textColor: C.text,
      focusedTextColor: C.text, placeholderColor: C.muted,
      onMouseDown: (event) => { this.input.focus(); event.preventDefault(); },
      onMouseOver: () => renderer.setMousePointer("text"),
      onMouseOut: () => renderer.setMousePointer("default"),
    });
    this.status = new TextRenderable(renderer, {
      id: "tui-comment-status", width: "100%", height: 1, content: "", fg: C.muted, selectable: false,
    });
    this.input.onEscapePressed = () => { if (!this.saving) this.options.onClose(); };
    this.input.on(InputRenderableEvents.ENTER, (value: string) => this.options.onSubmit(value));
    this.modal.add(this.input);
    this.modal.add(this.status);
    this.overlay.add(this.modal);
    root.add(this.overlay);
    this.input.focus();
  }

  get isSaving(): boolean {
    return this.saving;
  }

  setIdle(): void {
    this.saving = false;
    this.modal.title = `Comment · ${this.issue.identifier}`;
    this.status.content = "";
    this.status.fg = C.muted;
  }

  setSaving(): void {
    this.saving = true;
    this.modal.title = `Saving · ${this.issue.identifier}`;
    this.status.content = "Saving comment…";
    this.status.fg = C.yellow;
  }

  setError(message: string): void {
    this.saving = false;
    this.modal.title = `Comment · ${this.issue.identifier}`;
    this.status.content = message;
    this.status.fg = C.red;
    this.input.focus();
  }

  destroy(): void {
    this.overlay.destroyRecursively();
  }
}
