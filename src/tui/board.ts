import {
  BoxRenderable,
  type CliRenderer,
  type KeyEvent,
  RenderableEvents,
  ScrollBoxRenderable,
  TextRenderable,
} from "@opentui/core";
import type { CachedState } from "../cache.ts";
import type { TuiIssue, TuiWorkflowStateType } from "./data.ts";
import { statusPresentation } from "./issue-list.ts";
import { GROK_NIGHT as C } from "./theme.ts";

export interface KanbanState extends Omit<CachedState, "type"> {
  type: TuiWorkflowStateType;
}

export interface KanbanDrop {
  issue: TuiIssue;
  state: KanbanState;
}

export const KanbanBoardEvents = {
  ITEM_OPENED: "kanbanItemOpened",
  ISSUE_DROPPED: "kanbanIssueDropped",
} as const;

const COLUMN_WIDTH = 30;
const CARD_HEIGHT = 2;
const KANBAN_TYPE_ORDER: TuiWorkflowStateType[] = ["triage", "backlog", "unstarted", "started", "completed"];
const SCROLLBAR_TRACK = { backgroundColor: "transparent", foregroundColor: C.muted };

function workflowType(type: string): TuiWorkflowStateType | undefined {
  return ["triage", "backlog", "unstarted", "started", "completed", "canceled", "duplicate"].includes(type)
    ? type as TuiWorkflowStateType
    : undefined;
}

export function kanbanStates(states: readonly CachedState[], issues: readonly TuiIssue[] = []): KanbanState[] {
  const configured = states
    .map((state): KanbanState | undefined => {
      const type = workflowType(state.type);
      return type ? { ...state, type } : undefined;
    })
    .filter((state): state is KanbanState => state !== undefined && state.type !== "canceled" && state.type !== "duplicate")
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  const configuredIds = new Set(configured.map((state) => state.id));
  const live = new Map<string, KanbanState>();
  for (const issue of issues) {
    if (configuredIds.has(issue.state.id) || live.has(issue.state.id)) continue;
    if (issue.state.type === "canceled" || issue.state.type === "duplicate") continue;
    live.set(issue.state.id, {
      id: issue.state.id,
      name: issue.state.name,
      type: issue.state.type,
      position: Number.MAX_SAFE_INTEGER,
    });
  }
  return [...configured, ...live.values()].sort((a, b) => {
    const typeDelta = KANBAN_TYPE_ORDER.indexOf(a.type) - KANBAN_TYPE_ORDER.indexOf(b.type);
    return typeDelta || a.position - b.position || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
}

export class KanbanBoardRenderable extends ScrollBoxRenderable {
  private issues: TuiIssue[] = [];
  private states: KanbanState[] = [];
  private selectedIdentifier: string | undefined;
  private pressedIdentifier: string | undefined;
  private draggedIdentifier: string | undefined;
  private targetStateId: string | undefined;
  private movingIdentifier: string | undefined;
  private hoveredIdentifier: string | undefined;
  private readonly cards = new Map<string, BoxRenderable>();
  private readonly columns = new Map<string, BoxRenderable>();
  private readonly cardLists = new Map<string, ScrollBoxRenderable>();

  constructor(private readonly renderer: CliRenderer) {
    super(renderer, {
      id: "tui-board", width: "100%", height: "100%", scrollX: true, scrollY: false,
      focusable: true, viewportCulling: false, backgroundColor: "transparent",
      contentOptions: { flexDirection: "row", gap: 1, backgroundColor: "transparent" },
      horizontalScrollbarOptions: { showArrows: false, trackOptions: SCROLLBAR_TRACK },
      onMouseDrag: (event) => {
        if (!this.pressedIdentifier || this.movingIdentifier) return;
        this.draggedIdentifier = this.pressedIdentifier;
        this.renderer.setMousePointer("move");
        this.updateAutoScroll(event.x, event.y);
        this.scrollAtHorizontalEdge(event.x);
        this.highlightColumnAt(event.x, event.y);
        this.updateCardFills();
        event.preventDefault();
      },
      onMouseUp: (event) => {
        const pressed = this.pressedIdentifier;
        if (!this.draggedIdentifier && pressed && !this.movingIdentifier) {
          const issue = this.issues.find((item) => item.identifier === pressed);
          if (issue) this.emit(KanbanBoardEvents.ITEM_OPENED, issue);
          this.pressedIdentifier = undefined;
        } else {
          queueMicrotask(() => {
            if (this.draggedIdentifier) this.clearDrag();
          });
        }
        event.preventDefault();
      },
      onMouseDrop: (event) => {
        this.finishDrop(event.x, event.y);
        event.preventDefault();
      },
      onMouseOut: () => {
        if (!this.draggedIdentifier) this.renderer.setMousePointer("default");
      },
    });
    this.on(RenderableEvents.FOCUSED, () => this.updateCardFills());
    this.on(RenderableEvents.BLURRED, () => this.updateCardFills());
  }

  setBoard(states: readonly CachedState[], issues: readonly TuiIssue[], selectedIdentifier?: string): void {
    this.clearDrag();
    for (const child of [...this.getChildren()]) child.destroyRecursively();
    this.cards.clear();
    this.columns.clear();
    this.hoveredIdentifier = undefined;
    this.cardLists.clear();
    this.states = kanbanStates(states, issues);
    this.issues = [...issues];
    this.selectedIdentifier = selectedIdentifier && issues.some((issue) => issue.identifier === selectedIdentifier)
      ? selectedIdentifier
      : issues[0]?.identifier;

    if (this.states.length === 0) {
      this.add(new TextRenderable(this.ctx, {
        id: "tui-board-empty", width: "100%", height: 1,
        content: "Choose a team to use Board", fg: C.secondary, selectable: false,
      }));
      return;
    }

    for (const state of this.states) this.addColumn(state);
    this.updateCardFills();
  }

  getSelectedIssue(): TuiIssue | undefined {
    return this.issues.find((issue) => issue.identifier === this.selectedIdentifier);
  }

  setMoving(identifier?: string): void {
    this.movingIdentifier = identifier;
    this.updateCardFills();
  }

  override handleKeyPress(key: KeyEvent): boolean {
    const selected = this.getSelectedIssue();
    if (!selected) return super.handleKeyPress(key);
    if (key.name === "return" || key.name === "enter") {
      key.preventDefault();
      this.emit(KanbanBoardEvents.ITEM_OPENED, selected);
      return true;
    }
    const stateIndex = this.states.findIndex((state) => state.id === selected.state.id);
    if (key.shift && (key.name === "left" || key.name === "right")) {
      const target = this.states[stateIndex + (key.name === "left" ? -1 : 1)];
      if (target && !this.movingIdentifier) this.emit(KanbanBoardEvents.ISSUE_DROPPED, { issue: selected, state: target } satisfies KanbanDrop);
      key.preventDefault();
      return true;
    }
    const sameColumn = this.issues.filter((issue) => issue.state.id === selected.state.id);
    const index = sameColumn.findIndex((issue) => issue.identifier === selected.identifier);
    if (key.name === "up" || key.name === "k") {
      this.selectIssue(sameColumn[Math.max(0, index - 1)] ?? selected);
      return true;
    }
    if (key.name === "down" || key.name === "j") {
      this.selectIssue(sameColumn[Math.min(sameColumn.length - 1, index + 1)] ?? selected);
      return true;
    }
    if (key.name === "left" || key.name === "right") {
      const direction = key.name === "left" ? -1 : 1;
      for (let next = stateIndex + direction; next >= 0 && next < this.states.length; next += direction) {
        const issue = this.issues.find((item) => item.state.id === this.states[next]!.id);
        if (issue) { this.selectIssue(issue); break; }
      }
      return true;
    }
    return super.handleKeyPress(key);
  }

  private addColumn(state: KanbanState): void {
    const glyph = statusPresentation(state.type).glyph;
    const column = new BoxRenderable(this.ctx, {
      id: `tui-board-column-${state.id}`, width: COLUMN_WIDTH, height: "100%", flexShrink: 0,
      flexDirection: "column", gap: 1, padding: 1, border: true, borderStyle: "single",
      borderColor: C.border, backgroundColor: "transparent",
    });
    this.columns.set(state.id, column);
    const count = this.issues.filter((issue) => issue.state.id === state.id).length;
    column.add(new TextRenderable(this.ctx, {
      width: "100%", height: 1, content: `${glyph} ${state.name.toUpperCase()} · ${count}`,
      fg: C.secondary, selectable: false,
    }));
    const cards = new ScrollBoxRenderable(this.ctx, {
      id: `tui-board-cards-${state.id}`, width: "100%", flexGrow: 1, scrollY: true,
      backgroundColor: "transparent", viewportCulling: true,
      contentOptions: { flexDirection: "column", backgroundColor: "transparent" },
      verticalScrollbarOptions: { showArrows: false, trackOptions: SCROLLBAR_TRACK },
    });
    this.cardLists.set(state.id, cards);
    for (const issue of this.issues.filter((item) => item.state.id === state.id)) cards.add(this.makeCard(issue));
    column.add(cards);
    this.add(column);
  }

  private makeCard(issue: TuiIssue): BoxRenderable {
    const card = new BoxRenderable(this.ctx, {
      id: `tui-board-card-${issue.identifier}`, width: "100%", height: CARD_HEIGHT,
      flexShrink: 0, flexDirection: "column", paddingX: 1, backgroundColor: "transparent",
      onMouseDown: (event) => {
        if (this.movingIdentifier) { this.renderer.setMousePointer("not-allowed"); event.preventDefault(); return; }
        this.pressedIdentifier = issue.identifier;
        this.selectIssue(issue);
        this.focus();
        event.preventDefault();
      },
      onMouseOver: () => {
        this.hoveredIdentifier = issue.identifier;
        this.updateCardFills();
        this.renderer.setMousePointer(this.movingIdentifier ? "not-allowed" : "pointer");
      },
      onMouseOut: () => {
        if (this.hoveredIdentifier === issue.identifier) this.hoveredIdentifier = undefined;
        this.updateCardFills();
        if (!this.draggedIdentifier) this.renderer.setMousePointer("default");
      },
    });
    card.add(new TextRenderable(this.ctx, {
      width: "100%", height: 1, content: issue.identifier, fg: C.lavender, selectable: false,
    }));
    card.add(new TextRenderable(this.ctx, {
      width: "100%", height: 1, content: issue.title, fg: C.text, selectable: false,
    }));
    this.cards.set(issue.identifier, card);
    return card;
  }

  private selectIssue(issue: TuiIssue): void {
    this.selectedIdentifier = issue.identifier;
    this.updateCardFills();
    this.scrollChildIntoView(`tui-board-column-${issue.state.id}`);
    this.cardLists.get(issue.state.id)?.scrollChildIntoView(`tui-board-card-${issue.identifier}`);
  }

  private scrollAtHorizontalEdge(x: number): void {
    const left = this.viewport.screenX;
    const right = left + this.viewport.width - 1;
    if (x <= left + 1) this.scrollBy({ x: -3, y: 0 });
    else if (x >= right - 1) this.scrollBy({ x: 3, y: 0 });
  }

  private updateCardFills(): void {
    for (const [identifier, card] of this.cards) {
      card.backgroundColor = identifier === this.draggedIdentifier
        ? C.surface2
        : identifier === this.movingIdentifier
          ? C.surface1
          : identifier === this.selectedIdentifier && this.focused
            ? C.surface1
            : identifier === this.hoveredIdentifier
              ? C.surface0
              : "transparent";
    }
  }

  private columnAt(x: number, y: number): KanbanState | undefined {
    return this.states.find((state) => {
      const column = this.columns.get(state.id);
      return column && x >= column.screenX && x < column.screenX + column.width
        && y >= column.screenY && y < column.screenY + column.height;
    });
  }

  private highlightColumnAt(x: number, y: number): void {
    const state = this.columnAt(x, y);
    this.targetStateId = state?.id;
    for (const [id, column] of this.columns) column.borderColor = id === this.targetStateId ? C.blue : C.border;
  }

  private finishDrop(x: number, y: number): void {
    const identifier = this.draggedIdentifier;
    const state = this.columnAt(x, y);
    const issue = identifier ? this.issues.find((item) => item.identifier === identifier) : undefined;
    this.clearDrag();
    if (!issue || !state || issue.state.id === state.id || this.movingIdentifier) return;
    queueMicrotask(() => this.emit(KanbanBoardEvents.ISSUE_DROPPED, { issue, state } satisfies KanbanDrop));
  }

  private clearDrag(): void {
    this.stopAutoScroll();
    this.pressedIdentifier = undefined;
    this.draggedIdentifier = undefined;
    this.targetStateId = undefined;
    for (const column of this.columns.values()) column.borderColor = C.border;
    this.renderer.setMousePointer("default");
    this.updateCardFills();
  }
}
