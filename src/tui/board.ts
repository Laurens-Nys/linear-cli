import {
  BoxRenderable,
  type CliRenderer,
  fg,
  type KeyEvent,
  MouseButton,
  RenderableEvents,
  ScrollBoxRenderable,
  t,
  TextRenderable,
} from "@opentui/core";
import type { CachedState } from "../cache.ts";
import type { TuiIssue, TuiWorkflowStateType } from "./data.ts";
import { bindGenerationScrollRestore, statusPresentation } from "./issue-list.ts";
import { GROK_NIGHT as C } from "./theme.ts";

export interface KanbanState extends Omit<CachedState, "type"> {
  type: TuiWorkflowStateType;
}

export interface KanbanDrop {
  issue: TuiIssue;
  state: KanbanState;
}

export interface KanbanScrollSnapshot {
  horizontal: number;
  columns: Record<string, number>;
}

export const KanbanBoardEvents = {
  ITEM_OPENED: "kanbanItemOpened",
  ITEM_ACTIONED: "kanbanItemActioned",
  ISSUE_DROPPED: "kanbanIssueDropped",
  DRAG_TARGET_CHANGED: "kanbanDragTargetChanged",
} as const;

const MIN_COLUMN_WIDTH = 24;
const MAX_COLUMN_WIDTH = 36;
const CARD_HEIGHT = 2;
const DRAG_THRESHOLD = 2;
const KANBAN_TYPE_ORDER: TuiWorkflowStateType[] = ["triage", "backlog", "unstarted", "started", "completed"];
const SCROLLBAR_TRACK = { backgroundColor: "transparent", foregroundColor: C.muted };

interface CardView {
  box: BoxRenderable;
  text: TextRenderable;
  issue: TuiIssue;
  dimmed: boolean;
}

interface ColumnView {
  box: BoxRenderable;
  heading: TextRenderable;
  cards: ScrollBoxRenderable;
}

function workflowType(type: string): TuiWorkflowStateType | undefined {
  return ["triage", "backlog", "unstarted", "started", "completed", "canceled", "duplicate"].includes(type)
    ? type as TuiWorkflowStateType
    : undefined;
}

export function kanbanStates(states: readonly CachedState[], issues: readonly TuiIssue[] = []): KanbanState[] {
  const liveColors = new Map(issues.map((issue) => [issue.state.id, issue.state.color]));
  const configured = states
    .map((state): KanbanState | undefined => {
      const type = workflowType(state.type);
      return type ? { ...state, type, color: state.color || liveColors.get(state.id) || undefined } : undefined;
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
      color: issue.state.color || undefined,
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
  private pressX: number | undefined;
  private pressY: number | undefined;
  private dragX: number | undefined;
  private dragY: number | undefined;
  private draggedIdentifier: string | undefined;
  private targetStateId: string | undefined;
  private movingIdentifier: string | undefined;
  private hoveredIdentifier: string | undefined;
  private interactive = true;
  private scrollRestoreGeneration = 0;
  private readonly cards = new Map<string, CardView>();
  private readonly columns = new Map<string, ColumnView>();

  constructor(private readonly renderer: CliRenderer) {
    super(renderer, {
      id: "tui-board", width: "100%", height: "100%", scrollX: true, scrollY: false,
      focusable: true, viewportCulling: false, backgroundColor: "transparent",
      contentOptions: { flexDirection: "row", gap: 1, backgroundColor: "transparent" },
      horizontalScrollbarOptions: { showArrows: false, trackOptions: SCROLLBAR_TRACK },
      onMouseDrag: (event) => {
        if (!this.interactive || !this.pressedIdentifier || this.movingIdentifier) return;
        const distance = Math.max(
          Math.abs(event.x - (this.pressX ?? event.x)),
          Math.abs(event.y - (this.pressY ?? event.y)),
        );
        if (!this.draggedIdentifier && distance < DRAG_THRESHOLD) return;
        this.draggedIdentifier = this.pressedIdentifier;
        this.dragX = event.x;
        this.dragY = event.y;
        this.renderer.setMousePointer("move");
        this.updateAutoScroll(event.x, event.y);
        this.scrollAtHorizontalEdge(event.x);
        this.highlightColumnAt(event.x, event.y);
        this.updateCardPresentation();
        event.preventDefault();
      },
      onMouseUp: (event) => {
        const pressed = this.pressedIdentifier;
        if (!this.draggedIdentifier && pressed && !this.movingIdentifier) {
          const issue = this.issueByIdentifier(pressed);
          if (issue) this.emit(KanbanBoardEvents.ITEM_OPENED, issue);
          this.resetPress();
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
    this.on(RenderableEvents.FOCUSED, () => this.updateCardPresentation());
    this.on(RenderableEvents.BLURRED, () => this.updateCardPresentation());
    this.on("resize", () => this.updateColumnWidths());
  }

  setBoard(states: readonly CachedState[], issues: readonly TuiIssue[], selectedIdentifier?: string): void {
    this.scrollRestoreGeneration += 1;
    this.clearDrag();
    const nextStates = kanbanStates(states, issues);
    const sameColumns = this.states.map((state) => state.id).join("\0") === nextStates.map((state) => state.id).join("\0");
    this.issues = [...issues];

    if (!sameColumns) this.rebuildColumns(nextStates);
    else {
      this.states = nextStates;
    }

    const preferred = selectedIdentifier ?? this.selectedIdentifier;
    this.selectedIdentifier = preferred && issues.some((issue) => issue.identifier === preferred)
      ? preferred
      : issues[0]?.identifier;

    if (nextStates.length === 0) {
      this.ensureEmptyMessage();
      return;
    }

    this.reconcileCards();
    this.updateColumnHeadings();
    this.updateColumnWidths();
    this.updateCardPresentation();
  }

  getSelectedIssue(): TuiIssue | undefined {
    return this.selectedIdentifier ? this.issueByIdentifier(this.selectedIdentifier) : undefined;
  }

  selectIdentifier(identifier: string): boolean {
    const issue = this.issueByIdentifier(identifier);
    if (!issue) return false;
    this.selectIssue(issue);
    return true;
  }

  get isDragging(): boolean {
    return this.draggedIdentifier !== undefined || this.pressedIdentifier !== undefined;
  }

  captureScrollState(): KanbanScrollSnapshot {
    return {
      horizontal: this.scrollLeft,
      columns: Object.fromEntries([...this.columns].map(([id, view]) => [id, view.cards.scrollTop])),
    };
  }

  restoreScrollState(snapshot: KanbanScrollSnapshot): void {
    const generation = ++this.scrollRestoreGeneration;
    this.scrollLeft = snapshot.horizontal;
    for (const [id, position] of Object.entries(snapshot.columns)) {
      const cards = this.columns.get(id)?.cards;
      if (!cards) continue;
      cards.scrollTop = position;
      if (cards.scrollTop !== position) {
        bindGenerationScrollRestore(cards.content, generation, () => this.scrollRestoreGeneration, () => {
          cards.scrollTop = position;
        });
      }
    }
  }

  setMoving(identifier?: string): void {
    this.movingIdentifier = identifier;
    this.updateCardPresentation();
  }

  setInteractive(interactive: boolean): void {
    this.interactive = interactive;
    if (!interactive) this.clearDrag();
    this.updateCardPresentation();
  }

  protected override onUpdate(deltaTime: number): void {
    super.onUpdate(deltaTime);
    if (this.draggedIdentifier && this.dragX !== undefined && this.dragY !== undefined) {
      this.highlightColumnAt(this.dragX, this.dragY);
    }
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
      if (target && this.interactive && !this.movingIdentifier) {
        this.emit(KanbanBoardEvents.ISSUE_DROPPED, { issue: selected, state: target } satisfies KanbanDrop);
      }
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

  private rebuildColumns(states: KanbanState[]): void {
    for (const child of [...this.getChildren()]) child.destroyRecursively();
    this.cards.clear();
    this.columns.clear();
    this.hoveredIdentifier = undefined;
    this.states = states;
    this.scrollTo({ x: 0, y: 0 });
    for (const state of states) this.addColumn(state);
  }

  private ensureEmptyMessage(): void {
    if (this.getChildren().some((child) => child.id === "tui-board-empty")) return;
    for (const child of [...this.getChildren()]) child.destroyRecursively();
    this.cards.clear();
    this.columns.clear();
    this.add(new TextRenderable(this.ctx, {
      id: "tui-board-empty", width: "100%", height: 1,
      content: "Choose a team to use Board", fg: C.secondary, selectable: false,
    }));
  }

  private addColumn(state: KanbanState): void {
    const column = new BoxRenderable(this.ctx, {
      id: `tui-board-column-${state.id}`, width: MIN_COLUMN_WIDTH, height: "100%", flexShrink: 0,
      flexDirection: "column", gap: 1, padding: 1, border: true, borderStyle: "single",
      borderColor: C.border, backgroundColor: "transparent",
    });
    const heading = new TextRenderable(this.ctx, {
      width: "100%", height: 1, fg: C.secondary, selectable: false,
    });
    const cards = new ScrollBoxRenderable(this.ctx, {
      id: `tui-board-cards-${state.id}`, width: "100%", flexGrow: 1, scrollY: true,
      backgroundColor: "transparent", viewportCulling: true,
      contentOptions: { flexDirection: "column", gap: 1, backgroundColor: "transparent" },
      verticalScrollbarOptions: { showArrows: false, trackOptions: SCROLLBAR_TRACK },
    });
    column.add(heading);
    column.add(cards);
    this.columns.set(state.id, { box: column, heading, cards });
    this.add(column);
  }

  private reconcileCards(): void {
    const nextIdentifiers = new Set(this.issues.map((issue) => issue.identifier));
    for (const [identifier, view] of [...this.cards]) {
      if (nextIdentifiers.has(identifier)) continue;
      view.box.destroyRecursively();
      this.cards.delete(identifier);
    }

    for (const state of this.states) {
      const column = this.columns.get(state.id);
      if (!column) continue;
      const desired = this.issues.filter((issue) => issue.state.id === state.id);
      for (let index = 0; index < desired.length; index += 1) {
        const issue = desired[index]!;
        let view = this.cards.get(issue.identifier);
        if (!view) {
          view = this.makeCard(issue);
          this.cards.set(issue.identifier, view);
        }
        view.issue = issue;
        this.updateCardText(view, false);
        const childAtIndex = column.cards.getChildren()[index];
        if (childAtIndex !== view.box) column.cards.add(view.box, index);
      }
    }
  }

  private updateColumnHeadings(): void {
    for (const state of this.states) {
      const view = this.columns.get(state.id);
      if (!view) continue;
      const presentation = statusPresentation(state.type);
      const count = this.issues.filter((issue) => issue.state.id === state.id).length;
      view.heading.content = t`${fg(state.color || presentation.fallbackColor)(presentation.glyph)} ${state.name.toUpperCase()} · ${count}`;
    }
  }

  private updateColumnWidths(): void {
    if (this.states.length === 0) return;
    const available = Math.max(0, this.width || this.viewport.width);
    const gaps = Math.max(0, this.states.length - 1);
    const fitted = Math.floor((available - gaps) / this.states.length);
    const width = Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, fitted));
    for (const view of this.columns.values()) view.box.width = width;
    const maxScroll = Math.max(0, this.scrollWidth - this.viewport.width);
    if (this.scrollLeft > maxScroll) this.scrollLeft = maxScroll;
  }

  private makeCard(issue: TuiIssue): CardView {
    const box = new BoxRenderable(this.ctx, {
      id: `tui-board-card-${issue.identifier}`, width: "100%", height: CARD_HEIGHT,
      flexShrink: 0, flexDirection: "column", paddingX: 1, backgroundColor: "transparent",
      onMouseDown: (event) => {
        if (!this.interactive || this.movingIdentifier) { this.renderer.setMousePointer("not-allowed"); event.preventDefault(); return; }
        this.selectIssueByIdentifier(issue.identifier);
        this.focus();
        if (event.button === MouseButton.RIGHT) {
          this.emit(KanbanBoardEvents.ITEM_ACTIONED, issue);
          event.preventDefault();
          return;
        }
        this.pressedIdentifier = issue.identifier;
        this.pressX = event.x;
        this.pressY = event.y;
        event.preventDefault();
      },
      onMouseOver: () => {
        this.hoveredIdentifier = issue.identifier;
        this.updateCardPresentation();
        this.renderer.setMousePointer(!this.interactive || this.movingIdentifier ? "not-allowed" : "pointer");
      },
      onMouseOut: () => {
        if (this.hoveredIdentifier === issue.identifier) this.hoveredIdentifier = undefined;
        this.updateCardPresentation();
        if (!this.draggedIdentifier) this.renderer.setMousePointer("default");
      },
    });
    const text = new TextRenderable(this.ctx, {
      width: "100%", height: CARD_HEIGHT, wrapMode: "word", truncate: true,
      fg: C.text, selectable: false,
    });
    box.add(text);
    const view: CardView = { box, text, issue, dimmed: false };
    this.updateCardText(view, false);
    return view;
  }

  private updateCardText(view: CardView, dimmed: boolean): void {
    view.dimmed = dimmed;
    const identifierColor = dimmed ? C.muted : C.lavender;
    const titleColor = dimmed ? C.muted : C.text;
    view.text.content = t`${fg(identifierColor)(view.issue.identifier)}  ${fg(titleColor)(view.issue.title)}`;
  }

  private issueByIdentifier(identifier: string): TuiIssue | undefined {
    return this.issues.find((issue) => issue.identifier === identifier);
  }

  private selectIssueByIdentifier(identifier: string): void {
    const issue = this.issueByIdentifier(identifier);
    if (issue) this.selectIssue(issue);
  }

  private selectIssue(issue: TuiIssue): void {
    this.selectedIdentifier = issue.identifier;
    this.updateCardPresentation();
    this.scrollChildIntoView(`tui-board-column-${issue.state.id}`);
    this.columns.get(issue.state.id)?.cards.scrollChildIntoView(`tui-board-card-${issue.identifier}`);
  }

  private scrollAtHorizontalEdge(x: number): void {
    const left = this.viewport.screenX;
    const right = left + this.viewport.width - 1;
    if (x <= left + 1) this.scrollBy({ x: -3, y: 0 });
    else if (x >= right - 1) this.scrollBy({ x: 3, y: 0 });
  }

  private updateCardPresentation(): void {
    for (const [identifier, view] of this.cards) {
      const dimmed = identifier === this.draggedIdentifier;
      view.box.backgroundColor = dimmed
        ? C.surface0
        : identifier === this.movingIdentifier
          ? C.surface1
          : identifier === this.selectedIdentifier && this.focused
            ? C.surface1
            : identifier === this.hoveredIdentifier
              ? C.surface0
              : "transparent";
      if (view.dimmed !== dimmed) this.updateCardText(view, dimmed);
    }
  }

  private columnAt(x: number, y: number): KanbanState | undefined {
    return this.states.find((state) => {
      const column = this.columns.get(state.id)?.box;
      return column && x >= column.screenX && x < column.screenX + column.width
        && y >= column.screenY && y < column.screenY + column.height;
    });
  }

  private highlightColumnAt(x: number, y: number): void {
    const issue = this.draggedIdentifier ? this.issueByIdentifier(this.draggedIdentifier) : undefined;
    const state = this.columnAt(x, y);
    const nextTarget = issue && state && state.id !== issue.state.id ? state.id : undefined;
    if (nextTarget !== this.targetStateId) {
      this.targetStateId = nextTarget;
      this.emit(
        KanbanBoardEvents.DRAG_TARGET_CHANGED,
        issue && state && nextTarget ? { issue, state } satisfies KanbanDrop : undefined,
      );
    }
    for (const [id, view] of this.columns) {
      const targeted = id === this.targetStateId;
      view.box.borderColor = targeted ? C.blue : C.border;
      view.box.backgroundColor = targeted ? C.surface0 : "transparent";
    }
  }

  private finishDrop(_x: number, _y: number): void {
    const identifier = this.draggedIdentifier;
    const state = this.targetStateId ? this.states.find((item) => item.id === this.targetStateId) : undefined;
    const issue = identifier ? this.issueByIdentifier(identifier) : undefined;
    this.clearDrag();
    if (!this.interactive || !issue || !state || issue.state.id === state.id || this.movingIdentifier) return;
    queueMicrotask(() => this.emit(KanbanBoardEvents.ISSUE_DROPPED, { issue, state } satisfies KanbanDrop));
  }

  private resetPress(): void {
    this.pressedIdentifier = undefined;
    this.pressX = undefined;
    this.pressY = undefined;
    this.dragX = undefined;
    this.dragY = undefined;
  }

  private clearDrag(): void {
    this.stopAutoScroll();
    const hadTarget = this.targetStateId !== undefined;
    this.resetPress();
    this.draggedIdentifier = undefined;
    this.targetStateId = undefined;
    for (const view of this.columns.values()) {
      view.box.borderColor = C.border;
      view.box.backgroundColor = "transparent";
    }
    if (hadTarget) this.emit(KanbanBoardEvents.DRAG_TARGET_CHANGED, undefined);
    this.renderer.setMousePointer("default");
    this.updateCardPresentation();
  }
}
