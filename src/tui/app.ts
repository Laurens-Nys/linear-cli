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
  SelectRenderableEvents,
  SyntaxStyle,
  TextRenderable,
  type SelectOption,
} from "@opentui/core";
import type { CachedProject, CachedTeam, Meta } from "../cache.ts";
import {
  BrowserInput,
  FocusSelect,
  firstTeamState,
  issueTeam,
  priorityLabel,
  TuiActionMenu,
  TuiCommentComposer,
  tuiIssueActions,
  visibleSelectOffset,
  type TuiActionDispatch,
} from "./actions.ts";
import {
  createTuiComment,
  type TuiIssue,
  type TuiIssueQuery,
  TuiIssueStore,
  formatTuiCount,
  isTuiAbortError,
  moveTuiIssue,
  updateTuiIssuePriority,
  TUI_SORT_LABELS,
  TUI_SORT_SHORT,
  TUI_VIEW_LABELS,
  TUI_VIEWS,
  type TuiSort,
  type TuiView,
  type TuiWorkflowStateType,
} from "./data.ts";
import { KanbanBoardEvents, KanbanBoardRenderable, type KanbanDrop, type KanbanState } from "./board.ts";
import { IssueListEvents, IssueListRenderable } from "./issue-list.ts";
import { issueDetail, issueMarkdownRenderNode } from "./markdown.ts";
import { isRemoteSession, issueOpenUrl, openExternalUrl } from "./open.ts";
import { GROK_NIGHT as C, GROK_NIGHT_MARKDOWN } from "./theme.ts";
import {
  openIssueWorktree,
  runWorktreeCommand,
  type WorktreeCommandRunner,
  type WorktreeOpenResult,
} from "./worktree.ts";

export { issueDetail, visibleSelectOffset };
export type PickerKind = "team" | "project" | "sort";
type PickerValue = CachedTeam | CachedProject | { id: TuiSort; name: string } | null;

const VIEW_TABS: { view: TuiView; key: string }[] = TUI_VIEWS.map((view, index) => ({
  view, key: String(index + 1),
}));

export interface TuiAppOptions {
  limit: number;
  meta: Meta;
  initialTeamId?: string;
  onQuit?: () => void;
  remote?: boolean;
  openExternal?: (url: string) => Promise<void> | void;
  copyToClipboard?: (text: string) => boolean;
  moveIssue?: (issueId: string, stateId: string) => Promise<TuiIssue["state"]>;
  updatePriority?: (issueId: string, priority: number) => Promise<number>;
  createComment?: (issueId: string, body: string) => Promise<{ id: string } | void>;
  moveNoticeDurationMs?: number;
  undoDurationMs?: number;
  backgroundRefreshMs?: number;
  worktreeRepo?: string;
  worktreeAgent?: string;
  worktreeHome?: string;
  worktreeEnv?: NodeJS.ProcessEnv;
  runWorktreeCommand?: WorktreeCommandRunner;
  openWorktree?: (issue: TuiIssue) => Promise<WorktreeOpenResult>;
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

export function layoutChipLabel(layout: "list" | "board", compact: boolean): string {
  if (compact) return layout === "list" ? "Board" : "List";
  return layout === "list" ? "Board view" : "List view";
}

export function footerHint(
  listHidden: boolean,
  compact: boolean,
  searching = false,
  layout: "list" | "board" = "list",
): string {
  if (searching) return "enter apply  ·  esc cancel";
  if (listHidden) {
    return compact ? "esc back  ·  q quit" : "esc back  ·  / search  ·  a actions  ·  r refresh  ·  q quit";
  }
  if (layout === "board") {
    return compact ? "drag move  ·  b list  ·  q quit" : "drag move  ·  click open  ·  a actions  ·  b list  ·  / search  ·  r refresh  ·  q quit";
  }
  return compact ? "/ search  ·  q quit" : "/ search  ·  a actions  ·  r refresh  ·  q quit";
}

export class TuiApp {
  readonly root: BoxRenderable;
  readonly header: BoxRenderable;
  readonly viewTabs: Record<TuiView, BoxRenderable>;
  readonly viewTexts: Record<TuiView, TextRenderable>;
  readonly teamChip: BoxRenderable;
  readonly projectChip: BoxRenderable;
  readonly sortChip: BoxRenderable;
  readonly layoutChip: BoxRenderable;
  readonly openChip: BoxRenderable;
  readonly teamText: TextRenderable;
  readonly projectText: TextRenderable;
  readonly sortText: TextRenderable;
  readonly layoutText: TextRenderable;
  readonly openText: TextRenderable;
  readonly searchStatus: TextRenderable;
  readonly countText: TextRenderable;
  readonly search: BrowserInput;
  readonly list: IssueListRenderable;
  readonly board: KanbanBoardRenderable;
  readonly detail: ScrollBoxRenderable;
  readonly detailMarkdown: MarkdownRenderable;
  readonly footer: TextRenderable;
  private readonly main: BoxRenderable;
  private readonly tabs: BoxRenderable;
  private readonly searchOverlay: BoxRenderable;
  private readonly syntaxStyle: SyntaxStyle;
  private detailSource = "Loading…";
  private stopped = false;
  private generation = 0;
  private detailGeneration = 0;
  private selectedTeamId: string | undefined;
  private selectedProjectId: string | undefined;
  private sort: TuiSort = "updated";
  private view: TuiView = "all";
  private layout: "list" | "board" = "list";
  private activePane: "issues" | "detail" = "issues";
  private listHidden = false;
  private appliedTitle = "";
  private detailIssueId: string | undefined;
  private reconcilingIssues = false;
  private errorMessage = "";
  private notice = "";
  private pendingDetailMarkdown = false;
  private pendingMove = false;
  private pendingWorktree = false;
  private boardQueryKey: string | undefined;
  private dragHint = "";
  private moveNoticeTimer: ReturnType<typeof setTimeout> | undefined;
  private undoTimer: ReturnType<typeof setTimeout> | undefined;
  private backgroundTimer: ReturnType<typeof setInterval> | undefined;
  private refreshInFlight = false;
  private refreshToken = 0;
  private offline = false;
  private undo: { issue: TuiIssue; currentStateId: string } | undefined;
  private lastMarkdownWidth = 0;
  private preserveDetailScroll = false;
  private lastContentFocus?: Renderable;
  private picker?: {
    kind: PickerKind;
    overlay: BoxRenderable;
    input: InputRenderable;
    list: FocusSelect;
    all: SelectOption[];
    previousFocus: Renderable;
  };
  private actions?: { menu: TuiActionMenu; previousFocus: Renderable };
  private comment?: { composer: TuiCommentComposer; previousFocus: Renderable };

  constructor(
    private readonly renderer: CliRenderer,
    private readonly store: TuiIssueStore,
    private readonly options: TuiAppOptions,
  ) {
    this.selectedTeamId = options.initialTeamId;

    this.header = new BoxRenderable(renderer, {
      id: "tui-header", width: "100%", height: 1, flexDirection: "row", gap: 2,
      backgroundColor: "transparent", paddingX: 1,
    });
    this.tabs = new BoxRenderable(renderer, {
      id: "tui-tabs", height: 1, flexDirection: "row", gap: 1, backgroundColor: "transparent",
    });
    this.viewTabs = {} as Record<TuiView, BoxRenderable>;
    this.viewTexts = {} as Record<TuiView, TextRenderable>;
    for (const { view } of VIEW_TABS) {
      const [tab, text] = this.makeViewTab(view);
      this.viewTabs[view] = tab;
      this.viewTexts[view] = text;
      this.tabs.add(tab);
    }
    this.header.add(this.tabs);
    [this.teamChip, this.teamText] = this.makeChip("team");
    [this.projectChip, this.projectText] = this.makeChip("project");
    [this.sortChip, this.sortText] = this.makeChip("sort");
    [this.layoutChip, this.layoutText] = this.makeLayoutChip();
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
    this.header.add(this.layoutChip);
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
    this.board = new KanbanBoardRenderable(renderer);
    this.board.visible = false;

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
    this.main.add(this.list); this.main.add(this.board); this.main.add(this.detail);

    this.footer = new TextRenderable(renderer, {
      id: "tui-footer", height: 1, fg: C.secondary, selectable: false, content: "",
      onMouseDown: (event) => {
        if (this.canClickUndo()) { void this.undoMove(); event.preventDefault(); }
      },
      onMouseOver: () => { if (this.canClickUndo()) this.renderer.setMousePointer("pointer"); },
      onMouseOut: () => this.renderer.setMousePointer("default"),
    });
    const topSpacer = new BoxRenderable(renderer, {
      id: "tui-top-spacer", width: "100%", height: 1, flexShrink: 0, backgroundColor: "transparent",
    });
    this.root = new BoxRenderable(renderer, {
      id: "tui-root", width: "100%", height: "100%", flexDirection: "column",
      backgroundColor: "transparent",
    });
    this.root.add(topSpacer); this.root.add(this.header); this.root.add(this.main); this.root.add(this.footer); this.root.add(this.searchOverlay);

    this.list.on(IssueListEvents.ITEM_ACTIVATED, (issue: TuiIssue | undefined) => {
      if (!this.reconcilingIssues) this.showIssue(issue);
    });
    this.list.on(IssueListEvents.ITEM_OPENED, () => this.openSelectedIssue());
    this.list.on(IssueListEvents.ITEM_ACTIONED, (issue: TuiIssue) => this.openActions(issue));
    this.board.on(KanbanBoardEvents.ITEM_OPENED, (issue: TuiIssue) => this.openIssue(issue));
    this.board.on(KanbanBoardEvents.ITEM_ACTIONED, (issue: TuiIssue) => this.openActions(issue));
    this.board.on(KanbanBoardEvents.ISSUE_DROPPED, (drop: KanbanDrop) => { void this.moveBoardIssue(drop); });
    this.board.on(KanbanBoardEvents.DRAG_TARGET_CHANGED, (drop: KanbanDrop | undefined) => {
      this.dragHint = drop ? `Move ${drop.issue.identifier} to ${drop.state.name}` : "";
      this.updateFooter();
    });
    this.list.on(RenderableEvents.FOCUSED, () => {
      this.activePane = "issues"; this.applyPaneVisibility();
      this.lastContentFocus = this.list; this.updateFooter();
    });
    this.list.on(RenderableEvents.BLURRED, () => this.updateFooter());
    this.board.on(RenderableEvents.FOCUSED, () => {
      this.activePane = "issues"; this.applyPaneVisibility();
      this.lastContentFocus = this.board; this.updateFooter();
    });
    this.board.on(RenderableEvents.BLURRED, () => this.updateFooter());
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
  private isBusy(): boolean {
    return this.pendingMove || this.pendingWorktree;
  }

  private worktreeConfigured(): boolean {
    return Boolean(this.options.worktreeRepo || this.options.openWorktree);
  }

  start(): void {
    this.mount();
    this.scheduleBackgroundRefresh();
    void this.refresh();
  }

  currentQuery(): TuiIssueQuery {
    return {
      limit: this.options.limit, teamId: this.selectedTeamId, projectId: this.selectedProjectId,
      title: this.appliedTitle || undefined, sort: this.sort, view: this.view, layout: this.layout,
    };
  }

  async refresh(options?: { quiet?: boolean }): Promise<void> {
    const quiet = options?.quiet === true;
    if (this.isBusy()) return;
    if (quiet && (this.refreshInFlight || this.shouldSkipQuietRefresh())) return;
    const token = ++this.refreshToken;
    this.refreshInFlight = true;
    const generation = ++this.generation;
    const query = { ...this.currentQuery() };
    const boardKey = this.layout === "board" ? this.boardScopeKey(query) : undefined;
    if (this.layout === "board" && !this.selectedTeamId) {
      this.store.abort();
      this.board.setBoard([], []);
      this.board.setInteractive(false);
      this.boardQueryKey = undefined;
      if (this.refreshToken === token) this.refreshInFlight = false;
      this.updateHeader();
      return;
    }
    if (!quiet) {
      if (this.layout === "board") {
        if (boardKey !== this.boardQueryKey) this.board.setBoard(this.selectedTeam()?.states ?? [], []);
        this.board.setInteractive(false);
      }
      this.store.loading();
      this.errorMessage = "";
      this.updateHeader();
      this.updateFooter();
    }
    try {
      const page = await this.store.load(query);
      if (generation !== this.generation || this.stopped || this.renderer.isDestroyed) return;
      if (quiet && this.shouldSkipQuietRefresh()) return;
      const boardScroll = quiet && this.layout === "board" ? this.board.captureScrollState() : undefined;
      const state = this.store.ready(page);
      const currentId = (this.layout === "board" ? this.board.getSelectedIssue() : this.list.getSelectedIssue())?.identifier;
      const selectedId = currentId && state.issues.some((issue) => issue.identifier === currentId)
        ? currentId
        : undefined;
      this.renderIssues(state.issues, selectedId, { preserveScroll: quiet });
      if (boardScroll) this.board.restoreScrollState(boardScroll);
      if (this.layout === "board") {
        this.boardQueryKey = boardKey;
        this.board.setInteractive(true);
      }
      this.offline = false;
      if (this.errorMessage.startsWith("Could not refresh")) this.errorMessage = "";
      if (state.issues.length === 0) {
        this.detailGeneration += 1;
        this.store.abortDetail();
        this.detailIssueId = undefined;
        this.setDetailMarkdown("No issues match this view.");
        this.detail.title = "Detail";
        this.openChip.visible = false;
      } else {
        const openIssue = this.detailIssueId
          ? state.issues.find((issue) => issue.identifier === this.detailIssueId)
          : undefined;
        this.showIssue(openIssue ?? (this.layout === "board" ? this.board.getSelectedIssue() : this.list.getSelectedIssue()));
      }
      this.updateHeader();
      this.updateFooter();
    } catch (error) {
      if (isTuiAbortError(error) || generation !== this.generation || this.stopped || this.renderer.isDestroyed) return;
      if (quiet) {
        this.offline = true;
        this.updateFooter();
        return;
      }
      const state = this.store.error(error);
      const message = state.kind === "error" ? state.message : String(error);
      this.errorMessage = `Could not refresh: ${message}  ·  press r to retry`;
      this.countText.fg = C.red;
      if (this.layout === "board") this.board.setInteractive(false);
      if (state.issues.length === 0) {
        this.detailGeneration += 1;
        this.store.abortDetail();
        this.detailIssueId = undefined;
        this.setDetailMarkdown("Could not load issues. Press r to retry.");
        this.detail.title = "Detail";
        this.openChip.visible = false;
      }
      this.updateHeader();
      this.updateFooter();
    } finally {
      if (this.refreshToken === token) this.refreshInFlight = false;
    }
  }

  quit(): void {
    if (this.stopped) return;
    this.stopped = true; this.generation += 1; this.detailGeneration += 1;
    this.store.abort();
    this.refreshToken += 1;
    this.refreshInFlight = false;
    if (this.moveNoticeTimer) clearTimeout(this.moveNoticeTimer);
    if (this.undoTimer) clearTimeout(this.undoTimer);
    if (this.backgroundTimer) clearInterval(this.backgroundTimer);
    this.moveNoticeTimer = undefined;
    this.undoTimer = undefined;
    this.backgroundTimer = undefined;
    this.undo = undefined;
    this.actions?.menu.destroy();
    this.actions = undefined;
    this.comment?.composer.destroy();
    this.comment = undefined;
    this.options.onQuit?.();
  }

  openPicker(kind: PickerKind, previousFocus?: Renderable): void {
    if (this.isBusy() || this.picker || this.searchOverlay.visible || this.actions || this.comment) return;
    const primary = this.primaryPane();
    const restoreFocus: Renderable = previousFocus ?? (this.detail.focused ? this.detail : this.search.focused ? this.search : primary.focused ? primary : this.lastContentFocus ?? primary);
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

  openActions(issue?: TuiIssue, previousFocus?: Renderable): void {
    this.openActionMenu(issue ?? this.actionTarget(), previousFocus, false);
  }

  openPalette(previousFocus?: Renderable): void {
    this.openActionMenu(this.actionTarget(), previousFocus, true);
  }

  private openActionMenu(issue: TuiIssue | undefined, previousFocus: Renderable | undefined, includeIssues: boolean): void {
    if (this.isBusy() || this.picker || this.searchOverlay.visible || this.actions || this.comment) return;
    const target = issue;
    if (!target) return;
    const primary = this.primaryPane();
    const restoreFocus: Renderable = previousFocus ?? (this.detail.focused ? this.detail : primary.focused ? primary : this.lastContentFocus ?? primary);
    this.lastContentFocus = restoreFocus;
    if (this.layout === "list") this.showIssue(target);
    const menu = new TuiActionMenu(this.renderer, this.root, target, {
      items: tuiIssueActions(target, issueTeam(this.options.meta, target), { worktree: this.worktreeConfigured() }),
      issues: includeIssues ? this.store.state.issues : undefined,
      onCommit: (dispatch) => this.commitAction(dispatch),
      onClose: () => this.closeActions(),
    });
    this.actions = { menu, previousFocus: restoreFocus };
  }

  closeActions(): void {
    const actions = this.actions;
    if (!actions) return;
    this.actions = undefined;
    actions.menu.destroy();
    queueMicrotask(() => {
      if (this.stopped || this.renderer.isDestroyed || this.actions || this.comment || this.picker) return;
      actions.previousFocus.focus();
      this.renderer.focusRenderable(actions.previousFocus);
    });
  }

  private primaryPane(): IssueListRenderable | KanbanBoardRenderable {
    return this.layout === "board" ? this.board : this.list;
  }

  private selectedTeam(): CachedTeam | undefined {
    return this.options.meta.teams.find((team) => team.id === this.selectedTeamId);
  }

  private boardScopeKey(query: TuiIssueQuery): string {
    return JSON.stringify({
      limit: query.limit,
      teamId: query.teamId,
      projectId: query.projectId,
      title: query.title,
      sort: query.sort,
      layout: "board",
    });
  }

  private renderIssues(issues: readonly TuiIssue[], selectedIdentifier?: string, options?: { preserveScroll?: boolean }): void {
    this.reconcilingIssues = true;
    this.list.setIssues(issues, selectedIdentifier, options);
    if (this.layout === "board") {
      this.board.setBoard(this.selectedTeam()?.states ?? [], issues, selectedIdentifier);
    }
    this.reconcilingIssues = false;
  }

  private toggleLayout(): void {
    if (this.isBusy()) return;
    this.layout = this.layout === "list" ? "board" : "list";
    this.listHidden = false;
    this.activePane = "issues";
    this.applyLayout();
    const primary = this.primaryPane();
    this.lastContentFocus = primary;
    primary.focus();
    void this.refresh();
  }

  private async moveBoardIssue({ issue, state }: KanbanDrop): Promise<void> {
    await this.moveIssueToState(issue, state);
  }

  private async moveIssueToState(issue: TuiIssue, state: KanbanState, options?: { undo?: boolean }): Promise<void> {
    if (this.isBusy() || issue.state.id === state.id) return;
    const current = this.store.state.issues.find((item) => item.id === issue.id);
    if (!current) return;
    const reversing = options?.undo === true;
    const onBoard = this.layout === "board";
    const scrollSnapshot = onBoard ? this.board.captureScrollState() : undefined;
    this.pendingMove = true;
    this.store.abortList();
    this.generation += 1;
    if (this.moveNoticeTimer) clearTimeout(this.moveNoticeTimer);
    this.moveNoticeTimer = undefined;
    if (!reversing) this.discardUndo();
    this.notice = reversing
      ? `Restoring ${issue.identifier}…`
      : `Moving ${issue.identifier} to ${state.name}…`;
    this.errorMessage = "";
    const optimistic: TuiIssue = {
      ...current,
      state: {
        id: state.id,
        name: state.name,
        color: state.color ?? "",
        type: state.type,
      },
    };
    this.store.replace(optimistic);
    this.renderIssues(this.store.state.issues, issue.identifier);
    if (onBoard) this.board.setMoving(issue.identifier);
    if (this.detailIssueId === issue.identifier) this.showIssue(optimistic);
    this.updateHeader(); this.updateFooter();
    try {
      const movedState = await (this.options.moveIssue ?? moveTuiIssue)(issue.id, state.id);
      if (this.stopped || this.renderer.isDestroyed) return;
      const moved = { ...optimistic, state: movedState };
      this.store.replace(moved);
      this.renderIssues(this.store.state.issues, issue.identifier);
      if (this.detailIssueId === issue.identifier) this.showIssue(moved);
      if (reversing) {
        this.undo = undefined;
        this.showMoveConfirmation(`Restored ${issue.identifier}`);
      } else {
        this.armUndo(current, moved);
      }
    } catch (error) {
      if (this.stopped || this.renderer.isDestroyed) return;
      this.store.replace(current);
      this.renderIssues(this.store.state.issues, issue.identifier);
      if (scrollSnapshot) this.board.restoreScrollState(scrollSnapshot);
      if (this.detailIssueId === issue.identifier) this.showIssue(current);
      const message = error instanceof Error ? error.message : String(error);
      this.notice = "";
      if (reversing) this.undo = undefined;
      this.errorMessage = reversing
        ? `Could not undo ${issue.identifier}: ${message}`
        : `Could not move ${issue.identifier}: ${message}`;
    } finally {
      this.pendingMove = false;
      if (!this.stopped && !this.renderer.isDestroyed) {
        if (onBoard) this.board.setMoving();
        this.updateHeader(); this.updateFooter();
      }
    }
  }

  private showMoveConfirmation(message: string): void {
    if (this.moveNoticeTimer) clearTimeout(this.moveNoticeTimer);
    this.notice = message;
    const duration = this.options.moveNoticeDurationMs ?? 1200;
    this.moveNoticeTimer = setTimeout(() => {
      this.moveNoticeTimer = undefined;
      if (this.notice === message) this.notice = "";
      if (!this.stopped && !this.renderer.isDestroyed) this.updateFooter();
    }, duration);
  }

  private undoNotice(issue: TuiIssue): string {
    return `Moved ${issue.identifier} to ${issue.state.name} · u undo`;
  }

  private canClickUndo(): boolean {
    return this.undo !== undefined && this.notice.includes("u undo") && !this.isBusy();
  }

  private clearUndoTimer(): void {
    if (this.undoTimer) clearTimeout(this.undoTimer);
    this.undoTimer = undefined;
  }

  private discardUndo(): void {
    this.clearUndoTimer();
    this.undo = undefined;
  }

  private armUndo(previous: TuiIssue, moved: TuiIssue): void {
    this.clearUndoTimer();
    this.undo = { issue: previous, currentStateId: moved.state.id };
    const message = this.undoNotice(moved);
    this.notice = message;
    this.errorMessage = "";
    this.undoTimer = setTimeout(() => {
      this.undoTimer = undefined;
      if (this.undo?.issue.id === previous.id && this.undo.currentStateId === moved.state.id) {
        this.undo = undefined;
      }
      if (this.notice === message) this.notice = "";
      if (!this.stopped && !this.renderer.isDestroyed) this.updateFooter();
    }, this.options.undoDurationMs ?? 8000);
  }

  private async undoMove(): Promise<void> {
    const snapshot = this.undo;
    if (!snapshot || this.isBusy()) return;
    const current = this.store.state.issues.find((item) => item.id === snapshot.issue.id);
    if (!current || current.state.id !== snapshot.currentStateId) {
      this.undo = undefined;
      this.clearUndoTimer();
      this.notice = "";
      this.errorMessage = `Could not undo ${snapshot.issue.identifier}: state changed`;
      this.updateFooter();
      return;
    }
    this.undo = undefined;
    this.clearUndoTimer();
    await this.moveIssueToState(current, {
      id: snapshot.issue.state.id,
      name: snapshot.issue.state.name,
      type: snapshot.issue.state.type,
      position: 0,
      color: snapshot.issue.state.color,
    }, { undo: true });
  }

  private shouldSkipQuietRefresh(): boolean {
    return this.isBusy()
      || this.undo !== undefined
      || this.picker !== undefined
      || this.actions !== undefined
      || this.comment !== undefined
      || this.searchOverlay.visible
      || this.board.isDragging;
  }

  private scheduleBackgroundRefresh(): void {
    const ms = this.options.backgroundRefreshMs ?? 30_000;
    if (ms <= 0) return;
    this.backgroundTimer = setInterval(() => { void this.refresh({ quiet: true }); }, ms);
  }

  private selectAndOpenIssue(identifier: string): void {
    const issue = this.store.state.issues.find((item) => item.identifier === identifier);
    if (!issue) return;
    this.list.selectIdentifier(identifier);
    this.board.selectIdentifier(identifier);
    if (this.layout === "board" || this.listHidden || this.renderer.terminalWidth < 80) {
      this.openIssue(issue);
      return;
    }
    this.showIssue(issue);
  }

  private makeViewTab(view: TuiView): [BoxRenderable, TextRenderable] {
    const label = tabLabel(view, false);
    const text = new TextRenderable(this.renderer, {
      id: `tui-view-${view}-text`, content: label, fg: C.secondary, selectable: false,
    });
    const tab = new BoxRenderable(this.renderer, {
      id: `tui-view-${view}`, height: 1, width: label.length + 2, paddingX: 1,
      backgroundColor: "transparent", shouldFill: true,
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
      id: `tui-${kind}-chip`, height: 1, backgroundColor: "transparent",
      onMouseDown: (event) => {
        const previousFocus = this.detail.focused ? this.detail : this.primaryPane();
        this.openPicker(kind, previousFocus);
        event.preventDefault();
      },
      onMouseOver: () => this.renderer.setMousePointer("pointer"),
      onMouseOut: () => this.renderer.setMousePointer("default"),
    });
    chip.add(text); return [chip, text];
  }

  private makeLayoutChip(): [BoxRenderable, TextRenderable] {
    const text = new TextRenderable(this.renderer, {
      id: "tui-layout-text", content: layoutChipLabel("list", false), fg: C.blue, selectable: false,
    });
    const chip = new BoxRenderable(this.renderer, {
      id: "tui-layout-chip", height: 1, backgroundColor: "transparent",
      onMouseDown: (event) => { this.toggleLayout(); event.preventDefault(); },
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
      id: "tui-open-chip", height: 1, backgroundColor: "transparent",
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
    if (this.isBusy()) return;
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
    (pane === "issues" ? this.primaryPane() : this.detail).focus();
    this.updateFooter();
  }

  private openSearch(previousFocus?: Renderable): void {
    if (this.isBusy() || this.picker || this.actions || this.comment) return;
    const primary = this.primaryPane();
    this.lastContentFocus = previousFocus ?? (this.detail.focused ? this.detail : primary.focused ? primary : this.lastContentFocus ?? primary);
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
      tab.backgroundColor = active ? C.accent : "transparent";
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
    this.teamChip.visible = this.layout === "board" || !compact;
    this.projectChip.visible = !narrow;
    this.sortChip.visible = !narrow;
    this.openChip.visible = Boolean(this.detailIssueId) && !(this.layout === "board" && !this.selectedTeamId);
    this.searchStatus.content = searchLabel;
    this.searchStatus.visible = Boolean(this.appliedTitle) && !compact;
    this.tabs.visible = this.layout === "list";
    const layoutLabel = layoutChipLabel(this.layout, compact);
    this.layoutText.content = layoutLabel;
    this.layoutChip.width = layoutLabel.length;
    const count = this.countLabel();
    this.list.title = `${TUI_VIEW_LABELS[this.view]} · ${this.listTitleCount()}`;
    this.countText.content = count;
    this.countText.fg = this.store.state.kind === "error" ? C.red
      : this.store.state.kind === "loading" ? C.secondary
      : C.muted;
  }

  private countLabel(): string {
    if (this.layout === "board" && !this.selectedTeamId) return "Choose team";
    if (this.store.state.kind === "loading") return "Refreshing…";
    if (this.store.state.kind === "error" && this.store.state.issues.length === 0) return "unavailable";
    return formatTuiCount(this.store.state.issues.length, this.store.state.totalCount, this.store.state.pageInfo);
  }

  private listTitleCount(): string {
    if (this.layout === "board" && !this.selectedTeamId) return "0";
    if (this.store.state.kind === "error" && this.store.state.issues.length === 0) return "unavailable";
    if (this.store.state.kind === "loading" && this.store.state.issues.length === 0) return "…";
    return formatTuiCount(this.store.state.issues.length, this.store.state.totalCount, this.store.state.pageInfo);
  }

  private setDetailMarkdown(source: string, options?: { preserveScroll?: boolean }): void {
    this.detailSource = source;
    this.pendingDetailMarkdown = true;
    this.preserveDetailScroll = options?.preserveScroll === true;
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
    if (!this.preserveDetailScroll) this.detail.scrollTo(0);
  }

  private clearDetailLoadError(): void {
    if (!this.errorMessage.startsWith("Could not load ")) return;
    this.errorMessage = "";
    this.updateFooter();
  }

  private showIssue(issue: TuiIssue | undefined): void {
    const nextId = issue?.identifier;
    if (!issue) {
      this.detailGeneration += 1;
      this.store.abortDetail();
      this.setDetailMarkdown(issueDetail(undefined));
      this.detail.title = "Detail";
      this.detailIssueId = undefined;
      this.openChip.visible = false;
      return;
    }
    const sameIssue = nextId === this.detailIssueId;
    const fresh = this.store.peekDetail(issue);
    const cached = fresh ?? this.store.peekCachedDetail(issue);
    if (fresh) {
      this.detailGeneration += 1;
      this.store.abortDetail();
      this.clearDetailLoadError();
      this.setDetailMarkdown(issueDetail(issue, fresh), { preserveScroll: sameIssue });
    } else if (this.store.canLoadDetail) {
      if (cached) {
        this.setDetailMarkdown(issueDetail(issue, cached), { preserveScroll: sameIssue });
      } else {
        this.setDetailMarkdown(issueDetail(issue, "loading"), { preserveScroll: sameIssue });
      }
      void this.loadShownDetail(issue);
    } else {
      this.detailGeneration += 1;
      this.store.abortDetail();
      this.setDetailMarkdown(issueDetail(issue), { preserveScroll: sameIssue });
    }
    this.detail.title = issue.url ?? nextId ?? "Detail";
    if (!sameIssue) this.detail.scrollTo(0);
    this.detailIssueId = nextId;
    this.openChip.visible = Boolean(nextId);
  }

  private async loadShownDetail(issue: TuiIssue): Promise<void> {
    this.clearDetailLoadError();
    const generation = ++this.detailGeneration;
    try {
      const detail = await this.store.loadDetail(issue);
      if (generation !== this.detailGeneration || this.stopped || this.renderer.isDestroyed) return;
      if (this.detailIssueId !== issue.identifier) return;
      const current = this.store.state.issues.find((item) => item.id === issue.id) ?? issue;
      this.clearDetailLoadError();
      this.setDetailMarkdown(issueDetail(current, detail), { preserveScroll: true });
    } catch (error) {
      if (isTuiAbortError(error) || generation !== this.detailGeneration || this.stopped || this.renderer.isDestroyed) {
        return;
      }
      if (this.detailIssueId !== issue.identifier) return;
      const message = error instanceof Error ? error.message : String(error);
      this.errorMessage = `Could not load ${issue.identifier}: ${message}`;
      if (!this.store.peekCachedDetail(issue)) {
        this.setDetailMarkdown(issueDetail(issue, { error: message }));
      }
      this.updateFooter();
    }
  }

  private shownIssue(): TuiIssue | undefined {
    if (!this.detailIssueId) return undefined;
    return this.store.state.issues.find((issue) => issue.identifier === this.detailIssueId);
  }

  private actionTarget(): TuiIssue | undefined {
    if (this.primaryPane().focused) return this.primaryPane().getSelectedIssue() ?? this.shownIssue();
    return this.shownIssue() ?? this.primaryPane().getSelectedIssue();
  }

  private commitAction(dispatch: TuiActionDispatch): void {
    if (dispatch.type === "priority-menu") {
      this.actions?.menu.showPriority();
      return;
    }
    if (dispatch.type === "select-issue") {
      this.closeActions();
      this.selectAndOpenIssue(dispatch.identifier);
      return;
    }
    const issue = this.actions?.menu.issue;
    const previousFocus = this.actions?.previousFocus;
    this.closeActions();
    if (!issue) return;
    if (dispatch.type === "open") this.openInLinear(issue);
    else if (dispatch.type === "worktree") void this.openAsWorktree(issue);
    else if (dispatch.type === "copy-id") this.copyText(issue.identifier, `copied ${issue.identifier}`);
    else if (dispatch.type === "copy-url") this.copyText(issue.url, "copied URL");
    else if (dispatch.type === "start") this.moveToType(issue, "started");
    else if (dispatch.type === "done") this.moveToType(issue, "completed");
    else if (dispatch.type === "priority") void this.setPriority(issue, dispatch.priority);
    else if (dispatch.type === "comment") this.openComment(issue, previousFocus);
  }

  private copyText(text: string, success: string): void {
    const copied = (this.options.copyToClipboard ?? ((value: string) => this.renderer.copyToClipboardOSC52(value)))(text);
    if (copied) {
      this.errorMessage = "";
      this.notice = success;
    } else {
      this.notice = "";
      this.errorMessage = "Could not copy to this Mac";
    }
    this.updateFooter();
  }

  private async openAsWorktree(issue: TuiIssue): Promise<void> {
    if (this.isBusy()) return;
    this.pendingWorktree = true;
    this.notice = `Opening worktree for ${issue.identifier}…`;
    this.errorMessage = "";
    this.updateFooter();
    try {
      const result = await (this.options.openWorktree ?? ((target) => openIssueWorktree({
        identifier: target.identifier,
        title: target.title,
        branchName: target.branchName,
        repo: this.options.worktreeRepo ?? "",
        agent: this.options.worktreeAgent ?? "",
        env: this.options.worktreeEnv ?? process.env,
        home: this.options.worktreeHome,
        run: this.options.runWorktreeCommand ?? runWorktreeCommand,
      })))(issue);
      if (this.stopped || this.renderer.isDestroyed) return;
      this.errorMessage = "";
      this.showMoveConfirmation(result.reused
        ? `Focused existing ${issue.identifier} worktree`
        : `Opened ${issue.identifier} as worktree`);
    } catch (error) {
      if (this.stopped || this.renderer.isDestroyed) return;
      const message = error instanceof Error ? error.message : String(error);
      this.notice = "";
      this.errorMessage = `Could not open worktree for ${issue.identifier}: ${message}`;
    } finally {
      this.pendingWorktree = false;
      if (!this.stopped && !this.renderer.isDestroyed) this.updateFooter();
    }
  }

  private moveToType(issue: TuiIssue, type: TuiWorkflowStateType): void {
    const current = this.store.state.issues.find((item) => item.id === issue.id) ?? issue;
    const state = firstTeamState(issueTeam(this.options.meta, current), type);
    if (!state) {
      this.notice = "";
      this.errorMessage = `No ${type} state on ${current.team.key}`;
      this.updateFooter();
      return;
    }
    void this.moveIssueToState(current, {
      id: state.id,
      name: state.name,
      type,
      position: state.position,
      color: state.color,
    });
  }

  private async setPriority(issue: TuiIssue, priority: number): Promise<void> {
    if (this.isBusy()) return;
    this.discardUndo();
    const current = this.store.state.issues.find((item) => item.id === issue.id);
    if (!current) return;
    this.pendingMove = true;
    this.store.abortList();
    this.generation += 1;
    if (this.moveNoticeTimer) clearTimeout(this.moveNoticeTimer);
    this.moveNoticeTimer = undefined;
    this.notice = `Setting ${issue.identifier} to ${priorityLabel(priority)}…`;
    this.errorMessage = "";
    const optimistic = { ...current, priority };
    this.store.replace(optimistic);
    this.renderIssues(this.store.state.issues, issue.identifier);
    if (this.detailIssueId === issue.identifier) this.showIssue(optimistic);
    this.updateHeader(); this.updateFooter();
    try {
      const next = await (this.options.updatePriority ?? updateTuiIssuePriority)(issue.id, priority);
      if (this.stopped || this.renderer.isDestroyed) return;
      const updated = { ...optimistic, priority: next };
      this.store.replace(updated);
      this.renderIssues(this.store.state.issues, issue.identifier);
      if (this.detailIssueId === issue.identifier) this.showIssue(updated);
      this.showMoveConfirmation(`${issue.identifier} set to ${priorityLabel(next)}`);
    } catch (error) {
      if (this.stopped || this.renderer.isDestroyed) return;
      this.store.replace(current);
      this.renderIssues(this.store.state.issues, issue.identifier);
      if (this.detailIssueId === issue.identifier) this.showIssue(current);
      const message = error instanceof Error ? error.message : String(error);
      this.notice = "";
      this.errorMessage = `Could not set priority on ${issue.identifier}: ${message}`;
    } finally {
      this.pendingMove = false;
      if (!this.stopped && !this.renderer.isDestroyed) {
        this.updateHeader(); this.updateFooter();
      }
    }
  }

  private openComment(issue: TuiIssue, previousFocus?: Renderable): void {
    if (this.isBusy() || this.picker || this.searchOverlay.visible || this.actions || this.comment) return;
    const primary = this.primaryPane();
    const restoreFocus: Renderable = previousFocus ?? (this.detail.focused ? this.detail : primary.focused ? primary : this.lastContentFocus ?? primary);
    this.lastContentFocus = restoreFocus;
    const composer = new TuiCommentComposer(this.renderer, this.root, issue, {
      onSubmit: (body) => { void this.submitComment(body); },
      onClose: () => this.closeComment(),
    });
    this.comment = { composer, previousFocus: restoreFocus };
  }

  private closeComment(): void {
    const comment = this.comment;
    if (!comment || comment.composer.isSaving) return;
    this.comment = undefined;
    comment.composer.destroy();
    queueMicrotask(() => {
      if (!this.stopped && !this.renderer.isDestroyed) {
        comment.previousFocus.focus();
        this.renderer.focusRenderable(comment.previousFocus);
      }
    });
  }

  private async submitComment(raw: string): Promise<void> {
    const composer = this.comment?.composer;
    if (!composer || composer.isSaving) return;
    const body = raw.trim();
    if (body === "") {
      composer.setError("Comment cannot be empty");
      return;
    }
    const issue = this.store.state.issues.find((item) => item.id === composer.issue.id) ?? composer.issue;
    composer.setSaving();
    this.discardUndo();
    this.pendingMove = true;
    this.errorMessage = "";
    this.notice = "";
    this.updateFooter();
    try {
      await (this.options.createComment ?? createTuiComment)(issue.id, body);
      if (this.stopped || this.renderer.isDestroyed) return;
      this.store.markDetailStale(issue.id);
      const restore = this.comment?.previousFocus ?? this.lastContentFocus;
      this.comment = undefined;
      composer.destroy();
      queueMicrotask(() => {
        if (!this.stopped && !this.renderer.isDestroyed && restore) {
          restore.focus();
          this.renderer.focusRenderable(restore);
        }
      });
      this.errorMessage = "";
      this.showMoveConfirmation(`Commented on ${issue.identifier}`);
      if (this.detailIssueId === issue.identifier) void this.loadShownDetail(issue);
    } catch (error) {
      if (this.stopped || this.renderer.isDestroyed) return;
      const message = error instanceof Error ? error.message : String(error);
      composer.setError(`Could not comment: ${message}`);
      this.notice = "";
      this.errorMessage = `Could not comment on ${issue.identifier}: ${message}`;
      this.updateFooter();
    } finally {
      this.pendingMove = false;
      if (!this.stopped && !this.renderer.isDestroyed) {
        this.updateHeader(); this.updateFooter();
      }
    }
  }

  openInLinear(issue = this.shownIssue()): void {
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
    if (this.comment) {
      if ((key.name === "escape" || key.name === "esc") && !this.comment.composer.isSaving) {
        key.preventDefault(); this.closeComment();
      }
      return;
    }
    if (this.actions) {
      if ((key.name === "escape" || key.name === "esc")) { key.preventDefault(); this.actions.menu.handleEscape(); return; }
      if (this.actions.menu.input.focused && key.name === "down") { key.preventDefault(); this.actions.menu.list.focus(); }
      return;
    }
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
      key.preventDefault();
      if (this.layout === "board" && !this.listHidden) { this.board.focus(); return; }
      this.activatePane(this.activePane === "issues" ? "detail" : "issues"); return;
    }
    if (key.name === "return" || key.name === "enter") {
      if (this.list.focused) { key.preventDefault(); this.openSelectedIssue(); }
      return;
    }
    if (key.name === "z") { key.preventDefault(); this.toggleListPane(); return; }
    if (key.name === "b") { key.preventDefault(); this.toggleLayout(); return; }
    if (key.name === "/") { key.preventDefault(); this.openSearch(); return; }
    if (key.name === "a") { key.preventDefault(); this.openPalette(); return; }
    if (key.name === "u") { key.preventDefault(); void this.undoMove(); return; }
    const viewIndex = this.layout === "list" ? VIEW_TABS.find((tab) => tab.key === key.name) : undefined;
    if (viewIndex) { key.preventDefault(); this.setView(viewIndex.view); return; }
    if (key.name === "t") { key.preventDefault(); this.openPicker("team"); return; }
    if (key.name === "p") { key.preventDefault(); this.openPicker("project"); return; }
    if (key.name === "s") { key.preventDefault(); this.openPicker("sort"); return; }
    if (key.name === "q") { key.preventDefault(); this.quit(); return; }
    if (key.name === "r") { key.preventDefault(); if (!this.isBusy()) void this.refresh(); return; }
    if (key.name === "o") { key.preventDefault(); this.openInLinear(); return; }
    if (key.name === "pageup") {
      key.preventDefault();
      if (this.detail.focused) this.detail.scrollBy(-1, "viewport");
      else if (this.layout === "list") this.list.moveUp(Math.max(1, Math.floor(this.list.height / 2)));
      else this.board.scrollBy({ x: -1, y: 0 }, "viewport");
      return;
    }
    if (key.name === "pagedown") {
      key.preventDefault();
      if (this.detail.focused) this.detail.scrollBy(1, "viewport");
      else if (this.layout === "list") this.list.moveDown(Math.max(1, Math.floor(this.list.height / 2)));
      else this.board.scrollBy({ x: 1, y: 0 }, "viewport");
    }
  }

  private openSelectedIssue(): void {
    const issue = this.list.getSelectedIssue();
    if (issue) this.openIssue(issue);
  }

  private openIssue(issue: TuiIssue): void {
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
    this.board.width = "100%"; this.board.height = "100%";
    this.detail.width = this.layout === "board" || this.listHidden || narrow ? "100%" : "58%"; this.detail.height = "100%";
    this.applyPaneVisibility();
    this.updateHeader(); this.updateFooter();
  }

  private applyPaneVisibility(): void {
    const wasVisible = this.detail.visible;
    if (this.listHidden) {
      this.list.visible = false;
      this.board.visible = false;
      this.detail.visible = true;
    } else if (this.layout === "board") {
      this.list.visible = false;
      this.board.visible = true;
      this.detail.visible = false;
    } else {
      this.board.visible = false;
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
    if (this.dragHint) {
      this.footer.content = this.dragHint;
      this.footer.fg = C.blue;
      return;
    }
    if (this.notice) {
      this.footer.content = this.notice;
      this.footer.fg = C.yellow;
      return;
    }
    this.footer.fg = C.muted;
    const hint = footerHint(
      this.listHidden,
      this.renderer.terminalWidth < 80,
      this.searchOverlay.visible,
      this.layout,
    );
    this.footer.content = this.offline ? `${hint}  ·  offline` : hint;
  }
}
