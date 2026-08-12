import {
  BoxRenderable,
  CliRenderEvents,
  type CliRenderer,
  InputRenderable,
  InputRenderableEvents,
  type KeyEvent,
  type Renderable,
  RenderableEvents,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
  type SelectOption,
} from "@opentui/core";
import type { CachedProject, CachedTeam, Meta } from "../cache.ts";
import {
  type TuiIssue,
  type TuiIssueQuery,
  TuiIssueStore,
  TUI_SORT_LABELS,
  type TuiSort,
} from "./data.ts";
import { GROK_NIGHT as C } from "./theme.ts";

const PRIORITIES = ["No priority", "Urgent", "High", "Medium", "Low"] as const;
type PickerKind = "team" | "project" | "sort";
type PickerValue = CachedTeam | CachedProject | { id: TuiSort; name: string } | null;

class FocusSelect extends SelectRenderable {
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

class BrowserInput extends InputRenderable {
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

export interface TuiAppOptions {
  limit: number;
  meta: Meta;
  initialTeamId?: string;
  onQuit?: () => void;
}

function date(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "";
}

export function issueDetail(issue: TuiIssue | undefined): string {
  if (!issue) return "Select an issue to view its details.";
  const meta = [
    `${issue.identifier}  ${issue.state.name}`,
    `${issue.team.name} (${issue.team.key})`,
    issue.project ? `Project: ${issue.project.name}` : "",
    `Priority: ${PRIORITIES[issue.priority] ?? "No priority"}`,
    issue.dueDate ? `Due: ${date(issue.dueDate)}` : "",
    `Updated: ${date(issue.updatedAt)}`,
    issue.labels.nodes.length ? `Labels: ${issue.labels.nodes.map((label) => label.name).join(", ")}` : "",
    "",
    issue.title,
    "",
    issue.description || "No description.",
    "",
    issue.url,
  ];
  return meta.filter((line, index) => line !== "" || meta[index - 1] !== "").join("\n");
}

function issueOptions(issues: readonly TuiIssue[]): SelectOption[] {
  return issues.map((issue) => ({
    name: `${issue.identifier}  ${issue.title}`,
    description: `${issue.state.name}  ·  updated ${date(issue.updatedAt)}`,
    value: issue,
  }));
}

function clip(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, Math.max(1, length - 1))}…`;
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

export class TuiApp {
  readonly root: BoxRenderable;
  readonly controls: BoxRenderable;
  readonly teamChip: BoxRenderable;
  readonly projectChip: BoxRenderable;
  readonly sortChip: BoxRenderable;
  readonly teamText: TextRenderable;
  readonly projectText: TextRenderable;
  readonly sortText: TextRenderable;
  readonly search: BrowserInput;
  readonly list: FocusSelect;
  readonly detail: ScrollBoxRenderable;
  readonly detailText: TextRenderable;
  readonly status: TextRenderable;
  readonly footer: TextRenderable;
  private readonly main: BoxRenderable;
  private stopped = false;
  private generation = 0;
  private selectedTeamId: string | undefined;
  private selectedProjectId: string | undefined;
  private sort: TuiSort = "updated";
  private appliedTitle = "";
  private detailIssueId: string | undefined;
  private reconcilingIssues = false;
  private lastContentFocus?: Renderable;
  private picker?: {
    kind: PickerKind;
    overlay: BoxRenderable;
    input: InputRenderable;
    list: FocusSelect;
    all: SelectOption[];
    previousFocus: Renderable;
  };

  constructor(
    private readonly renderer: CliRenderer,
    private readonly store: TuiIssueStore,
    private readonly options: TuiAppOptions,
  ) {
    this.selectedTeamId = options.initialTeamId;
    this.status = new TextRenderable(renderer, {
      id: "tui-status", content: "Loading your open issues…", height: 1, fg: C.secondary, selectable: false,
    });

    this.controls = new BoxRenderable(renderer, {
      id: "tui-controls", width: "100%", height: 3, flexDirection: "row", gap: 1,
      backgroundColor: C.panel,
    });
    [this.teamChip, this.teamText] = this.makeChip("team");
    [this.projectChip, this.projectText] = this.makeChip("project");
    [this.sortChip, this.sortText] = this.makeChip("sort");
    this.search = new BrowserInput(renderer, {
      id: "tui-search", width: "28%", placeholder: "Search title…",
      backgroundColor: C.surface0, focusedBackgroundColor: C.surface1,
      textColor: C.text, focusedTextColor: C.text, placeholderColor: C.muted,
      onMouseDown: (event) => { this.search.focus(); event.preventDefault(); },
      onMouseOver: () => this.renderer.setMousePointer("text"),
      onMouseOut: () => this.renderer.setMousePointer("default"),
    });
    this.search.on(InputRenderableEvents.ENTER, (value: string) => this.applySearch(value));
    this.search.onEscapePressed = () => this.leaveSearch();
    this.search.on(RenderableEvents.FOCUSED, () => { this.lastContentFocus = this.search; this.updateFooter(); });
    this.search.on(RenderableEvents.BLURRED, () => this.updateFooter());
    this.controls.add(this.teamChip);
    this.controls.add(this.projectChip);
    this.controls.add(this.sortChip);
    this.controls.add(this.search);

    this.list = new FocusSelect(renderer, {
      id: "tui-list", width: "42%", height: "100%", options: [], showDescription: true,
      showScrollIndicator: true, wrapSelection: false, backgroundColor: C.panel,
      focusedBackgroundColor: C.panel, textColor: C.text, focusedTextColor: C.text,
      descriptionColor: C.muted, selectedTextColor: C.text, selectedDescriptionColor: C.secondary,
      keyBindings: [
        { name: "up", action: "move-up" }, { name: "k", action: "move-up" },
        { name: "down", action: "move-down" }, { name: "j", action: "move-down" },
      ],
      onMouseDown: (event) => {
        const row = Math.max(0, Math.floor((event.y - this.list.screenY) / 2));
        const offset = visibleSelectOffset(
          this.list.getSelectedIndex(), this.list.options.length, this.list.height, 2,
        );
        this.list.setSelectedIndex(offset + row);
        this.list.focus();
        event.preventDefault();
      },
      onMouseScroll: (event) => {
        if (event.scroll?.direction === "up") this.list.moveUp();
        if (event.scroll?.direction === "down") this.list.moveDown();
        this.list.focus(); event.preventDefault();
      },
      onMouseOver: () => this.renderer.setMousePointer("pointer"),
      onMouseOut: () => this.renderer.setMousePointer("default"),
    });

    this.detailText = new TextRenderable(renderer, {
      id: "tui-detail-text", content: "Loading…", width: "100%", fg: C.text,
      wrapMode: "word", selectable: true,
    });
    this.detail = new ScrollBoxRenderable(renderer, {
      id: "tui-detail", width: "58%", height: "100%", padding: 1, border: ["left"],
      borderColor: C.border, focusedBorderColor: C.accent, backgroundColor: C.base,
      scrollY: true, focusable: true,
      onMouseDown: (event) => { this.detail.focus(); event.preventDefault(); },
      onMouseOver: () => this.renderer.setMousePointer("text"),
      onMouseOut: () => this.renderer.setMousePointer("default"),
    });
    this.detail.add(this.detailText);
    this.main = new BoxRenderable(renderer, {
      id: "tui-main", width: "100%", flexGrow: 1, flexDirection: "row", backgroundColor: C.base,
    });
    this.main.add(this.list); this.main.add(this.detail);

    this.footer = new TextRenderable(renderer, {
      id: "tui-footer", height: 1, fg: C.secondary, selectable: false, content: "",
    });
    this.root = new BoxRenderable(renderer, {
      id: "tui-root", width: "100%", height: "100%", padding: 1, flexDirection: "column",
      backgroundColor: C.base, gap: 1,
    });
    this.root.add(this.status); this.root.add(this.controls); this.root.add(this.main); this.root.add(this.footer);

    this.list.on(SelectRenderableEvents.SELECTION_CHANGED, (_index: number, option: SelectOption | null) => {
      if (!this.reconcilingIssues) this.showIssue(option?.value as TuiIssue | undefined);
    });
    this.list.on(RenderableEvents.FOCUSED, () => { this.lastContentFocus = this.list; this.updateFooter(); });
    this.list.on(RenderableEvents.BLURRED, () => this.updateFooter());
    this.detail.on(RenderableEvents.FOCUSED, () => { this.lastContentFocus = this.detail; this.updateFooter(); });
    this.detail.on(RenderableEvents.BLURRED, () => this.updateFooter());
    this.renderer.keyInput.on("keypress", (key) => this.handleGlobalKey(key));
    this.renderer.on(CliRenderEvents.RESIZE, () => this.applyLayout());
    this.updateControls(); this.applyLayout(); this.updateFooter();
  }

  mount(): void { this.renderer.root.add(this.root); this.list.focus(); }
  start(): void { this.mount(); void this.refresh(); }

  currentQuery(): TuiIssueQuery {
    return {
      limit: this.options.limit, teamId: this.selectedTeamId, projectId: this.selectedProjectId,
      title: this.appliedTitle || undefined, sort: this.sort,
    };
  }

  async refresh(): Promise<void> {
    const generation = ++this.generation;
    const query = { ...this.currentQuery() };
    this.store.loading();
    this.status.content = "Refreshing your open issues…";
    this.status.fg = C.secondary;
    try {
      const issues = await this.store.load(query);
      if (generation !== this.generation || this.stopped || this.renderer.isDestroyed) return;
      const state = this.store.ready(issues);
      const currentId = (this.list.getSelectedOption()?.value as TuiIssue | undefined)?.identifier;
      const previousIndex = currentId ? state.issues.findIndex((issue) => issue.identifier === currentId) : 0;
      const selectedIndex = Math.max(0, previousIndex);
      this.reconcilingIssues = true;
      this.list.options = issueOptions(state.issues);
      if (state.issues.length > 0) this.list.setSelectedIndex(selectedIndex);
      this.reconcilingIssues = false;
      this.showIssue(state.issues[selectedIndex]);
      if (state.issues.length === 0) {
        this.status.content = "No matching open issues are assigned to you.";
        this.detailText.content = "No issues match these session filters.";
      } else {
        this.status.content = `Showing ${state.issues.length} open issue${state.issues.length === 1 ? "" : "s"} assigned to you`;
      }
    } catch (error) {
      if (generation !== this.generation || this.stopped || this.renderer.isDestroyed) return;
      const state = this.store.error(error);
      const message = state.kind === "error" ? state.message : String(error);
      this.status.content = `Could not refresh: ${message}  ·  press r to retry`;
      this.status.fg = C.red;
    }
  }

  quit(): void {
    if (this.stopped) return;
    this.stopped = true; this.generation += 1; this.options.onQuit?.();
  }

  openPicker(kind: PickerKind, previousFocus?: Renderable): void {
    if (this.picker) return;
    const restoreFocus: Renderable = previousFocus ?? (this.detail.focused ? this.detail : this.search.focused ? this.search : this.list.focused ? this.list : this.lastContentFocus ?? this.list);
    this.lastContentFocus = restoreFocus;
    const all = this.pickerOptions(kind);
    const overlay = new BoxRenderable(this.renderer, {
      id: "tui-picker-overlay", position: "absolute", top: 0, left: 0, width: "100%", height: "100%",
      zIndex: 100, backgroundColor: C.base, alignItems: "center", justifyContent: "center",
      onMouseDown: (event) => event.preventDefault(), onMouseScroll: (event) => event.preventDefault(),
    });
    const modal = new BoxRenderable(this.renderer, {
      id: "tui-picker", width: this.renderer.terminalWidth < 80 ? "88%" : "58%", height: kind === "sort" ? 12 : "62%",
      padding: 1, gap: 1, flexDirection: "column", border: true, borderColor: C.border,
      focusedBorderColor: C.accent, backgroundColor: C.panel, title: kind === "team" ? "Team" : kind === "project" ? "Project" : "Sort",
      titleColor: C.accent,
    });
    const input = new BrowserInput(this.renderer, {
      id: "tui-picker-search", width: "100%", placeholder: kind === "sort" ? "Filter sort choices…" : `Search ${kind}s…`,
      backgroundColor: C.surface0, focusedBackgroundColor: C.surface1, textColor: C.text,
      focusedTextColor: C.text, placeholderColor: C.muted,
      onMouseDown: (event) => { input.focus(); event.preventDefault(); },
      onMouseOver: () => this.renderer.setMousePointer("text"),
      onMouseOut: () => this.renderer.setMousePointer("default"),
    });
    const list = new FocusSelect(this.renderer, {
      id: "tui-picker-list", width: "100%", flexGrow: 1, options: all, showDescription: false,
      showScrollIndicator: true, backgroundColor: C.panel, focusedBackgroundColor: C.panel,
      textColor: C.text, focusedTextColor: C.text, selectedTextColor: C.text, keyBindings: [
        { name: "up", action: "move-up" }, { name: "k", action: "move-up" },
        { name: "down", action: "move-down" }, { name: "j", action: "move-down" },
        { name: "enter", action: "select-current" },
      ],
      onMouseDown: (event) => {
        const row = Math.max(0, Math.floor(event.y - list.screenY));
        const offset = visibleSelectOffset(list.getSelectedIndex(), list.options.length, list.height, 1);
        const option = list.options[offset + row];
        if (option) this.commitPicker(kind, option.value as PickerValue);
        event.preventDefault();
      },
      onMouseScroll: (event) => {
        if (event.scroll?.direction === "up") list.moveUp();
        if (event.scroll?.direction === "down") list.moveDown();
        list.focus(); event.preventDefault();
      },
      onMouseOver: () => this.renderer.setMousePointer("pointer"),
      onMouseOut: () => this.renderer.setMousePointer("default"),
    });
    input.onEscapePressed = () => this.closePicker();
    input.onDownPressed = () => list.focus();
    input.on(InputRenderableEvents.INPUT, (value: string) => {
      const query = value.trim().toLowerCase();
      list.options = query ? all.filter((option) => option.name.toLowerCase().includes(query)) : all;
    });
    input.on(InputRenderableEvents.ENTER, () => { if (list.options.length > 0) this.commitPicker(kind, list.getSelectedOption()?.value as PickerValue); });
    list.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: SelectOption) => this.commitPicker(kind, option.value as PickerValue));
    const hint = new TextRenderable(this.renderer, {
      id: "tui-picker-hint", height: 1, fg: C.secondary, selectable: false,
      content: "type filter  ·  ↑/↓ or j/k move  ·  enter choose  ·  esc cancel",
    });
    modal.add(input); modal.add(list); modal.add(hint); overlay.add(modal); this.root.add(overlay);
    this.picker = { kind, overlay, input, list, all, previousFocus: restoreFocus };
    input.focus();
  }

  closePicker(): void {
    const picker = this.picker;
    if (!picker) return;
    this.picker = undefined;
    picker.overlay.destroyRecursively();
    queueMicrotask(() => {
      if (!this.stopped && !this.renderer.isDestroyed) {
        picker.previousFocus.focus();
        this.renderer.focusRenderable(picker.previousFocus);
      }
    });
  }

  private makeChip(kind: PickerKind): [BoxRenderable, TextRenderable] {
    const text = new TextRenderable(this.renderer, { id: `tui-${kind}-text`, content: "", fg: C.text, selectable: false });
    const chip = new BoxRenderable(this.renderer, {
      id: `tui-${kind}-chip`, width: "22%", height: 3, paddingX: 1, border: true,
      borderColor: C.border, focusedBorderColor: C.accent, backgroundColor: C.surface0, focusable: true,
      onMouseDown: (event) => {
        const previousFocus = this.detail.focused ? this.detail : this.search.focused ? this.search : this.list;
        this.openPicker(kind, previousFocus);
        event.preventDefault();
      },
      onMouseOver: () => this.renderer.setMousePointer("pointer"),
      onMouseOut: () => this.renderer.setMousePointer("default"),
    });
    chip.add(text); return [chip, text];
  }

  private pickerOptions(kind: PickerKind): SelectOption[] {
    if (kind === "team") return [
      { name: "All teams", description: "", value: null },
      ...this.options.meta.teams.map((team) => ({ name: `${team.key}  ${team.name}`, description: "", value: team })),
    ];
    if (kind === "project") return [
      { name: "All projects", description: "", value: null },
      ...this.options.meta.projects.map((project) => ({ name: project.name, description: "", value: project })),
    ];
    return (Object.keys(TUI_SORT_LABELS) as TuiSort[]).map((id) => ({
      name: TUI_SORT_LABELS[id], description: "", value: { id, name: TUI_SORT_LABELS[id] },
    }));
  }

  private commitPicker(kind: PickerKind, value: PickerValue): void {
    if (kind === "team") this.selectedTeamId = (value as CachedTeam | null)?.id;
    else if (kind === "project") this.selectedProjectId = (value as CachedProject | null)?.id;
    else this.sort = (value as { id: TuiSort }).id;
    this.updateControls(); this.closePicker(); void this.refresh();
  }

  private applySearch(value: string): void {
    const title = value.trim();
    if (title === this.appliedTitle) { this.list.focus(); return; }
    this.appliedTitle = title; this.list.focus(); void this.refresh();
  }

  private leaveSearch(): void {
    this.search.value = this.appliedTitle;
    this.list.focus();
  }

  private updateControls(): void {
    const team = this.options.meta.teams.find((item) => item.id === this.selectedTeamId);
    const project = this.options.meta.projects.find((item) => item.id === this.selectedProjectId);
    this.teamText.content = `Team: ${clip(team?.key ?? "All", 15)}`;
    this.projectText.content = `Project: ${clip(project?.name ?? "All", 18)}`;
    this.sortText.content = `Sort: ${clip(TUI_SORT_LABELS[this.sort], 17)}`;
  }

  private showIssue(issue: TuiIssue | undefined): void {
    const nextId = issue?.identifier;
    this.detailText.content = issueDetail(issue);
    if (nextId !== this.detailIssueId) this.detail.scrollTo(0);
    this.detailIssueId = nextId;
  }

  private handleGlobalKey(key: KeyEvent): void {
    if (key.ctrl && key.name === "c") { key.preventDefault(); this.quit(); return; }
    if (this.picker) {
      if ((key.name === "escape" || key.name === "esc")) { key.preventDefault(); this.closePicker(); return; }
      if (this.picker.input.focused && key.name === "down") { key.preventDefault(); this.picker.list.focus(); }
      return;
    }
    if (this.search.focused) {
      if ((key.name === "escape" || key.name === "esc")) { key.preventDefault(); this.leaveSearch(); }
      return;
    }
    if (key.name === "tab") { key.preventDefault(); (this.detail.focused ? this.list : this.detail).focus(); return; }
    if (key.name === "/") { key.preventDefault(); this.search.focus(); return; }
    if (key.name === "t") { key.preventDefault(); this.openPicker("team"); return; }
    if (key.name === "p") { key.preventDefault(); this.openPicker("project"); return; }
    if (key.name === "s") { key.preventDefault(); this.openPicker("sort"); return; }
    if (key.name === "q") { key.preventDefault(); this.quit(); return; }
    if (key.name === "r") { key.preventDefault(); void this.refresh(); return; }
    if (key.name === "pageup") {
      key.preventDefault();
      if (this.detail.focused) this.detail.scrollBy(-1, "viewport");
      else this.list.moveUp(Math.max(1, Math.floor(this.list.height / 2)));
      return;
    }
    if (key.name === "pagedown") {
      key.preventDefault();
      if (this.detail.focused) this.detail.scrollBy(1, "viewport");
      else this.list.moveDown(Math.max(1, Math.floor(this.list.height / 2)));
    }
  }

  private applyLayout(): void {
    const narrow = this.renderer.terminalWidth < 80;
    this.controls.height = narrow ? 6 : 3;
    this.controls.flexWrap = narrow ? "wrap" : "no-wrap";
    this.teamChip.width = narrow ? "48%" : "20%";
    this.projectChip.width = narrow ? "48%" : "24%";
    this.sortChip.width = narrow ? "48%" : "25%";
    this.search.width = narrow ? "48%" : "28%";
    this.main.flexDirection = narrow ? "column" : "row";
    this.list.width = narrow ? "100%" : "42%"; this.list.height = narrow ? "48%" : "100%";
    this.detail.width = narrow ? "100%" : "58%"; this.detail.height = narrow ? "52%" : "100%";
    this.detail.border = narrow ? ["top"] : ["left"];
    this.updateFooter();
  }

  private updateFooter(): void {
    if (this.search.focused && !this.picker) {
      this.footer.content = "enter search  ·  esc back  ·  ctrl-c quit";
      return;
    }
    const narrow = this.renderer.terminalWidth < 80;
    this.footer.content = narrow
      ? "/ search · t team · p proj · s sort · r refresh · q quit"
      : "tab pane · / search · t team · p project · s sort · r refresh · q quit";
  }
}
