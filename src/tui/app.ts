import {
  BoxRenderable,
  CliRenderEvents,
  type CliRenderer,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
  type KeyEvent,
  type SelectOption,
} from "@opentui/core";
import { type TuiIssue, TuiIssueStore } from "./data.ts";

const COLORS = {
  background: "#111113",
  panel: "#171719",
  border: "#34343a",
  muted: "#92929d",
  text: "#e8e8ec",
  accent: "#5e6ad2",
  selected: "#2c2d45",
  error: "#ef6b73",
};

const PRIORITIES = ["No priority", "Urgent", "High", "Medium", "Low"] as const;

export interface TuiAppOptions {
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

function optionsFor(issues: readonly TuiIssue[]): SelectOption[] {
  return issues.map((issue) => ({
    name: `${issue.identifier}  ${issue.title}`,
    description: `${issue.state.name}  ·  updated ${date(issue.updatedAt)}`,
    value: issue,
  }));
}

export class TuiApp {
  readonly root: BoxRenderable;
  readonly list: SelectRenderable;
  readonly detail: ScrollBoxRenderable;
  readonly detailText: TextRenderable;
  readonly status: TextRenderable;
  readonly footer: TextRenderable;
  private readonly main: BoxRenderable;
  private stopped = false;
  private refreshPromise: Promise<void> | null = null;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly store: TuiIssueStore,
    private readonly options: TuiAppOptions = {},
  ) {
    this.status = new TextRenderable(renderer, {
      id: "tui-status",
      content: "Loading your open issues…",
      height: 1,
      fg: COLORS.muted,
      selectable: false,
    });

    this.list = new SelectRenderable(renderer, {
      id: "tui-list",
      width: "42%",
      height: "100%",
      options: [],
      showDescription: true,
      showScrollIndicator: true,
      wrapSelection: false,
      backgroundColor: COLORS.panel,
      focusedBackgroundColor: COLORS.panel,
      textColor: COLORS.text,
      focusedTextColor: COLORS.text,
      descriptionColor: COLORS.muted,
      selectedBackgroundColor: COLORS.selected,
      selectedTextColor: COLORS.text,
      selectedDescriptionColor: "#b8b9e8",
      keyBindings: [
        { name: "up", action: "move-up" },
        { name: "k", action: "move-up" },
        { name: "down", action: "move-down" },
        { name: "j", action: "move-down" },
        { name: "pageup", action: "move-up-fast" },
        { name: "pagedown", action: "move-down-fast" },
      ],
      onMouseDown: (event) => {
        const visibleCount = Math.max(1, Math.floor(this.list.height / 2));
        const selected = this.list.getSelectedIndex();
        const offset = Math.max(0, Math.min(selected - Math.floor(visibleCount / 2), this.list.options.length - visibleCount));
        const row = Math.floor((event.y - this.list.screenY) / 2);
        this.list.setSelectedIndex(offset + row);
        this.list.focus();
        event.preventDefault();
      },
      onMouseScroll: (event) => {
        if (event.scroll?.direction === "up") this.list.moveUp();
        if (event.scroll?.direction === "down") this.list.moveDown();
        this.list.focus();
        event.preventDefault();
      },
      onMouseOver: () => this.renderer.setMousePointer("pointer"),
      onMouseOut: () => this.renderer.setMousePointer("default"),
    });

    this.detailText = new TextRenderable(renderer, {
      id: "tui-detail-text",
      content: "Loading…",
      width: "100%",
      fg: COLORS.text,
      wrapMode: "word",
      selectable: true,
    });
    this.detail = new ScrollBoxRenderable(renderer, {
      id: "tui-detail",
      width: "58%",
      height: "100%",
      padding: 1,
      border: ["left"],
      borderColor: COLORS.border,
      backgroundColor: COLORS.background,
      scrollY: true,
    });
    this.detail.add(this.detailText);

    this.main = new BoxRenderable(renderer, {
      id: "tui-main",
      width: "100%",
      flexGrow: 1,
      flexDirection: "row",
      backgroundColor: COLORS.background,
    });
    this.main.add(this.list);
    this.main.add(this.detail);

    this.footer = new TextRenderable(renderer, {
      id: "tui-footer",
      content: "↑/k ↓/j select   PgUp/PgDn details   mouse click/scroll   r refresh   q quit",
      height: 1,
      fg: COLORS.muted,
      selectable: false,
    });
    this.root = new BoxRenderable(renderer, {
      id: "tui-root",
      width: "100%",
      height: "100%",
      padding: 1,
      flexDirection: "column",
      backgroundColor: COLORS.background,
      gap: 1,
    });
    this.root.add(this.status);
    this.root.add(this.main);
    this.root.add(this.footer);

    this.list.on(SelectRenderableEvents.SELECTION_CHANGED, (_index: number, option: SelectOption | null) => {
      this.showIssue(option?.value as TuiIssue | undefined);
    });
    this.renderer.keyInput.on("keypress", (key) => this.handleGlobalKey(key));
    this.renderer.on(CliRenderEvents.RESIZE, () => this.applyLayout());
    this.applyLayout();
  }

  mount(): void {
    this.renderer.root.add(this.root);
    this.list.focus();
  }

  start(): void {
    this.mount();
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.status.content = "Refreshing your open issues…";
    this.status.fg = COLORS.muted;
    const previousId = (this.list.getSelectedOption()?.value as TuiIssue | undefined)?.identifier;
    this.refreshPromise = this.store.refresh().then((state) => {
      if (this.stopped || this.renderer.isDestroyed) return;
      this.list.options = optionsFor(state.issues);
      const previousIndex = previousId
        ? state.issues.findIndex((issue) => issue.identifier === previousId)
        : 0;
      if (state.issues.length > 0) this.list.setSelectedIndex(Math.max(0, previousIndex));
      else this.showIssue(undefined);

      if (state.kind === "error") {
        this.status.content = `Could not refresh: ${state.message}  ·  press r to retry`;
        this.status.fg = COLORS.error;
      } else if (state.issues.length === 0) {
        this.status.content = "No open issues are assigned to you.";
        this.status.fg = COLORS.muted;
        this.detailText.content = "You are all caught up. Press r to refresh.";
      } else {
        this.status.content = `Showing ${state.issues.length} open issue${state.issues.length === 1 ? "" : "s"} assigned to you`;
        this.status.fg = COLORS.muted;
      }
    }).finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  quit(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.options.onQuit?.();
  }

  private showIssue(issue: TuiIssue | undefined): void {
    this.detailText.content = issueDetail(issue);
    this.detail.scrollTo(0);
  }

  private handleGlobalKey(key: KeyEvent): void {
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      this.quit();
      return;
    }
    if (key.name === "q") {
      key.preventDefault();
      this.quit();
      return;
    }
    if (key.name === "r") {
      key.preventDefault();
      void this.refresh();
      return;
    }
    if (key.name === "pageup") {
      key.preventDefault();
      this.detail.scrollBy(-1, "viewport");
      return;
    }
    if (key.name === "pagedown") {
      key.preventDefault();
      this.detail.scrollBy(1, "viewport");
    }
  }

  private applyLayout(): void {
    const narrow = this.renderer.terminalWidth < 80;
    this.footer.content = narrow
      ? "↑/↓ select   r refresh   q quit"
      : "↑/k ↓/j select   PgUp/PgDn details   mouse click/scroll   r refresh   q quit";
    this.main.flexDirection = narrow ? "column" : "row";
    this.list.width = narrow ? "100%" : "42%";
    this.list.height = narrow ? "48%" : "100%";
    this.detail.width = narrow ? "100%" : "58%";
    this.detail.height = narrow ? "52%" : "100%";
    this.detail.border = narrow ? ["top"] : ["left"];
  }
}
