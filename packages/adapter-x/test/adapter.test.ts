/**
 * This module tests adapter-x auth gating, compose confirmation, and schema-level behavior.
 * It depends on adapter factory APIs and page-like mocks to keep unit assertions deterministic.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createXAdapter } from "../src/index.js";

type Behavior = {
  authState: "authenticated" | "auth_required" | "challenge_required";
  authSignals: string[];
  timelineItems: Array<{ id: string; text: string; url?: string }>;
  networkNextCursor?: string;
  requireFallbackTemplate?: boolean;
  composeResult: { ok: boolean; dryRun?: boolean; reason?: string; submitVisible?: boolean };
  confirmCompose: boolean;
  replyComposeResult: { ok: boolean; dryRun?: boolean; reason?: string; submitVisible?: boolean };
  confirmReply: boolean;
  confirmReplyAfterReload: boolean | undefined;
  grokComposeResult: { ok: boolean; reason?: string };
  confirmGrok: boolean;
  grokResponse?: string;
  grokRawResponse?: string;
  statusUrl?: string;
};

function createMockPage(partial: Partial<Behavior> = {}) {
  let replyConfirmAttempts = 0;
  let grokSubmitted = false;
  let uploadedFiles: string[] = [];
  let routedHandler:
    | ((
        route: {
          request(): { method(): string };
          continue(): Promise<void>;
          fetch(): Promise<{ status(): number; text(): Promise<string> }>;
          fulfill(): Promise<void>;
        },
      ) => Promise<void>)
    | undefined;
  const behavior: Behavior = {
    authState: "authenticated",
    authSignals: ["authenticated_ui"],
    timelineItems: [{ id: "timeline-1", text: "hello", url: "https://x.com/a/status/1" }],
    networkNextCursor: "cursor-next",
    requireFallbackTemplate: false,
    composeResult: { ok: true },
    confirmCompose: true,
    replyComposeResult: { ok: true },
    confirmReply: true,
    confirmReplyAfterReload: undefined,
    grokComposeResult: { ok: true },
    confirmGrok: true,
    grokResponse: "Grok mock response",
    statusUrl: "https://x.com/example/status/123",
    ...partial,
  };

  const grokNetworkResponseText = behavior.confirmGrok
    ? (behavior.grokRawResponse
        ?? `{"conversationId":"mock-conversation","result":{"message":"${behavior.grokResponse}","messageTag":"final"}}\n`)
    : "";

  const triggerGrokRoute = async (): Promise<void> => {
    if (!routedHandler) {
      return;
    }
    await routedHandler({
      request: () => ({ method: () => "POST" }),
      continue: async () => {},
      fetch: async () => ({
        status: () => 200,
        text: async () => grokNetworkResponseText,
      }),
      fulfill: async () => {},
    });
  };

  const readPage = {
    evaluate: vi.fn(async (_fn: unknown, arg?: unknown) => {
      if (Array.isArray(arg) && arg.every((item) => typeof item === "string")) {
        return arg[0];
      }

      if (!arg || typeof arg !== "object" || Array.isArray(arg)) {
        return undefined;
      }

      const command = arg as Record<string, unknown>;
      if (command.op === "detect_auth") {
        return {
          state: behavior.authState,
          signals: behavior.authSignals,
        };
      }

      if (typeof command.mode === "string" && typeof command.limit === "number") {
        if (behavior.requireFallbackTemplate && command.cachedTemplate === undefined) {
          return {
            items: [],
            source: "dom",
            reason: "no_template",
          };
        }
        return {
          items: behavior.timelineItems.slice(0, command.limit),
          source: "network",
          nextCursor: behavior.networkNextCursor,
          selectedTemplate: {
            url: "https://x.com/i/api/graphql/mock/Bookmarks",
            method: "GET",
            headers: {
              authorization: "Bearer mock",
              "x-csrf-token": "mock",
            },
          },
        };
      }

      if (typeof command.maxItems === "number") {
        return behavior.timelineItems.slice(0, command.maxItems);
      }

      if (command.op === "extract_notifications" && typeof command.maxItems === "number") {
        return behavior.timelineItems.slice(0, command.maxItems);
      }

      if (typeof command.content === "string" && typeof command.dryRunMode === "boolean") {
        return behavior.composeResult;
      }

      if (command.op === "reply_compose") {
        return behavior.replyComposeResult;
      }

      if (command.op === "reply_submit") {
        return { ok: true };
      }

      if (command.op === "grok_submit") {
        grokSubmitted = true;
        return behavior.grokComposeResult;
      }

      if (command.op === "grok_extract_state") {
        return grokSubmitted && behavior.confirmGrok
          ? {
              responseForPrompt: behavior.grokResponse,
              latestResponse: behavior.grokResponse,
            }
          : {
              responseForPrompt: undefined,
              latestResponse: undefined,
            };
      }

      if (typeof command.needle === "string") {
        return behavior.statusUrl;
      }

      return undefined;
    }),
    addInitScript: vi.fn(async () => {}),
    click: vi.fn(async (selector?: string) => {
      if (typeof selector === "string" && selector.includes("button")) {
        grokSubmitted = true;
        await triggerGrokRoute();
      }
    }),
    goto: vi.fn(async () => {}),
    type: vi.fn(async () => {}),
    waitForSelector: vi.fn(async () => ({ dispose: vi.fn(async () => {}) })),
    waitForTimeout: vi.fn(async () => {}),
    route: vi.fn(async (_pattern: string, handler: typeof routedHandler) => {
      routedHandler = handler;
    }),
    unroute: vi.fn(async () => {
      routedHandler = undefined;
    }),
    setInputFiles: vi.fn(async (_selector: string, files: string | string[]) => {
      uploadedFiles = Array.isArray(files) ? files : [files];
    }),
    waitForFunction: vi.fn(async (_fn: unknown, arg?: unknown) => {
      if (
        arg &&
        typeof arg === "object" &&
        !Array.isArray(arg) &&
        Array.isArray((arg as Record<string, unknown>).names)
      ) {
        return true;
      }
      if (typeof arg === "string") {
        replyConfirmAttempts += 1;
        const replyConfirmed =
          replyConfirmAttempts > 1 && behavior.confirmReplyAfterReload !== undefined
            ? behavior.confirmReplyAfterReload
            : behavior.confirmReply;
        if (!replyConfirmed) {
          throw new Error("timeout");
        }
        return true;
      }
      if (
        arg &&
        typeof arg === "object" &&
        !Array.isArray(arg) &&
        (arg as Record<string, unknown>).op === "reply_submit_ready"
      ) {
        if (!behavior.replyComposeResult.ok) {
          throw new Error("timeout");
        }
        return true;
      }
      if (arg && typeof arg === "object" && !Array.isArray(arg) && (arg as Record<string, unknown>).op === "grok_wait") {
        if (!behavior.confirmGrok) {
          throw new Error("timeout");
        }
        return true;
      }
      if (!behavior.confirmGrok) {
        throw new Error("timeout");
      }
      return true;
    }),
    reload: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    url: vi.fn(() => "https://x.com/i/bookmarks"),
    isClosed: vi.fn(() => false),
    keyboard: {
      press: vi.fn(async () => {}),
    },
  };
  const newPage = vi.fn(async () => readPage);

  const page = {
    addInitScript: vi.fn(async () => {}),
    evaluate: vi.fn(async (_fn: unknown, arg?: unknown) => {
      if (Array.isArray(arg) && arg.every((item) => typeof item === "string")) {
        return arg[0];
      }

      if (!arg || typeof arg !== "object" || Array.isArray(arg)) {
        return undefined;
      }

      const command = arg as Record<string, unknown>;
      if (command.op === "detect_auth") {
        return {
          state: behavior.authState,
          signals: behavior.authSignals,
        };
      }

      if (typeof command.mode === "string" && typeof command.limit === "number") {
        if (behavior.requireFallbackTemplate && command.cachedTemplate === undefined) {
          return {
            items: [],
            source: "dom",
            reason: "no_template",
          };
        }
        return {
          items: behavior.timelineItems.slice(0, command.limit),
          source: "network",
          nextCursor: behavior.networkNextCursor,
          selectedTemplate: {
            url: "https://x.com/i/api/graphql/mock/HomeTimeline",
            method: "GET",
            headers: {
              authorization: "Bearer mock",
              "x-csrf-token": "mock",
            },
          },
        };
      }

      if (typeof command.maxItems === "number") {
        return behavior.timelineItems.slice(0, command.maxItems);
      }

      if (command.op === "extract_notifications" && typeof command.maxItems === "number") {
        return behavior.timelineItems.slice(0, command.maxItems);
      }

      if (typeof command.content === "string" && typeof command.dryRunMode === "boolean") {
        return behavior.composeResult;
      }

      if (command.op === "reply_compose") {
        return behavior.replyComposeResult;
      }

      if (command.op === "reply_submit") {
        return { ok: true };
      }

      if (command.op === "grok_submit") {
        grokSubmitted = true;
        return behavior.grokComposeResult;
      }

      if (command.op === "grok_extract_state") {
        return grokSubmitted && behavior.confirmGrok
          ? {
              responseForPrompt: behavior.grokResponse,
              latestResponse: behavior.grokResponse,
            }
          : {
              responseForPrompt: undefined,
              latestResponse: undefined,
            };
      }

      if (typeof command.needle === "string") {
        return behavior.statusUrl;
      }

      return undefined;
    }),
    click: vi.fn(async (selector?: string) => {
      if (typeof selector === "string" && selector.includes("button")) {
        grokSubmitted = true;
        await triggerGrokRoute();
      }
    }),
    waitForSelector: vi.fn(async () => ({ dispose: vi.fn(async () => {}) })),
    waitForTimeout: vi.fn(async () => {}),
    route: vi.fn(async (_pattern: string, handler: typeof routedHandler) => {
      routedHandler = handler;
    }),
    unroute: vi.fn(async () => {
      routedHandler = undefined;
    }),
    setInputFiles: vi.fn(async (_selector: string, files: string | string[]) => {
      uploadedFiles = Array.isArray(files) ? files : [files];
    }),
    waitForLoadState: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    type: vi.fn(async () => {}),
    waitForFunction: vi.fn(async (_fn: unknown, arg?: unknown) => {
      if (
        arg &&
        typeof arg === "object" &&
        !Array.isArray(arg) &&
        Array.isArray((arg as Record<string, unknown>).names)
      ) {
        return true;
      }
      if (typeof arg === "string") {
        if (!behavior.confirmCompose) {
          throw new Error("timeout");
        }
        return true;
      }
      if (
        arg &&
        typeof arg === "object" &&
        !Array.isArray(arg) &&
        (arg as Record<string, unknown>).op === "reply_submit_ready"
      ) {
        if (!behavior.replyComposeResult.ok) {
          throw new Error("timeout");
        }
        return true;
      }
      if (arg && typeof arg === "object" && !Array.isArray(arg) && (arg as Record<string, unknown>).op === "grok_wait") {
        if (!behavior.confirmGrok) {
          throw new Error("timeout");
        }
        return true;
      }
      if (!behavior.confirmCompose) {
        throw new Error("timeout");
      }
      return true;
    }),
    goto: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    url: vi.fn(() => "https://x.com/home"),
    isClosed: vi.fn(() => false),
    keyboard: {
      press: vi.fn(async () => {}),
    },
    context: vi.fn(() => ({
      newPage,
    })),
  };

  return {
    page,
    readPage,
    newPage,
    behavior,
    getUploadedFiles: () => uploadedFiles,
  };
}

describe("createXAdapter", () => {
  const tempDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(tempDirs, (dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.clear();
  });

  it("publishes tool schemas", async () => {
    const adapter = createXAdapter();
    const tools = await adapter.listTools({ page: {} as never });
    const compose = tools.find((tool) => tool.name === "tweet.create");

    expect(compose?.inputSchema).toEqual(
      expect.objectContaining({
        type: "object",
        required: ["text"],
      }),
    );
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "timeline.home.list",
        "timeline.user.list",
        "search.tweets.list",
        "tweet.get",
        "tweet.conversation.get",
        "tweet.replies.list",
        "tweet.thread.get",
        "favorites.list",
        "notifications.list",
        "mentions.list",
        "user.get",
        "tweet.reply",
        "grok.chat",
      ]),
    );
  });

  it("returns auth required for timeline reads when logged out", async () => {
    const adapter = createXAdapter();
    const { page } = createMockPage({
      authState: "auth_required",
      authSignals: ["login_ui"],
    });

    const result = await adapter.callTool({ name: "timeline.home.list", input: {} }, { page: page as never });

    expect(result).toEqual({
      error: {
        code: "AUTH_REQUIRED",
        message: "login required",
        details: {
          state: "auth_required",
          signals: ["login_ui"],
        },
      },
    });
  });

  it("returns challenge required for compose when x challenge blocks actions", async () => {
    const adapter = createXAdapter();
    const { page } = createMockPage({
      authState: "challenge_required",
      authSignals: ["challenge_ui"],
    });

    const result = await adapter.callTool(
      { name: "tweet.create", input: { text: "hello" } },
      { page: page as never },
    );

    expect(result).toEqual({
      error: {
        code: "CHALLENGE_REQUIRED",
        message: "x.com challenge is blocking actions",
        details: {
          state: "challenge_required",
          signals: ["challenge_ui"],
        },
      },
    });
  });

  it("supports dry-run compose without waiting confirmation", async () => {
    const adapter = createXAdapter();
    const { page } = createMockPage({
      composeResult: { ok: true, dryRun: true, submitVisible: true },
    });

    const result = await adapter.callTool(
      { name: "tweet.create", input: { text: "hello", dryRun: true } },
      { page: page as never },
    );

    expect(result).toEqual({
      ok: true,
      dryRun: true,
      submitVisible: true,
    });
    expect(page.waitForFunction).not.toHaveBeenCalled();
  });

  it("fails closed when compose submit cannot be confirmed", async () => {
    const adapter = createXAdapter({ composeConfirmTimeoutMs: 100 });
    const { page } = createMockPage({
      composeResult: { ok: true },
      confirmCompose: false,
    });

    const result = await adapter.callTool(
      { name: "tweet.create", input: { text: "hello" } },
      { page: page as never },
    );

    expect(result).toEqual({
      error: {
        code: "ACTION_UNCONFIRMED",
        message: "post submit was not confirmed in timeline",
      },
    });
  });

  it("returns confirmed compose result when timeline confirms post", async () => {
    const adapter = createXAdapter();
    const { page } = createMockPage({
      composeResult: { ok: true },
      confirmCompose: true,
      statusUrl: "https://x.com/example/status/999",
    });

    const result = await adapter.callTool(
      { name: "tweet.create", input: { text: "hello" } },
      { page: page as never },
    );

    expect(result).toEqual({
      ok: true,
      confirmed: true,
      statusUrl: "https://x.com/example/status/999",
    });
  });

  it("returns validation error for tweet.reply without id/url", async () => {
    const adapter = createXAdapter();
    const { page } = createMockPage();

    const result = await adapter.callTool(
      { name: "tweet.reply", input: { text: "hello there" } },
      { page: page as never },
    );

    expect(result).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "url or id is required",
      },
    });
  });

  it("supports dry-run reply without waiting confirmation", async () => {
    const adapter = createXAdapter();
    const { page } = createMockPage({
      replyComposeResult: { ok: true, dryRun: true, submitVisible: true },
    });

    const result = await adapter.callTool(
      { name: "tweet.reply", input: { id: "123", text: "hello there", dryRun: true } },
      { page: page as never },
    );

    expect(result).toEqual({
      ok: true,
      dryRun: true,
      submitVisible: true,
      replyToUrl: "https://x.com/i/web/status/123",
    });
  });

  it("returns confirmed reply result when reply is confirmed", async () => {
    const adapter = createXAdapter();
    const { page, readPage } = createMockPage({
      replyComposeResult: { ok: true },
      confirmReply: true,
      statusUrl: "https://x.com/example/status/456",
    });

    const result = await adapter.callTool(
      { name: "tweet.reply", input: { url: "https://x.com/a/status/123", text: "hello there" } },
      { page: page as never },
    );

    expect(readPage.goto).toHaveBeenCalledWith("https://x.com/a/status/123", expect.anything());
    expect(result).toEqual({
      ok: true,
      confirmed: true,
      replyToUrl: "https://x.com/a/status/123",
      statusUrl: "https://x.com/example/status/456",
    });
  });

  it("rechecks the thread once when reply confirmation needs a reload", async () => {
    const adapter = createXAdapter();
    const { page, readPage } = createMockPage({
      replyComposeResult: { ok: true },
      confirmReply: false,
      confirmReplyAfterReload: true,
      statusUrl: "https://x.com/example/status/789",
    });

    const result = await adapter.callTool(
      { name: "tweet.reply", input: { url: "https://x.com/a/status/123", text: "hello there" } },
      { page: page as never },
    );

    expect(readPage.goto).toHaveBeenCalledTimes(2);
    expect(readPage.goto).toHaveBeenLastCalledWith("https://x.com/a/status/123", expect.anything());
    expect(result).toEqual({
      ok: true,
      confirmed: true,
      replyToUrl: "https://x.com/a/status/123",
      statusUrl: "https://x.com/example/status/789",
    });
  });

  it("fails closed when reply submit cannot be confirmed", async () => {
    const adapter = createXAdapter({ composeConfirmTimeoutMs: 100 });
    const { page } = createMockPage({
      replyComposeResult: { ok: true },
      confirmReply: false,
    });

    const result = await adapter.callTool(
      { name: "tweet.reply", input: { id: "123", text: "hello there" } },
      { page: page as never },
    );

    expect(result).toEqual({
      error: {
        code: "ACTION_UNCONFIRMED",
        message: "reply submit was not confirmed in timeline",
      },
    });
  });

  it("returns validation error for grok.chat without prompt", async () => {
    const adapter = createXAdapter();
    const { page } = createMockPage();

    const result = await adapter.callTool({ name: "grok.chat", input: {} }, { page: page as never });

    expect(result).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "prompt is required",
      },
    });
  });

  it("returns grok response when assistant output is confirmed", async () => {
    const adapter = createXAdapter();
    const { page, readPage } = createMockPage({
      grokComposeResult: { ok: true },
      confirmGrok: true,
      grokResponse: "Grok says hello from the mock adapter.",
    });

    const result = await adapter.callTool(
      { name: "grok.chat", input: { prompt: "say hello" } },
      { page: page as never },
    );

    expect(readPage.goto).toHaveBeenCalledWith("https://x.com/i/grok", expect.anything());
    expect(result).toEqual({
      ok: true,
      conversationId: "mock-conversation",
      response: "Grok says hello from the mock adapter.",
      url: "https://x.com/i/grok?conversation=mock-conversation",
    });
  });

  it("uploads local attachments before sending grok.chat", async () => {
    const adapter = createXAdapter();
    const tempDir = await mkdtemp(join(tmpdir(), "adapter-x-grok-upload-"));
    tempDirs.add(tempDir);
    const filePath = join(tempDir, "sample.csv");
    await writeFile(filePath, "name,value\nalpha,1\n");
    const { page, readPage, getUploadedFiles } = createMockPage({
      grokComposeResult: { ok: true },
      confirmGrok: true,
      grokResponse: "attachment ok",
    });

    const result = await adapter.callTool(
      {
        name: "grok.chat",
        input: {
          prompt: "use file",
          attachmentPaths: [filePath],
        },
      },
      { page: page as never },
    );

    expect(readPage.goto).toHaveBeenCalledWith("https://x.com/i/grok", expect.anything());
    expect(getUploadedFiles()).toEqual([filePath]);
    expect(result).toEqual({
      ok: true,
      conversationId: "mock-conversation",
      response: "attachment ok",
      url: "https://x.com/i/grok?conversation=mock-conversation",
    });
  });

  it("rejects relative attachment paths", async () => {
    const adapter = createXAdapter();
    const { page } = createMockPage();

    const result = await adapter.callTool(
      {
        name: "grok.chat",
        input: {
          prompt: "use file",
          attachmentPaths: ["sample.csv"],
        },
      },
      { page: page as never },
    );

    expect(result).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "attachmentPaths[0] must be an absolute file path",
      },
    });
  });

  it("materializes data-uri download links from grok.chat into local artifacts", async () => {
    const adapter = createXAdapter();
    const { page } = createMockPage({
      grokComposeResult: { ok: true },
      confirmGrok: true,
      grokRawResponse: [
        "{\"conversationId\":\"mock-conversation\"}",
        "{\"result\":{\"message\":\"[Download sample.csv](data:text/csv;base64,bmFtZSx2YWx1ZQphbHBoYSwxCg==)\",\"messageTag\":\"final\"}}",
        "{\"result\":{\"message\":\" DONE\",\"messageTag\":\"final\"}}",
      ].join("\n"),
      grokResponse: "Download sample.csv DONE",
    });

    const result = await adapter.callTool(
      { name: "grok.chat", input: { prompt: "make csv" } },
      { page: page as never },
    );

    expect(result).toMatchObject({
      ok: true,
      conversationId: "mock-conversation",
      response: "Download sample.csv DONE",
      url: "https://x.com/i/grok?conversation=mock-conversation",
      artifacts: [
        {
          kind: "file",
          name: "sample.csv",
          mimeType: "text/csv",
        },
      ],
    });
    const artifacts = (result as { artifacts?: Array<{ path: string }> }).artifacts ?? [];
    expect(artifacts[0]?.path).toMatch(/sample\.csv$/);
    if (artifacts[0]?.path) {
      tempDirs.add(dirname(artifacts[0].path));
    }
  });

  it("deduplicates artifact filenames from multiple data-uri links", async () => {
    const adapter = createXAdapter();
    const { page } = createMockPage({
      grokComposeResult: { ok: true },
      confirmGrok: true,
      grokRawResponse: [
        "{\"conversationId\":\"mock-conversation\"}",
        "{\"result\":{\"message\":\"[Download sample.csv](data:text/csv;base64,YQo=) [Download sample.csv](data:text/csv;base64,Ygo=)\",\"messageTag\":\"final\"}}",
      ].join("\n"),
      grokResponse: "Download sample.csv Download sample.csv",
    });

    const result = await adapter.callTool(
      { name: "grok.chat", input: { prompt: "make duplicate csv" } },
      { page: page as never },
    );

    const artifacts = (result as { artifacts?: Array<{ name: string; path: string }> }).artifacts ?? [];
    expect(artifacts.map((artifact) => artifact.name)).toEqual(["sample.csv", "sample-2.csv"]);
    for (const artifact of artifacts) {
      tempDirs.add(dirname(artifact.path));
    }
  });

  it("fails closed when grok response cannot be confirmed", async () => {
    const adapter = createXAdapter({ grokResponseTimeoutMs: 100 });
    const { page } = createMockPage({
      grokComposeResult: { ok: true },
      confirmGrok: false,
    });

    const result = await adapter.callTool(
      { name: "grok.chat", input: { prompt: "say hello" } },
      { page: page as never },
    );

    expect(result).toEqual({
      error: {
        code: "ACTION_UNCONFIRMED",
        message: "grok response was not confirmed",
      },
    });
  });

  it("returns validation error for tweet.get without id/url", async () => {
    const adapter = createXAdapter();
    const { page } = createMockPage();
    const result = await adapter.callTool({ name: "tweet.get", input: {} }, { page: page as never });
    expect(result).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "url or id is required",
      },
    });
  });

  it("returns validation error for tweet.thread.get without id/url", async () => {
    const adapter = createXAdapter();
    const { page } = createMockPage();
    const result = await adapter.callTool({ name: "tweet.thread.get", input: {} }, { page: page as never });
    expect(result).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "url or id is required",
      },
    });
  });

  it("returns validation error for tweet.conversation.get without id/url", async () => {
    const adapter = createXAdapter();
    const { page } = createMockPage();
    const result = await adapter.callTool({ name: "tweet.conversation.get", input: {} }, { page: page as never });
    expect(result).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "url or id is required",
      },
    });
  });

  it("returns validation error for tweet.replies.list without id/url", async () => {
    const adapter = createXAdapter();
    const { page } = createMockPage();
    const result = await adapter.callTool({ name: "tweet.replies.list", input: {} }, { page: page as never });
    expect(result).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "url or id is required",
      },
    });
  });

  it("reads tweet conversation by id", async () => {
    const adapter = createXAdapter();
    const { page } = createMockPage({
      timelineItems: [
        { id: "1", text: "ancestor tweet", url: "https://x.com/a/status/1" },
        { id: "123", text: "focal tweet", url: "https://x.com/a/status/123" },
        { id: "2", text: "reply one", url: "https://x.com/b/status/2" },
        { id: "3", text: "reply two", url: "https://x.com/c/status/3" },
      ],
    });

    const result = await adapter.callTool(
      { name: "tweet.conversation.get", input: { id: "123", limit: 2 } },
      { page: page as never },
    );

    expect(result).toEqual({
      focal: { id: "123", text: "focal tweet", url: "https://x.com/a/status/123" },
      ancestors: [{ id: "1", text: "ancestor tweet", url: "https://x.com/a/status/1" }],
      replies: [
        { id: "2", text: "reply one", url: "https://x.com/b/status/2" },
        { id: "3", text: "reply two", url: "https://x.com/c/status/3" },
      ],
      source: "network",
      hasMore: true,
      nextCursor: "cursor-next",
    });
  });

  it("caps conversation replies to limit while preserving pagination", async () => {
    const adapter = createXAdapter();
    const { page } = createMockPage({
      timelineItems: [
        { id: "1", text: "ancestor tweet", url: "https://x.com/a/status/1" },
        { id: "123", text: "focal tweet", url: "https://x.com/a/status/123" },
        { id: "2", text: "reply one", url: "https://x.com/b/status/2" },
        { id: "3", text: "reply two", url: "https://x.com/c/status/3" },
        { id: "4", text: "reply three", url: "https://x.com/d/status/4" },
      ],
    });

    const result = await adapter.callTool(
      { name: "tweet.conversation.get", input: { id: "123", limit: 2 } },
      { page: page as never },
    );

    expect(result).toEqual({
      focal: { id: "123", text: "focal tweet", url: "https://x.com/a/status/123" },
      ancestors: [{ id: "1", text: "ancestor tweet", url: "https://x.com/a/status/1" }],
      replies: [
        { id: "2", text: "reply one", url: "https://x.com/b/status/2" },
        { id: "3", text: "reply two", url: "https://x.com/c/status/3" },
      ],
      source: "network",
      hasMore: true,
      nextCursor: "cursor-next",
    });
  });

  it("reads tweet replies by id", async () => {
    const adapter = createXAdapter();
    const { page } = createMockPage({
      timelineItems: [
        { id: "1", text: "ancestor tweet", url: "https://x.com/a/status/1" },
        { id: "123", text: "focal tweet", url: "https://x.com/a/status/123" },
        { id: "2", text: "reply one", url: "https://x.com/b/status/2" },
        { id: "3", text: "reply two", url: "https://x.com/c/status/3" },
      ],
    });

    const result = await adapter.callTool(
      { name: "tweet.replies.list", input: { id: "123", limit: 2 } },
      { page: page as never },
    );

    expect(result).toEqual({
      focal: { id: "123", text: "focal tweet", url: "https://x.com/a/status/123" },
      items: [
        { id: "2", text: "reply one", url: "https://x.com/b/status/2" },
        { id: "3", text: "reply two", url: "https://x.com/c/status/3" },
      ],
      source: "network",
      hasMore: true,
      nextCursor: "cursor-next",
    });
  });

  it("reads tweet thread by id", async () => {
    const adapter = createXAdapter();
    const { page } = createMockPage({
      timelineItems: [
        { id: "1", text: "root tweet", url: "https://x.com/a/status/1" },
        { id: "123", text: "focal tweet", url: "https://x.com/a/status/123" },
        { id: "2", text: "same author reply", url: "https://x.com/a/status/2" },
        { id: "3", text: "other author reply", url: "https://x.com/b/status/3" },
      ],
    });

    const result = await adapter.callTool(
      { name: "tweet.thread.get", input: { id: "123", limit: 3 } },
      { page: page as never },
    );

    expect(result).toEqual({
      root: { id: "1", text: "root tweet", url: "https://x.com/a/status/1" },
      focal: { id: "123", text: "focal tweet", url: "https://x.com/a/status/123" },
      tweets: [
        { id: "1", text: "root tweet", url: "https://x.com/a/status/1" },
        { id: "123", text: "focal tweet", url: "https://x.com/a/status/123" },
        { id: "2", text: "same author reply", url: "https://x.com/a/status/2" },
      ],
      source: "network",
      incomplete: true,
      nextCursor: "cursor-next",
    });
  });

  it("keeps thread items in dom fallback when focal uses i/web status url", async () => {
    vi.resetModules();
    const { createXAdapter: createFreshXAdapter } = await import("../src/index.js");
    const adapter = createFreshXAdapter();
    const { page, behavior } = createMockPage({
      timelineItems: [
        { id: "123", text: "focal tweet", url: "https://x.com/i/web/status/123" },
        { id: "2", text: "same author reply", url: "https://x.com/a/status/2" },
        { id: "3", text: "other author reply", url: "https://x.com/b/status/3" },
      ],
    });
    behavior.requireFallbackTemplate = true;

    const result = await adapter.callTool(
      { name: "tweet.thread.get", input: { id: "123", limit: 3 } },
      { page: page as never },
    );

    expect(result).toEqual({
      root: { id: "123", text: "focal tweet", url: "https://x.com/i/web/status/123" },
      focal: { id: "123", text: "focal tweet", url: "https://x.com/i/web/status/123" },
      tweets: [
        { id: "123", text: "focal tweet", url: "https://x.com/i/web/status/123" },
        { id: "2", text: "same author reply", url: "https://x.com/a/status/2" },
        { id: "3", text: "other author reply", url: "https://x.com/b/status/3" },
      ],
      source: "dom",
      debug: { reason: "no_template" },
    });
  });

  it("reuses cached read page across favorites.list calls", async () => {
    const adapter = createXAdapter();
    const { page, newPage } = createMockPage();

    const first = await adapter.callTool({ name: "favorites.list", input: { limit: 1 } }, { page: page as never });
    const second = await adapter.callTool({ name: "favorites.list", input: { limit: 1 } }, { page: page as never });

    expect(newPage).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({
      source: "network",
      hasMore: true,
      nextCursor: "cursor-next",
    });
    expect(second).toMatchObject({
      source: "network",
    });
  });

  it("reads notifications from the notifications page", async () => {
    const adapter = createXAdapter();
    const { page, readPage } = createMockPage({
      timelineItems: [{ id: "n-1", text: "Alice liked your post", url: "https://x.com/a/status/1" }],
    });

    const result = await adapter.callTool(
      { name: "notifications.list", input: { limit: 1 } },
      { page: page as never },
    );

    expect(readPage.goto).toHaveBeenCalledWith("https://x.com/notifications", expect.anything());
    expect(result).toMatchObject({
      source: "dom",
      hasMore: false,
      items: [{ id: "n-1", text: "Alice liked your post", url: "https://x.com/a/status/1" }],
    });
  });

  it("reads mentions from the mentions page", async () => {
    const adapter = createXAdapter();
    const { page, readPage } = createMockPage({
      timelineItems: [{ id: "m-1", text: "@you thanks for sharing", url: "https://x.com/a/status/2" }],
    });

    const result = await adapter.callTool(
      { name: "mentions.list", input: { limit: 1 } },
      { page: page as never },
    );

    expect(readPage.goto).toHaveBeenCalledWith("https://x.com/notifications/mentions", expect.anything());
    expect(result).toMatchObject({
      source: "dom",
      hasMore: false,
      items: [{ id: "m-1", text: "@you thanks for sharing", url: "https://x.com/a/status/2" }],
    });
  });

  it("uses process-level template cache when capture is unavailable", async () => {
    const adapter = createXAdapter();
    const { page, behavior } = createMockPage();

    await adapter.callTool({ name: "favorites.list", input: { limit: 1 } }, { page: page as never });
    behavior.requireFallbackTemplate = true;
    const second = await adapter.callTool({ name: "favorites.list", input: { limit: 1 } }, { page: page as never });

    expect(second).toMatchObject({
      source: "network",
    });
  });

  it("returns validation error for timeline.user.list without username", async () => {
    const adapter = createXAdapter();
    const { page } = createMockPage();
    const result = await adapter.callTool({ name: "timeline.user.list", input: {} }, { page: page as never });
    expect(result).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "username is required",
      },
    });
  });

  it("reads user timeline with cursor pagination", async () => {
    const adapter = createXAdapter();
    const { page, readPage } = createMockPage({
      timelineItems: [{ id: "u-1", text: "user timeline card", url: "https://x.com/a/status/1" }],
      networkNextCursor: "user-next",
    });

    const result = await adapter.callTool(
      { name: "timeline.user.list", input: { username: "jack", limit: 1, cursor: "prev-user" } },
      { page: page as never },
    );

    expect(readPage.goto).toHaveBeenCalledWith("https://x.com/jack", expect.anything());
    expect(result).toMatchObject({
      source: "network",
      hasMore: true,
      nextCursor: "user-next",
      items: [{ id: "u-1", text: "user timeline card" }],
    });
  });

  it("reads search timeline with latest mode by default", async () => {
    const adapter = createXAdapter();
    const { page, readPage } = createMockPage({
      timelineItems: [{ id: "s-1", text: "search result", url: "https://x.com/a/status/2" }],
      networkNextCursor: "search-next",
    });

    const result = await adapter.callTool(
      { name: "search.tweets.list", input: { query: "playwright", limit: 1 } },
      { page: page as never },
    );

    expect(readPage.goto).toHaveBeenCalledWith(
      expect.stringContaining("https://x.com/search?q=playwright"),
      expect.anything(),
    );
    expect(readPage.goto).toHaveBeenCalledWith(
      expect.stringContaining("f=live"),
      expect.anything(),
    );
    expect(result).toMatchObject({
      source: "network",
      hasMore: true,
      nextCursor: "search-next",
      items: [{ id: "s-1", text: "search result" }],
    });
  });

  it("reads search timeline with top mode", async () => {
    const adapter = createXAdapter();
    const { page, readPage } = createMockPage();

    await adapter.callTool(
      { name: "search.tweets.list", input: { query: "typescript", mode: "top", limit: 1 } },
      { page: page as never },
    );

    expect(readPage.goto).toHaveBeenCalledWith(
      expect.stringContaining("https://x.com/search?q=typescript"),
      expect.anything(),
    );
    expect(readPage.goto).toHaveBeenCalledWith(
      expect.stringContaining("f=top"),
      expect.anything(),
    );
  });
});
