import {
  BoxRenderable,
  CliRenderEvents,
  type CliRenderer,
  InputRenderable,
  InputRenderableEvents,
  type KeyEvent,
  MarkdownRenderable,
  type Renderable,
  RenderableEvents,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  SyntaxStyle,
  TextRenderable,
  type SelectOption,
} from "@opentui/core";
import type { CachedProject, CachedTeam, Meta } from "../cache.ts";
import {
  type TuiIssue,
  type TuiIssueQuery,
  TuiIssueStore,
  TUI_SORT_LABELS,
  TUI_SORT_SHORT,
  TUI_VIEW_LABELS,
  TUI_VIEWS,
  type TuiSort,
  type TuiView,
} from "./data.ts";
import { IssueListEvents, IssueListRenderable } from "./issue-list.ts";
import { issueDetail, issueMarkdownRenderNode } from "./markdown.ts";
import { isRemoteSession, issueOpenUrl, openExternalUrl } from "./open.ts";
import { GROK_NIGHT as C, GROK_NIGHT_MARKDOWN } from "./theme.ts";

export { issueDetail };
export type PickerKind = "team" | "project" | "sort";
type PickerValue = CachedTeam | CachedProject | { id: TuiSort; name: string } | null;

const VIEW_TABS: { view: TuiView; key: string }[] = TUI_VIEWS.map((view, index) => ({
  view, key: String(index + 1),
}));

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
  remote?: boolean;
  openExternal?: (url: string) => Promise<void> | void;
  copyToClipboard?: (text: string) => boolean;
}

function clip(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, Math.max(1, length - 1))}…`;
}

function tabLabel(view: TuiView, compact: boolean): string {
  const label = TUI_VIEW_LABELS[view];
  return compact ? label.slice(0, 3) : label;
}

export function chipLabel(kind: PickerKind, value: string, compact: boolean): string {
  const title = kind === "team" ? "Team" : kind === "project" ? "Project" : "Sort";
  const max = compact ? 4 : kind === "project" ? 12 : 8;
  return `${title} ${clip(value, max)} ▾`;
}

export function openChipLabel(compact: boolean): string {
  return compact ? "↗" : "Open ↗";
}

export function footerHint(listHidden: boolean, compact: boolean, searching = false): string {
  if (searching) return "enter apply  ·  esc cancel";
  if (listHidden) {
    return compact ? "esc back  ·  q quit" : "esc back  ·  / search  ·  r refresh  ·  q quit";
  }
  return compact ? "/ search  ·  q quit" : "/ search  ·  r refresh  ·  q quit";
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
  readonly header: BoxRenderable;
  readonly viewTabs: Record<TuiView, BoxRenderable>;
  readonly viewTexts: Record<TuiView, TextRenderable>;
  readonly teamChip: BoxRenderable;
  readonly projectChip: BoxRenderable;
  readonly sortChip: BoxRenderable;
  readonly openChip: BoxRenderable;
  readonly teamText: TextRenderable;
  readonly projectText: TextRenderable;
  readonly sortText: TextRenderable;
  readonly openText: TextRenderable;
  readonly searchStatus: TextRenderable;
  readonly countText: TextRenderable;
  readonly search: BrowserInput;
  readonly list: IssueListRenderable;
  readonly detail: ScrollBoxRenderable;
  readonly detailMarkdown: MarkdownRenderable;
  readonly footer: TextRenderable;
  private readonly main: BoxRenderable;
  private readonly searchOverlay: BoxRenderable;
  private readonly syntaxStyle: SyntaxStyle;
  private detailSource = "Loading…";
  private stopped = false;
  private generation = 0;
  private selectedTeamId: string | undefined;
  private selectedProjectId: string | undefined;
  private sort: TuiSort = "updated";
  private view: TuiView = "all";
  private activePane: "issues" | "detail" = "issues";
  private listHidden = false;
  private appliedTitle = "";
  private detailIssueId: string | undefined;
  private reconcilingIssues = false;
  private errorMessage = "";
  private notice = "";
  private pendingDetailMarkdown = false;
  private lastMarkdownWidth = 0;
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

    this.header = new BoxRenderable(renderer, {
      id: "tui-header", width: "100%", height: 1, flexDirection: "row", gap: 2,
      backgroundColor: C.surface0, paddingX: 1,
    });
    const tabs = new BoxRenderable(renderer, {
      id: "tui-tabs", height: 1, flexDirection: "row", gap: 1, backgroundColor: C.surface0,
    });
    this.viewTabs = {} as Record<TuiView, BoxRenderable>;
    this.viewTexts = {} as Record<TuiView, TextRenderable>;
    for (const { view } of VIEW_TABS) {
      const [tab, text] = this.makeViewTab(view);
      this.viewTabs[view] = tab;
      this.viewTexts[view] = text;
      tabs.add(tab);
    }
    this.header.add(tabs);
    [this.teamChip, this.teamText] = this.makeChip("team");
    [this.projectChip, this.projectText] = this.makeChip("project");
    [this.sortChip, this.sortText] = this.makeChip("sort");
    [this.openChip, this.openText] = this.makeOpenChip();
    this.searchStatus = new TextRenderable(renderer, {
      id: "tui-search-status", content: "", fg: C.yellow, selectable: false,
    });
    this.countText = new TextRenderable(renderer, {
      id: "tui-count", content: "", fg: C.muted, selectable: false, flexGrow: 1,
    });
    this.header.add(this.teamChip);
    this.header.add(this.projectChip);
    this.header.add(this.sortChip);
    this.header.add(this.openChip);
    this.header.add(this.searchStatus);
    this.header.add(this.countText);

    this.search = new BrowserInput(renderer, {
      id: "tui-search", width: "100%", placeholder: "Search title…",
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
    const searchModal = new BoxRenderable(renderer, {
      id: "tui-search-modal", width: renderer.terminalWidth < 80 ? "88%" : "42%", height: 3,
      padding: 1, flexDirection: "column", border: true, borderStyle: "single",
      borderColor: C.border, focusedBorderColor: C.lavender, backgroundColor: C.panel, title: "Search",
      titleColor: C.lavender,
      onMouseDown: (event) => event.preventDefault(),
    });
    searchModal.add(this.search);
    this.searchOverlay = new BoxRenderable(renderer, {
      id: "tui-search-overlay", position: "absolute", top: 0, left: 0, width: "100%", height: "100%",
      zIndex: 100, visible: false, backgroundColor: "transparent", alignItems: "center", justifyContent: "center",
      onMouseDown: (event) => {
        const inside = event.x >= searchModal.screenX && event.x < searchModal.screenX + searchModal.width
          && event.y >= searchModal.screenY && event.y < searchModal.screenY + searchModal.height;
        if (!inside) this.leaveSearch();
        event.preventDefault();
      },
      onMouseScroll: (event) => event.preventDefault(),
    });
    this.searchOverlay.add(searchModal);

    this.list = new IssueListRenderable(renderer);

    this.syntaxStyle = SyntaxStyle.fromStyles({ ...GROK_NIGHT_MARKDOWN });
    this.detailMarkdown = new MarkdownRenderable(renderer, {
      id: "tui-detail-markdown", content: "Loading…", width: "100%",
      flexGrow: 0, flexShrink: 0,
      syntaxStyle: this.syntaxStyle, fg: C.text, conceal: true,
      internalBlockMode: "top-level",
      tableOptions: { style: "grid", widthMode: "full", cellPaddingX: 1, borderColor: C.border },
      renderNode: issueMarkdownRenderNode(renderer),
    });
    this.detail = new ScrollBoxRenderable(renderer, {
      id: "tui-detail", width: "58%", height: "100%", padding: 1, border: true, borderStyle: "single",
      borderColor: C.border, focusedBorderColor: C.lavender, backgroundColor: "transparent",
      title: "Detail", titleColor: C.secondary,
      scrollY: true, focusable: true,
      onMouseDown: (event) => { this.detail.focus(); event.preventDefault(); },
      onMouseOver: () => this.renderer.setMousePointer("text"),
      onMouseOut: () => this.renderer.setMousePointer("default"),
    });
    this.detail.add(this.detailMarkdown);
    this.detailMarkdown.on("resize", () => this.flushDetailMarkdown());
    this.renderer.on(CliRenderEvents.FRAME, () => this.flushDetailMarkdown());
    this.main = new BoxRenderable(renderer, {
      id: "tui-main", width: "100%", flexGrow: 1, flexDirection: "row", gap: 1, backgroundColor: "transparent",
    });
    this.main.add(this.list); this.main.add(this.detail);

    this.footer = new TextRenderable(renderer, {
      id: "tui-footer", height: 1, fg: C.secondary, selectable: false, content: "",
    });
    this.root = new BoxRenderable(renderer, {
      id: "tui-root", width: "100%", height: "100%", flexDirection: "column",
      backgroundColor: "transparent",
    });
    this.root.add(this.header); this.root.add(this.main); this.root.add(this.footer); this.root.add(this.searchOverlay);

    this.list.on(IssueListEvents.ITEM_ACTIVATED, (issue: TuiIssue | undefined) => {
      if (!this.reconcilingIssues) this.showIssue(issue);
    });
    this.list.on(IssueListEvents.ITEM_OPENED, () => this.openSelectedIssue());
    this.list.on(RenderableEvents.FOCUSED, () => {
      this.activePane = "issues"; this.applyPaneVisibility();
      this.lastContentFocus = this.list; this.updateFooter();
    });
    this.list.on(RenderableEvents.BLURRED, () => this.updateFooter());
    this.detail.on(RenderableEvents.FOCUSED, () => {
      this.activePane = "detail"; this.applyPaneVisibility();
      this.lastContentFocus = this.detail; this.updateFooter();
    });
    this.detail.on(RenderableEvents.BLURRED, () => this.updateFooter());
    this.renderer.keyInput.on("keypress", (key) => this.handleGlobalKey(key));
    this.renderer.on(CliRenderEvents.RESIZE, () => this.applyLayout());
    this.updateHeader(); this.applyLayout(); this.updateFooter();
  }

  mount(): void { this.renderer.root.add(this.root); this.list.focus(); }
  start(): void { this.mount(); void this.refresh(); }

  currentQuery(): TuiIssueQuery {
    return {
      limit: this.options.limit, teamId: this.selectedTeamId, projectId: this.selectedProjectId,
      title: this.appliedTitle || undefined, sort: this.sort, view: this.view,
    };
  }

  async refresh(): Promise<void> {
    const generation = ++this.generation;
    const query = { ...this.currentQuery() };
    this.store.loading();
    this.errorMessage = "";
    this.countText.content = "Refreshing…";
    this.countText.fg = C.secondary;
    try {
      const issues = await this.store.load(query);
      if (generation !== this.generation || this.stopped || this.renderer.isDestroyed) return;
      const state = this.store.ready(issues);
      const currentId = this.list.getSelectedIssue()?.identifier;
      const selectedId = currentId && state.issues.some((issue) => issue.identifier === currentId)
        ? currentId
        : undefined;
      this.reconcilingIssues = true;
      this.list.setIssues(state.issues, selectedId);
      this.reconcilingIssues = false;
      const openIssue = this.detailIssueId
        ? state.issues.find((issue) => issue.identifier === this.detailIssueId)
        : undefined;
      this.showIssue(openIssue ?? this.list.getSelectedIssue());
      if (state.issues.length === 0) {
        this.countText.content = "0";
        this.setDetailMarkdown("No issues match this view.");
        this.detail.title = "Detail";
      } else {
        this.countText.content = `${state.issues.length}`;
      }
      this.countText.fg = C.muted;
      this.updateHeader();
    } catch (error) {
      if (generation !== this.generation || this.stopped || this.renderer.isDestroyed) return;
      const state = this.store.error(error);
      const message = state.kind === "error" ? state.message : String(error);
      this.errorMessage = `Could not refresh: ${message}  ·  press r to retry`;
      this.countText.fg = C.red;
      this.updateFooter();
    }
  }

  quit(): void {
    if (this.stopped) return;
    this.stopped = true; this.generation += 1; this.options.onQuit?.();
  }

  openPicker(kind: PickerKind, previousFocus?: Renderable): void {
    if (this.picker || this.searchOverlay.visible) return;
    const restoreFocus: Renderable = previousFocus ?? (this.detail.focused ? this.detail : this.search.focused ? this.search : this.list.focused ? this.list : this.lastContentFocus ?? this.list);
    this.lastContentFocus = restoreFocus;
    const all = this.pickerOptions(kind);
    const modal = new BoxRenderable(this.renderer, {
      id: "tui-picker", width: this.renderer.terminalWidth < 80 ? "88%" : "58%", height: kind === "sort" ? 10 : "62%",
      padding: 1, gap: 1, flexDirection: "column", border: true, borderStyle: "single",
      borderColor: C.border, focusedBorderColor: C.lavender, backgroundColor: C.panel,
      title: kind === "team" ? "Team" : kind === "project" ? "Project" : "Sort",
      titleColor: C.lavender,
      onMouseDown: (event) => event.preventDefault(),
    });
    const overlay = new BoxRenderable(this.renderer, {
      id: "tui-picker-overlay", position: "absolute", top: 0, left: 0, width: "100%", height: "100%",
      zIndex: 100, backgroundColor: "transparent", alignItems: "center", justifyContent: "center",
      onMouseDown: (event) => {
        const inside = event.x >= modal.screenX && event.x < modal.screenX + modal.width
          && event.y >= modal.screenY && event.y < modal.screenY + modal.height;
        if (!inside) this.closePicker();
        event.preventDefault();
      },
      onMouseScroll: (event) => event.preventDefault(),
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
    modal.add(input); modal.add(list); overlay.add(modal); this.root.add(overlay);
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

  private makeViewTab(view: TuiView): [BoxRenderable, TextRenderable] {
    const label = tabLabel(view, false);
    const text = new TextRenderable(this.renderer, {
      id: `tui-view-${view}-text`, content: label, fg: C.secondary, selectable: false,
    });
    const tab = new BoxRenderable(this.renderer, {
      id: `tui-view-${view}`, height: 1, width: label.length + 2, paddingX: 1,
      backgroundColor: C.surface0, shouldFill: true,
      onMouseDown: (event) => { this.setView(view); event.preventDefault(); },
      onMouseOver: () => this.renderer.setMousePointer("pointer"),
      onMouseOut: () => this.renderer.setMousePointer("default"),
    });
    tab.add(text);
    return [tab, text];
  }

  private makeChip(kind: PickerKind): [BoxRenderable, TextRenderable] {
    const text = new TextRenderable(this.renderer, {
      id: `tui-${kind}-text`, content: "", fg: kind === "sort" ? C.muted : C.yellow, selectable: false,
    });
    const chip = new BoxRenderable(this.renderer, {
      id: `tui-${kind}-chip`, height: 1, backgroundColor: C.surface0,
      onMouseDown: (event) => {
        const previousFocus = this.detail.focused ? this.detail : this.list;
        this.openPicker(kind, previousFocus);
        event.preventDefault();
      },
      onMouseOver: () => this.renderer.setMousePointer("pointer"),
      onMouseOut: () => this.renderer.setMousePointer("default"),
    });
    chip.add(text); return [chip, text];
  }

  private makeOpenChip(): [BoxRenderable, TextRenderable] {
    const text = new TextRenderable(this.renderer, {
      id: "tui-open-text", content: openChipLabel(false), fg: C.blue, selectable: false,
    });
    const chip = new BoxRenderable(this.renderer, {
      id: "tui-open-chip", height: 1, backgroundColor: C.surface0,
      onMouseDown: (event) => { this.openInLinear(); event.preventDefault(); },
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
    this.updateHeader(); this.closePicker(); void this.refresh();
  }

  private setView(view: TuiView): void {
    if (this.view === view) {
      this.activatePane("issues");
      return;
    }
    this.view = view;
    this.updateHeader();
    this.activatePane("issues");
    void this.refresh();
  }

  private activatePane(pane: "issues" | "detail"): void {
    const revealList = pane === "issues" && this.listHidden;
    if (revealList) this.listHidden = false;
    this.activePane = pane;
    if (revealList) this.applyLayout();
    else this.applyPaneVisibility();
    (pane === "issues" ? this.list : this.detail).focus();
    this.updateFooter();
  }

  private openSearch(previousFocus?: Renderable): void {
    if (this.picker) return;
    this.lastContentFocus = previousFocus ?? (this.detail.focused ? this.detail : this.list.focused ? this.list : this.lastContentFocus ?? this.list);
    this.search.value = this.appliedTitle;
    this.searchOverlay.visible = true;
    this.search.focus();
    this.updateFooter();
  }

  private applySearch(value: string): void {
    const title = value.trim();
    this.searchOverlay.visible = false;
    if (title === this.appliedTitle) { this.activatePane("issues"); this.updateHeader(); return; }
    this.appliedTitle = title; this.activatePane("issues"); this.updateHeader(); void this.refresh();
  }

  private leaveSearch(): void {
    this.search.value = this.appliedTitle;
    this.searchOverlay.visible = false;
    this.activatePane("issues");
    this.updateHeader();
  }

  private updateHeader(): void {
    const team = this.options.meta.teams.find((item) => item.id === this.selectedTeamId);
    const project = this.options.meta.projects.find((item) => item.id === this.selectedProjectId);
    const narrow = this.renderer.terminalWidth < 80;
    const compact = this.renderer.terminalWidth < 56;
    for (const { view } of VIEW_TABS) {
      const active = view === this.view;
      const label = tabLabel(view, compact);
      const text = this.viewTexts[view];
      const tab = this.viewTabs[view];
      text.content = label;
      text.fg = active ? C.base : C.secondary;
      tab.backgroundColor = active ? C.accent : C.surface0;
      tab.width = label.length + 2;
    }
    const teamLabel = chipLabel("team", team?.key ?? "all", compact);
    const projectLabel = chipLabel("project", project?.name ?? "all", compact);
    const sortLabel = chipLabel("sort", TUI_SORT_SHORT[this.sort], compact);
    const searchLabel = this.appliedTitle ? `/${clip(this.appliedTitle, compact ? 6 : 14)}` : "";
    this.teamText.content = teamLabel;
    this.projectText.content = projectLabel;
    this.sortText.content = sortLabel;
    const openLabel = openChipLabel(compact);
    this.teamChip.width = teamLabel.length;
    this.projectChip.width = projectLabel.length;
    this.sortChip.width = sortLabel.length;
    this.openText.content = openLabel;
    this.openChip.width = openLabel.length;
    this.teamChip.visible = !compact;
    this.projectChip.visible = !narrow;
    this.sortChip.visible = !narrow;
    this.openChip.visible = Boolean(this.detailIssueId);
    this.searchStatus.content = searchLabel;
    this.searchStatus.visible = Boolean(this.appliedTitle) && !compact;
    const count = this.store.state.issues.length;
    this.list.title = `${TUI_VIEW_LABELS[this.view]} · ${count}`;
    this.countText.content = this.store.state.kind === "loading" ? "Refreshing…" : `${count}`;
  }

  private setDetailMarkdown(source: string): void {
    this.detailSource = source;
    this.pendingDetailMarkdown = true;
    this.flushDetailMarkdown();
  }

  private flushDetailMarkdown(): void {
    if (this.stopped || this.renderer.isDestroyed) return;
    if (!this.detail.visible || this.detailMarkdown.width < 10) {
      this.pendingDetailMarkdown = true;
      return;
    }
    const width = this.detailMarkdown.width;
    const widthChanged = width !== this.lastMarkdownWidth;
    if (!this.pendingDetailMarkdown && !widthChanged) return;
    this.pendingDetailMarkdown = false;
    this.lastMarkdownWidth = width;
    if (this.detailMarkdown.content !== this.detailSource) {
      this.detailMarkdown.content = this.detailSource;
    } else {
      this.detailMarkdown.clearCache();
    }
    this.detail.scrollTo(0);
  }

  private showIssue(issue: TuiIssue | undefined): void {
    const nextId = issue?.identifier;
    this.setDetailMarkdown(issueDetail(issue));
    this.detail.title = issue?.url ?? nextId ?? "Detail";
    if (nextId !== this.detailIssueId) this.detail.scrollTo(0);
    this.detailIssueId = nextId;
    this.openChip.visible = Boolean(nextId);
  }

  private shownIssue(): TuiIssue | undefined {
    if (!this.detailIssueId) return undefined;
    return this.store.state.issues.find((issue) => issue.identifier === this.detailIssueId);
  }

  openInLinear(): void {
    const issue = this.shownIssue();
    if (!issue) return;
    const remote = this.options.remote ?? isRemoteSession();
    const url = issueOpenUrl(issue.url, remote);
    if (remote && this.options.openExternal === undefined) {
      const copied = (this.options.copyToClipboard ?? ((text: string) => this.renderer.copyToClipboardOSC52(text)))(url);
      if (copied) {
        this.errorMessage = "";
        this.notice = "copied · ctrl-click the https URL to open on this Mac";
        this.updateFooter();
        return;
      }
      this.notice = "";
      this.errorMessage = "Could not copy the Linear URL to this Mac";
      this.updateFooter();
      return;
    }
    void Promise.resolve().then(() => (this.options.openExternal ?? openExternalUrl)(url)).then(() => {
      if (this.stopped || this.renderer.isDestroyed) return;
      this.notice = "";
      if (this.errorMessage.startsWith("Could not open Linear")) {
        this.errorMessage = "";
      }
      this.updateFooter();
    }).catch((error) => {
      if (this.stopped || this.renderer.isDestroyed) return;
      const message = error instanceof Error ? error.message : String(error);
      this.notice = "";
      this.errorMessage = `Could not open Linear: ${message}`;
      this.updateFooter();
    });
  }

  private handleGlobalKey(key: KeyEvent): void {
    if (key.ctrl && key.name === "c") { key.preventDefault(); this.quit(); return; }
    if (this.picker) {
      if ((key.name === "escape" || key.name === "esc")) { key.preventDefault(); this.closePicker(); return; }
      if (this.picker.input.focused && key.name === "down") { key.preventDefault(); this.picker.list.focus(); }
      return;
    }
    if (this.searchOverlay.visible) {
      if ((key.name === "escape" || key.name === "esc")) { key.preventDefault(); this.leaveSearch(); }
      return;
    }
    if (key.name === "escape" || key.name === "esc") {
      key.preventDefault();
      this.activatePane("issues");
      return;
    }
    if (key.name === "tab") {
      key.preventDefault(); this.activatePane(this.activePane === "issues" ? "detail" : "issues"); return;
    }
    if (key.name === "return" || key.name === "enter") {
      if (this.list.focused) { key.preventDefault(); this.openSelectedIssue(); }
      return;
    }
    if (key.name === "z") { key.preventDefault(); this.toggleListPane(); return; }
    if (key.name === "/") { key.preventDefault(); this.openSearch(); return; }
    const viewIndex = VIEW_TABS.find((tab) => tab.key === key.name);
    if (viewIndex) { key.preventDefault(); this.setView(viewIndex.view); return; }
    if (key.name === "t") { key.preventDefault(); this.openPicker("team"); return; }
    if (key.name === "p") { key.preventDefault(); this.openPicker("project"); return; }
    if (key.name === "s") { key.preventDefault(); this.openPicker("sort"); return; }
    if (key.name === "q") { key.preventDefault(); this.quit(); return; }
    if (key.name === "r") { key.preventDefault(); void this.refresh(); return; }
    if (key.name === "o") { key.preventDefault(); this.openInLinear(); return; }
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

  private openSelectedIssue(): void {
    const issue = this.list.getSelectedIssue();
    if (!issue) return;
    this.showIssue(issue);
    this.listHidden = true;
    this.activePane = "detail";
    this.applyLayout();
    this.lastContentFocus = this.detail;
    queueMicrotask(() => {
      if (!this.stopped && !this.renderer.isDestroyed) this.detail.focus();
    });
  }

  private toggleListPane(): void {
    this.listHidden = !this.listHidden;
    if (this.listHidden) {
      this.activePane = "detail";
      this.applyLayout();
      this.detail.focus();
      this.lastContentFocus = this.detail;
      return;
    }
    this.applyLayout();
  }

  private applyLayout(): void {
    const narrow = this.renderer.terminalWidth < 80;
    this.main.flexDirection = "row";
    this.list.width = this.listHidden || narrow ? "100%" : "42%"; this.list.height = "100%";
    this.detail.width = this.listHidden || narrow ? "100%" : "58%"; this.detail.height = "100%";
    this.applyPaneVisibility();
    this.updateHeader(); this.updateFooter();
  }

  private applyPaneVisibility(): void {
    const wasVisible = this.detail.visible;
    if (this.listHidden) {
      this.list.visible = false;
      this.detail.visible = true;
    } else {
      const narrow = this.renderer.terminalWidth < 80;
      this.list.visible = !narrow || this.activePane === "issues";
      this.detail.visible = !narrow || this.activePane === "detail";
    }
    if (this.detail.visible && (!wasVisible || this.listHidden)) {
      this.pendingDetailMarkdown = true;
      this.flushDetailMarkdown();
    }
  }

  private updateFooter(): void {
    if (this.errorMessage) {
      this.footer.content = this.errorMessage;
      this.footer.fg = C.red;
      return;
    }
    if (this.notice) {
      this.footer.content = this.notice;
      this.footer.fg = C.yellow;
      return;
    }
    this.footer.fg = C.muted;
    this.footer.content = footerHint(
      this.listHidden,
      this.renderer.terminalWidth < 80,
      this.searchOverlay.visible,
    );
  }
}
