/**
 * This module provides a bounded in-memory ring buffer for replayable local MCP events.
 * It is depended on by the local MCP server SSE path to provide at-least-once delivery and overflow detection.
 */

import type { JsonValue } from "@webmcp-bridge/core";

export type BufferedEvent = {
  seq: number;
  event: JsonValue;
};

export type BufferedReplayResult = {
  overflow: boolean;
  events: BufferedEvent[];
};

export class EventBuffer {
  private readonly capacity: number;
  private readonly events: BufferedEvent[] = [];
  private nextSeq = 1;

  constructor(capacity = 5000) {
    this.capacity = Math.max(1, capacity);
  }

  append(event: JsonValue): BufferedEvent {
    const buffered: BufferedEvent = {
      seq: this.nextSeq,
      event,
    };
    this.nextSeq += 1;
    this.events.push(buffered);
    if (this.events.length > this.capacity) {
      this.events.shift();
    }
    return buffered;
  }

  replayAfter(lastSeq: number): BufferedReplayResult {
    if (this.events.length === 0) {
      return {
        overflow: false,
        events: [],
      };
    }

    if (lastSeq > 0) {
      const oldest = this.events[0]?.seq ?? 0;
      if (lastSeq < oldest - 1) {
        return {
          overflow: true,
          events: [],
        };
      }
    }

    return {
      overflow: false,
      events: this.events.filter((item) => item.seq > lastSeq),
    };
  }
}
