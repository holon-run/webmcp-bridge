/**
 * This module stores persisted board interactions such as messages and annotations.
 * It depends on shared board types and is used by the app UI and WebMCP resources to expose host-relevant collaboration state.
 */

import type {
  BoardInteraction,
  BoardInteractionsSnapshot,
  DiagramSelection,
  InteractionAudience,
  InteractionIntent,
  InteractionKind,
} from "./types.js";

const INTERACTIONS_STORAGE_KEY = "webmcp-bridge.board.interactions";
const BOARD_APP_ID = "board";
const BOARD_SESSION_ID = "local";

type Listener = () => void;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseInteractionsSnapshot(raw: string): BoardInteractionsSnapshot | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const candidate = parsed as {
      version?: unknown;
      appId?: unknown;
      sessionId?: unknown;
      resourceVersion?: unknown;
      updatedAt?: unknown;
      items?: unknown;
    };
    if (candidate.version !== 1 || !Array.isArray(candidate.items)) {
      return undefined;
    }
    const items = candidate.items.flatMap((item): BoardInteraction[] => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return [];
      }
      const entry = item as Record<string, unknown>;
      if (
        typeof entry.id !== "string" ||
        typeof entry.kind !== "string" ||
        typeof entry.body !== "string" ||
        typeof entry.author !== "string" ||
        typeof entry.createdAt !== "string" ||
        typeof entry.intent !== "string" ||
        typeof entry.requiresResponse !== "boolean" ||
        !entry.anchors ||
        typeof entry.anchors !== "object" ||
        Array.isArray(entry.anchors) ||
        !entry.routing ||
        typeof entry.routing !== "object" ||
        Array.isArray(entry.routing) ||
        !isStringArray((entry.anchors as { nodeIds?: unknown }).nodeIds) ||
        !isStringArray((entry.anchors as { edgeIds?: unknown }).edgeIds) ||
        typeof (entry.routing as { audience?: unknown }).audience !== "string"
      ) {
        return [];
      }
      return [
        {
          id: entry.id,
          kind: entry.kind as InteractionKind,
          body: entry.body,
          author: entry.author as BoardInteraction["author"],
          createdAt: entry.createdAt,
          anchors: {
            nodeIds: (entry.anchors as { nodeIds: string[] }).nodeIds,
            edgeIds: (entry.anchors as { edgeIds: string[] }).edgeIds,
          },
          routing: {
            audience: (entry.routing as { audience: InteractionAudience }).audience,
          },
          intent: entry.intent as InteractionIntent,
          requiresResponse: entry.requiresResponse,
        },
      ];
    });
    return {
      version: 1,
      appId: candidate.appId === BOARD_APP_ID ? BOARD_APP_ID : BOARD_APP_ID,
      sessionId: typeof candidate.sessionId === "string" ? candidate.sessionId : BOARD_SESSION_ID,
      resourceVersion:
        typeof candidate.resourceVersion === "number" && Number.isFinite(candidate.resourceVersion)
          ? candidate.resourceVersion
          : items.length,
      updatedAt:
        typeof candidate.updatedAt === "string" && candidate.updatedAt
          ? candidate.updatedAt
          : new Date(0).toISOString(),
      items,
    };
  } catch {
    return undefined;
  }
}

function createInteractionId(): string {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `interaction-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export class BoardInteractionsState {
  private snapshot: BoardInteractionsSnapshot;
  private listeners = new Set<Listener>();

  private constructor(snapshot: BoardInteractionsSnapshot) {
    this.snapshot = snapshot;
  }

  static async load(): Promise<BoardInteractionsState> {
    const raw = globalThis.localStorage?.getItem(INTERACTIONS_STORAGE_KEY);
    const parsed = raw ? parseInteractionsSnapshot(raw) : undefined;
    const state = new BoardInteractionsState(
      parsed ?? {
        version: 1,
        appId: BOARD_APP_ID,
        sessionId: BOARD_SESSION_ID,
        resourceVersion: 0,
        updatedAt: new Date(0).toISOString(),
        items: [],
      },
    );
    state.persist();
    return state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private persist(): void {
    globalThis.localStorage?.setItem(INTERACTIONS_STORAGE_KEY, JSON.stringify(this.snapshot));
  }

  private emit(): void {
    this.persist();
    for (const listener of this.listeners) {
      listener();
    }
  }

  getSnapshot(): BoardInteractionsSnapshot {
    return {
      version: this.snapshot.version,
      appId: this.snapshot.appId,
      sessionId: this.snapshot.sessionId,
      resourceVersion: this.snapshot.resourceVersion,
      updatedAt: this.snapshot.updatedAt,
      items: this.snapshot.items.map((item) => ({
        ...item,
        anchors: {
          nodeIds: [...item.anchors.nodeIds],
          edgeIds: [...item.anchors.edgeIds],
        },
        routing: {
          audience: item.routing.audience,
        },
      })),
    };
  }

  appendInteraction(input: {
    kind: InteractionKind;
    body: string;
    selection: DiagramSelection;
    audience: InteractionAudience;
    intent: InteractionIntent;
    requiresResponse: boolean;
  }): BoardInteraction {
    const interaction: BoardInteraction = {
      id: createInteractionId(),
      kind: input.kind,
      body: input.body.trim(),
      author: "user",
      createdAt: new Date().toISOString(),
      anchors: {
        nodeIds: [...input.selection.nodeIds],
        edgeIds: [...input.selection.edgeIds],
      },
      routing: {
        audience: input.audience,
      },
      intent: input.intent,
      requiresResponse: input.requiresResponse,
    };
    this.snapshot = {
      version: 1,
      appId: BOARD_APP_ID,
      sessionId: BOARD_SESSION_ID,
      resourceVersion: this.snapshot.resourceVersion + 1,
      updatedAt: interaction.createdAt,
      items: [...this.snapshot.items, interaction],
    };
    this.emit();
    return interaction;
  }
}
