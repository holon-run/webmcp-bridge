/**
 * This module implements the X site fallback adapter with robust auth checks and compose confirmation.
 * It depends on Playwright page evaluation and shared adapter contracts to execute browser-side tool actions.
 */

import type { JsonValue } from "@webmcp-bridge/core";
import type { SiteAdapter, WebMcpToolDefinition } from "@webmcp-bridge/playwright";
import {
  buildRequestCaptureInitScript,
  captureRoutedResponseText,
  collectTextByTag,
  joinTextParts,
  parseNdjsonLines,
  type RequestTemplate,
  TemplateCache,
} from "@webmcp-bridge/adapter-utils";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import type { Page } from "playwright";

type XAuthState = "authenticated" | "auth_required" | "challenge_required";

type AuthProbeResult = {
  state: XAuthState;
  signals: string[];
};

type ComposeDomResult = {
  ok: boolean;
  dryRun?: boolean;
  reason?: string;
  submitVisible?: boolean;
};

type GrokComposeDomResult = {
  ok: boolean;
  reason?: string;
};

type ReplyComposeDomResult = {
  ok: boolean;
  dryRun?: boolean;
  reason?: string;
  submitVisible?: boolean;
};

type SubmitDomResult = {
  ok: boolean;
  reason?: string;
};

type GrokAttachment = {
  path: string;
  name: string;
  mimeType?: string;
};

type GrokArtifact = {
  kind: "file";
  name: string;
  path: string;
  mimeType?: string;
};

type TweetMediaVariant = {
  url: string;
  contentType?: string;
  bitrate?: number;
};

type TweetMedia = {
  type: "photo" | "video" | "animated_gif";
  url: string;
  previewUrl?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  variants?: TweetMediaVariant[];
};

type TweetMediaArtifact = {
  kind: "file";
  name: string;
  path: string;
  mimeType?: string;
  mediaIndex: number;
  sourceUrl: string;
};

type ArticleAttachment = {
  path: string;
  name: string;
};

type ArticleInlineImage = ArticleAttachment & {
  marker: string;
  alt?: string;
};

type ArticleDraftAssets = {
  markdown: string;
  inlineImages: ArticleInlineImage[];
};

export type CreateXAdapterOptions = {
  composeConfirmTimeoutMs?: number;
  grokResponseTimeoutMs?: number;
  articlePublishTimeoutMs?: number;
  maxPostLength?: number;
};

const DEFAULT_TIMELINE_LIMIT = 10;
const MAX_TIMELINE_LIMIT = 20;
const MAX_READ_PAGE_CACHE_SIZE = 8;
const DEFAULT_COMPOSE_CONFIRM_TIMEOUT_MS = 10_000;
const DEFAULT_GROK_RESPONSE_TIMEOUT_MS = 90_000;
const DEFAULT_ARTICLE_PUBLISH_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_POST_LENGTH = 280;
const AUTH_STABILIZE_ATTEMPTS = 6;
const AUTH_STABILIZE_DELAY_MS = 750;
const AUTH_WARMUP_TIMEOUT_MS = 12_000;
const GROK_ARTIFACT_DIR_PREFIX = "webmcp-bridge-grok-";
const TWEET_MEDIA_ARTIFACT_DIR_PREFIX = "webmcp-bridge-x-media-";
const ARTICLE_INLINE_IMAGE_MARKER_PREFIX = "[[WEBMCP_INLINE_IMAGE_";
const ALLOWED_TWEET_MEDIA_HOSTS = new Set(["pbs.twimg.com", "video.twimg.com"]);

const CAPTURE_INJECT_SCRIPT = buildRequestCaptureInitScript({
  globalKey: "__WEBMCP_X_CAPTURE__",
  shouldCaptureSource: String.raw`((url) => {
    if (typeof url !== "string") return false;
    return (
      url.includes("/i/api/graphql/") &&
      (
        url.includes("/HomeTimeline") ||
        url.includes("/Bookmarks") ||
        url.includes("/BookmarksAll") ||
        url.includes("/TweetDetail") ||
        url.includes("/UserTweets") ||
        url.includes("/UserMedia") ||
        url.includes("/UserTweetsAndReplies") ||
        url.includes("/SearchTimeline")
      )
    );
  })`,
  enrichEntrySource: String.raw`((entry) => {
    const url = typeof entry?.url === "string" ? entry.url : "";
    let op = "Unknown";
    if (url.includes("/HomeTimeline")) op = "HomeTimeline";
    else if (url.includes("/BookmarksAll")) op = "BookmarksAll";
    else if (url.includes("/Bookmarks")) op = "Bookmarks";
    else if (url.includes("/TweetDetail")) op = "TweetDetail";
    else if (url.includes("/UserTweetsAndReplies")) op = "UserTweetsAndReplies";
    else if (url.includes("/UserMedia")) op = "UserMedia";
    else if (url.includes("/UserTweets")) op = "UserTweets";
    else if (url.includes("/SearchTimeline")) op = "SearchTimeline";
    return { ...entry, op };
  })`,
  maxEntries: 80,
});

const TOOL_DEFINITIONS: WebMcpToolDefinition[] = [
  {
    name: "auth.get",
    description: "Detect login/challenge state",
    inputSchema: {
      type: "object",
      description: "No parameters.",
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  {
    name: "timeline.home.list",
    description: "Read home timeline tweet cards",
    inputSchema: {
      type: "object",
      description: "List tweets from your home timeline. Supports cursor pagination.",
      properties: {
        limit: {
          type: "integer",
          description: `Maximum number of tweets to return. Default ${DEFAULT_TIMELINE_LIMIT}, max ${MAX_TIMELINE_LIMIT}.`,
          minimum: 1,
          maximum: MAX_TIMELINE_LIMIT,
        },
        cursor: {
          type: "string",
          description: "Pagination cursor returned by previous call as nextCursor.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  {
    name: "tweet.get",
    description: "Read one tweet by url or id",
    inputSchema: {
      type: "object",
      description: "Fetch a single tweet using full URL or tweet id.",
      properties: {
        url: { type: "string", description: "Tweet URL, for example https://x.com/<user>/status/<id>." },
        id: { type: "string", description: "Tweet id. Used when url is not provided." },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  {
    name: "tweet.conversation.get",
    description: "Read one tweet conversation by url or id",
    inputSchema: {
      type: "object",
      description: "Fetch the focal tweet with its visible ancestors and replies from a tweet detail conversation.",
      properties: {
        url: { type: "string", description: "Tweet URL, for example https://x.com/<user>/status/<id>." },
        id: { type: "string", description: "Tweet id. Used when url is not provided." },
        limit: {
          type: "integer",
          description: `Maximum number of reply tweets to return. Default ${DEFAULT_TIMELINE_LIMIT}, max ${MAX_TIMELINE_LIMIT}.`,
          minimum: 1,
          maximum: MAX_TIMELINE_LIMIT,
        },
        cursor: {
          type: "string",
          description: "Pagination cursor returned by previous call as nextCursor.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  {
    name: "tweet.replies.list",
    description: "List replies for one tweet by url or id",
    inputSchema: {
      type: "object",
      description: "Fetch reply tweets for one focal tweet. Supports cursor pagination when the upstream detail response exposes a reply cursor.",
      properties: {
        url: { type: "string", description: "Tweet URL, for example https://x.com/<user>/status/<id>." },
        id: { type: "string", description: "Tweet id. Used when url is not provided." },
        limit: {
          type: "integer",
          description: `Maximum number of replies to return. Default ${DEFAULT_TIMELINE_LIMIT}, max ${MAX_TIMELINE_LIMIT}.`,
          minimum: 1,
          maximum: MAX_TIMELINE_LIMIT,
        },
        cursor: {
          type: "string",
          description: "Pagination cursor returned by previous call as nextCursor.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  {
    name: "tweet.thread.get",
    description: "Read one tweet thread by url or id",
    inputSchema: {
      type: "object",
      description: "Fetch the same-author thread chain around one focal tweet.",
      properties: {
        url: { type: "string", description: "Tweet URL, for example https://x.com/<user>/status/<id>." },
        id: { type: "string", description: "Tweet id. Used when url is not provided." },
        limit: {
          type: "integer",
          description: `Maximum number of thread tweets to return. Default ${DEFAULT_TIMELINE_LIMIT}, max ${MAX_TIMELINE_LIMIT}.`,
          minimum: 1,
          maximum: MAX_TIMELINE_LIMIT,
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  {
    name: "tweet.media.download",
    description: "Download media for one tweet by url or id",
    inputSchema: {
      type: "object",
      description: "Download one tweet's media to local artifact paths. Defaults to all media when mediaIndex is omitted.",
      properties: {
        url: { type: "string", description: "Tweet URL, for example https://x.com/<user>/status/<id>." },
        id: { type: "string", description: "Tweet id. Used when url is not provided." },
        mediaIndex: {
          type: "integer",
          description: "Optional zero-based media index to download. Omit to download all media items.",
          minimum: 0,
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  {
    name: "favorites.list",
    description: "Read bookmarks/favorites feed cards",
    inputSchema: {
      type: "object",
      description: "List tweets from bookmarks/favorites. Supports cursor pagination.",
      properties: {
        limit: {
          type: "integer",
          description: `Maximum number of tweets to return. Default ${DEFAULT_TIMELINE_LIMIT}, max ${MAX_TIMELINE_LIMIT}.`,
          minimum: 1,
          maximum: MAX_TIMELINE_LIMIT,
        },
        cursor: {
          type: "string",
          description: "Pagination cursor returned by previous call as nextCursor.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  {
    name: "notifications.list",
    description: "Read the main notifications feed",
    inputSchema: {
      type: "object",
      description: "List recent notifications from the authenticated account.",
      properties: {
        limit: {
          type: "integer",
          description: `Maximum number of notifications to return. Default ${DEFAULT_TIMELINE_LIMIT}, max ${MAX_TIMELINE_LIMIT}.`,
          minimum: 1,
          maximum: MAX_TIMELINE_LIMIT,
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  {
    name: "mentions.list",
    description: "Read the mentions tab from notifications",
    inputSchema: {
      type: "object",
      description: "List recent mention notifications where the account is referenced.",
      properties: {
        limit: {
          type: "integer",
          description: `Maximum number of mentions to return. Default ${DEFAULT_TIMELINE_LIMIT}, max ${MAX_TIMELINE_LIMIT}.`,
          minimum: 1,
          maximum: MAX_TIMELINE_LIMIT,
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  {
    name: "timeline.user.list",
    description: "Read one user's timeline tweet cards",
    inputSchema: {
      type: "object",
      description: "List tweets from a target user's profile timeline. Supports cursor pagination.",
      properties: {
        username: {
          type: "string",
          minLength: 1,
          description: "X username, with or without leading @.",
        },
        limit: {
          type: "integer",
          description: `Maximum number of tweets to return. Default ${DEFAULT_TIMELINE_LIMIT}, max ${MAX_TIMELINE_LIMIT}.`,
          minimum: 1,
          maximum: MAX_TIMELINE_LIMIT,
        },
        cursor: {
          type: "string",
          description: "Pagination cursor returned by previous call as nextCursor.",
        },
      },
      required: ["username"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  {
    name: "search.tweets.list",
    description: "Read search tweets list",
    inputSchema: {
      type: "object",
      description: "Search tweets by query. Supports cursor pagination.",
      properties: {
        query: { type: "string", minLength: 1, description: "Search query text." },
        mode: {
          type: "string",
          description: "Search ranking mode. Use latest for reverse-chronological results.",
          enum: ["top", "latest"],
        },
        limit: {
          type: "integer",
          description: `Maximum number of tweets to return. Default ${DEFAULT_TIMELINE_LIMIT}, max ${MAX_TIMELINE_LIMIT}.`,
          minimum: 1,
          maximum: MAX_TIMELINE_LIMIT,
        },
        cursor: {
          type: "string",
          description: "Pagination cursor returned by previous call as nextCursor.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  {
    name: "user.get",
    description: "Read a user profile summary by handle",
    inputSchema: {
      type: "object",
      description: "Read public profile information for one user.",
      properties: {
        handle: {
          type: "string",
          minLength: 1,
          description: "User handle, with or without leading @.",
        },
      },
      required: ["handle"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  {
    name: "tweet.create",
    description: "Publish a short text post",
    inputSchema: {
      type: "object",
      description: "Create a new post from the currently logged-in account.",
      properties: {
        text: {
          type: "string",
          description: `Post text content. Max length ${DEFAULT_MAX_POST_LENGTH}.`,
          minLength: 1,
          maxLength: DEFAULT_MAX_POST_LENGTH,
        },
        dryRun: {
          type: "boolean",
          description: "When true, validate compose path without submitting.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "tweet.reply",
    description: "Reply to one tweet by url or id",
    inputSchema: {
      type: "object",
      description: "Open a tweet detail page, compose one reply, and optionally skip final submit with dryRun.",
      properties: {
        url: { type: "string", description: "Tweet URL, for example https://x.com/<user>/status/<id>." },
        id: { type: "string", description: "Tweet id. Used when url is not provided." },
        text: {
          type: "string",
          description: `Reply text content. Max length ${DEFAULT_MAX_POST_LENGTH}.`,
          minLength: 1,
          maxLength: DEFAULT_MAX_POST_LENGTH,
        },
        dryRun: {
          type: "boolean",
          description: "When true, validate the reply compose path without submitting.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "grok.chat",
    description: "Send one prompt to Grok from the authenticated X session",
    inputSchema: {
      type: "object",
      description:
        "Ask Grok from the authenticated X session. Starts a new chat by default; pass conversationId to continue an existing conversation.",
      properties: {
        prompt: {
          type: "string",
          description: "Prompt text to send to Grok.",
          minLength: 1,
        },
        conversationId: {
          type: "string",
          description: "Existing Grok conversation id. When omitted, the adapter starts a new chat before asking.",
          minLength: 1,
        },
        attachmentPaths: {
          type: "array",
          description: "Optional local files to upload with the prompt.",
          items: {
            type: "string",
            description: "Absolute local file path to upload through the browser session.",
            minLength: 1,
            "x-uxc-kind": "file-path",
          },
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "article.draftMarkdown",
    description: "Create one X article draft from a local markdown file",
    inputSchema: {
      type: "object",
      description:
        "Create one X article draft from a local markdown file. The adapter derives the title from the first markdown heading when title is omitted.",
      properties: {
        markdownPath: {
          type: "string",
          description: "Absolute local file path to the markdown file to draft.",
          minLength: 1,
          "x-uxc-kind": "file-path",
        },
        title: {
          type: "string",
          description: "Optional title override. When omitted, the first markdown heading becomes the article title.",
          minLength: 1,
        },
        coverImagePath: {
          type: "string",
          description: "Optional absolute local image path for the article cover image.",
          minLength: 1,
          "x-uxc-kind": "file-path",
        },
      },
      required: ["markdownPath"],
      additionalProperties: false,
    },
  },
  {
    name: "article.publishMarkdown",
    description: "Publish one X article from a local markdown file",
    inputSchema: {
      type: "object",
      description:
        "Create and publish one X article from a local markdown file. The adapter derives the title from the first markdown heading when title is omitted.",
      properties: {
        markdownPath: {
          type: "string",
          description: "Absolute local file path to the markdown file to publish.",
          minLength: 1,
          "x-uxc-kind": "file-path",
        },
        title: {
          type: "string",
          description: "Optional title override. When omitted, the first markdown heading becomes the article title.",
          minLength: 1,
        },
        coverImagePath: {
          type: "string",
          description: "Optional absolute local image path for the article cover image.",
          minLength: 1,
          "x-uxc-kind": "file-path",
        },
        dryRun: {
          type: "boolean",
          description: "When true, validate article creation and editor population without publishing.",
        },
      },
      required: ["markdownPath"],
      additionalProperties: false,
    },
  },
  {
    name: "article.publish",
    description: "Publish one existing X article draft by edit url, public url, or id",
    inputSchema: {
      type: "object",
      description: "Open one article editor page and publish the current draft.",
      properties: {
        url: {
          type: "string",
          description: "Article edit URL or public article URL.",
          minLength: 1,
        },
        id: {
          type: "string",
          description: "Article id. Used when url is not provided.",
          minLength: 1,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "article.setCoverImage",
    description: "Set or replace the cover image for one existing X article draft",
    inputSchema: {
      type: "object",
      description: "Open one article editor page and set the cover image for the current draft.",
      properties: {
        url: {
          type: "string",
          description: "Article edit URL or public article URL.",
          minLength: 1,
        },
        id: {
          type: "string",
          description: "Article id. Used when url is not provided.",
          minLength: 1,
        },
        coverImagePath: {
          type: "string",
          description: "Absolute local image path for the article cover image.",
          minLength: 1,
          "x-uxc-kind": "file-path",
        },
      },
      required: ["coverImagePath"],
      additionalProperties: false,
    },
  },
  {
    name: "article.updateMarkdown",
    description: "Replace the title and body of one existing X article draft from a local markdown file",
    inputSchema: {
      type: "object",
      description:
        "Open one article editor page, replace the current title and body from a local markdown file, and upload any local inline images referenced by markdown image syntax.",
      properties: {
        url: {
          type: "string",
          description: "Article edit URL or public article URL.",
          minLength: 1,
        },
        id: {
          type: "string",
          description: "Article id. Used when url is not provided.",
          minLength: 1,
        },
        markdownPath: {
          type: "string",
          description: "Absolute local file path to the markdown file to apply.",
          minLength: 1,
          "x-uxc-kind": "file-path",
        },
        title: {
          type: "string",
          description: "Optional title override. When omitted, the first markdown heading becomes the article title.",
          minLength: 1,
        },
      },
      required: ["markdownPath"],
      additionalProperties: false,
    },
  },
  {
    name: "article.delete",
    description: "Delete one X article draft or published article by edit url, public url, or id",
    inputSchema: {
      type: "object",
      description: "Open one article editor page and delete the article after confirmation.",
      properties: {
        url: {
          type: "string",
          description: "Article edit URL or public article URL.",
          minLength: 1,
        },
        id: {
          type: "string",
          description: "Article id. Used when url is not provided.",
          minLength: 1,
        },
        dryRun: {
          type: "boolean",
          description: "When true, validate delete controls without confirming the destructive action.",
        },
      },
      additionalProperties: false,
    },
  },
];

function toRecord(value: JsonValue): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function errorResult(code: string, message: string, details?: JsonValue): JsonValue {
  const error: Record<string, JsonValue> = {
    code,
    message,
  };
  if (details !== undefined) {
    error.details = details;
  }
  return { error };
}

function sanitizeArtifactName(name: string): string {
  const trimmed = name.trim();
  const normalized = trimmed.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : "artifact.bin";
}

function inferArtifactExtension(mimeType?: string): string {
  switch ((mimeType ?? "").toLowerCase()) {
    case "text/csv":
      return ".csv";
    case "application/json":
      return ".json";
    case "text/plain":
      return ".txt";
    case "text/markdown":
      return ".md";
    case "application/pdf":
      return ".pdf";
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    default:
      return ".bin";
  }
}

function inferArtifactNameFromLabel(label: string, mimeType?: string): string {
  const match = label.match(/([A-Za-z0-9._-]+\.[A-Za-z0-9]+)\b/);
  const matchedName = match?.[1];
  if (matchedName) {
    return sanitizeArtifactName(matchedName);
  }
  const base = sanitizeArtifactName(label.replace(/\s+/g, " ").trim() || "artifact");
  const extension = extname(base) || inferArtifactExtension(mimeType);
  return extname(base) ? base : `${base}${extension}`;
}

function inferArtifactNameFromUrl(url: string, fallbackBase: string, mimeType?: string): string {
  try {
    const parsed = new URL(url);
    const pathnameName = basename(parsed.pathname);
    const format = parsed.searchParams.get("format")?.trim();
    if (pathnameName) {
      const safePathName = sanitizeArtifactName(pathnameName);
      if (extname(safePathName)) {
        return safePathName;
      }
      if (format) {
        return `${safePathName}.${sanitizeArtifactName(format).replace(/^\.+/, "")}`;
      }
    }
    if (format) {
      return `${sanitizeArtifactName(fallbackBase)}.${sanitizeArtifactName(format).replace(/^\.+/, "")}`;
    }
  } catch {
    // Fall through to MIME-based fallback.
  }
  return inferArtifactNameFromLabel(fallbackBase, mimeType);
}

function parseDataUri(uri: string): { mimeType?: string; buffer: Buffer } | undefined {
  if (!uri.startsWith("data:")) {
    return undefined;
  }
  const commaIndex = uri.indexOf(",");
  if (commaIndex < 0) {
    return undefined;
  }
  const meta = uri.slice(5, commaIndex);
  const payload = uri.slice(commaIndex + 1);
  const parts = meta.split(";").filter((part) => part.length > 0);
  const mimeType = parts[0] && !parts[0].includes("=") ? parts[0] : undefined;
  const isBase64 = parts.includes("base64");
  try {
    const buffer = isBase64
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf8");
    return mimeType ? { mimeType, buffer } : { buffer };
  } catch {
    return undefined;
  }
}

function toTweetMediaArray(value: unknown): TweetMedia[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const output: TweetMedia[] = [];
  for (const rawEntry of value) {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      continue;
    }
    const entry = rawEntry as Record<string, unknown>;
    const type = entry.type;
    const url = entry.url;
    if (
      (type !== "photo" && type !== "video" && type !== "animated_gif")
      || typeof url !== "string"
      || url.trim().length === 0
    ) {
      continue;
    }
    const media: TweetMedia = {
      type,
      url,
    };
    if (typeof entry.previewUrl === "string" && entry.previewUrl.trim()) {
      media.previewUrl = entry.previewUrl;
    }
    if (typeof entry.width === "number" && Number.isFinite(entry.width)) {
      media.width = entry.width;
    }
    if (typeof entry.height === "number" && Number.isFinite(entry.height)) {
      media.height = entry.height;
    }
    if (typeof entry.durationMs === "number" && Number.isFinite(entry.durationMs)) {
      media.durationMs = entry.durationMs;
    }
    if (Array.isArray(entry.variants)) {
      const variants = entry.variants.flatMap((rawVariant) => {
        if (!rawVariant || typeof rawVariant !== "object" || Array.isArray(rawVariant)) {
          return [];
        }
        const variantRecord = rawVariant as Record<string, unknown>;
        if (typeof variantRecord.url !== "string" || !variantRecord.url.trim()) {
          return [];
        }
        const variant: TweetMediaVariant = { url: variantRecord.url };
        if (typeof variantRecord.contentType === "string" && variantRecord.contentType.trim()) {
          variant.contentType = variantRecord.contentType;
        }
        if (typeof variantRecord.bitrate === "number" && Number.isFinite(variantRecord.bitrate)) {
          variant.bitrate = variantRecord.bitrate;
        }
        return [variant];
      });
      if (variants.length > 0) {
        media.variants = variants;
      }
    }
    output.push(media);
  }
  return output;
}

function normalizeTweetMediaForDownload(media: TweetMedia): TweetMedia {
  if (media.type !== "photo") {
    return media;
  }
  try {
    const parsed = new URL(media.url);
    if (parsed.hostname.includes("pbs.twimg.com") && !parsed.searchParams.has("name")) {
      parsed.searchParams.set("name", "orig");
      return {
        ...media,
        url: parsed.toString(),
      };
    }
  } catch {
    return media;
  }
  return media;
}

async function materializeGrokArtifacts(
  response: string,
): Promise<{ response: string; artifacts?: GrokArtifact[] }> {
  const matches = Array.from(response.matchAll(/\[([^\]]+)\]\((data:[^)]+)\)/g));
  if (matches.length === 0) {
    return { response };
  }

  const artifacts: GrokArtifact[] = [];
  const reservedNames = new Set<string>();
  let artifactDir: string | undefined;
  let cleanedResponse = response;

  for (const match of matches) {
    const label = match[1] ?? "artifact";
    const dataUri = match[2] ?? "";
    const parsed = parseDataUri(dataUri);
    if (!parsed) {
      continue;
    }
    let name = inferArtifactNameFromLabel(label, parsed.mimeType);
    if (reservedNames.has(name)) {
      const extension = extname(name);
      const stem = extension ? name.slice(0, -extension.length) : name;
      let suffix = 2;
      do {
        name = `${stem}-${suffix}${extension}`;
        suffix += 1;
      } while (reservedNames.has(name));
    }
    reservedNames.add(name);
    if (!artifactDir) {
      artifactDir = await mkdtemp(join(tmpdir(), GROK_ARTIFACT_DIR_PREFIX));
    }
    const path = join(artifactDir, name);
    await writeFile(path, parsed.buffer);
    const artifact: GrokArtifact = {
      kind: "file",
      name,
      path,
    };
    if (parsed.mimeType) {
      artifact.mimeType = parsed.mimeType;
    }
    artifacts.push(artifact);
    cleanedResponse = cleanedResponse.replace(match[0], `${label.trim() || name} `);
  }

  const output = {
    response: cleanedResponse.replace(/[ \t]+\n/g, "\n").replace(/\s{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim(),
  } as { response: string; artifacts?: GrokArtifact[] };
  if (artifacts.length > 0) {
    output.artifacts = artifacts;
  }
  return output;
}

async function materializeTweetMediaArtifacts(
  tweet: TimelineItem,
  mediaEntries: Array<{ mediaIndex: number; media: TweetMedia }>,
): Promise<TweetMediaArtifact[]> {
  let artifactDir: string | undefined;
  const reservedNames = new Set<string>();
  const artifacts: TweetMediaArtifact[] = [];

  try {
    for (const entry of mediaEntries) {
      const normalizedMedia = normalizeTweetMediaForDownload(entry.media);
      let mediaUrl: URL;
      try {
        mediaUrl = new URL(normalizedMedia.url);
      } catch {
        throw new Error("invalid_media_url");
      }
      if (mediaUrl.protocol !== "https:" || !ALLOWED_TWEET_MEDIA_HOSTS.has(mediaUrl.hostname)) {
        throw new Error(`unsupported_media_url:${mediaUrl.toString()}`);
      }
      const response = await fetch(mediaUrl.toString());
      if (!response.ok) {
        throw new Error(`media_download_http_${response.status}|${mediaUrl.toString()}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const contentTypeHeader = response.headers.get("content-type")?.split(";")[0]?.trim() || undefined;
      const fallbackBase = `${tweet.id}-media-${entry.mediaIndex + 1}`;
      let name = inferArtifactNameFromUrl(normalizedMedia.url, fallbackBase, contentTypeHeader);
      if (reservedNames.has(name)) {
        const extension = extname(name);
        const stem = extension ? name.slice(0, -extension.length) : name;
        let suffix = 2;
        do {
          name = `${stem}-${suffix}${extension}`;
          suffix += 1;
        } while (reservedNames.has(name));
      }
      reservedNames.add(name);
      if (!artifactDir) {
        artifactDir = await mkdtemp(join(tmpdir(), TWEET_MEDIA_ARTIFACT_DIR_PREFIX));
      }
      const path = join(artifactDir, name);
      await writeFile(path, Buffer.from(arrayBuffer));
      const artifact: TweetMediaArtifact = {
        kind: "file",
        name,
        path,
        mediaIndex: entry.mediaIndex,
        sourceUrl: normalizedMedia.url,
      };
      if (contentTypeHeader) {
        artifact.mimeType = contentTypeHeader;
      }
      artifacts.push(artifact);
    }
  } catch (error) {
    if (artifactDir) {
      await rm(artifactDir, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }

  return artifacts;
}

function mapTweetMediaDownloadError(error: unknown): JsonValue {
  const message = error instanceof Error && error.message ? error.message : "media download failed";
  if (message.startsWith("media_download_http_")) {
    const [statusPart = "", urlPart = ""] = message.replace("media_download_http_", "").split("|", 2);
    const status = Number.parseInt(statusPart, 10);
    return errorResult(
      "HTTP_ERROR",
      Number.isFinite(status)
        ? `media download returned HTTP ${status}`
        : "media download returned an HTTP error",
      typeof urlPart === "string" && urlPart ? { url: urlPart } : undefined,
    );
  }
  if (message.startsWith("unsupported_media_url:")) {
    const url = message.slice("unsupported_media_url:".length);
    return errorResult("VALIDATION_ERROR", "media URL is not on an allowed host", { url });
  }
  if (message === "invalid_media_url") {
    return errorResult("UPSTREAM_CHANGED", "tweet media URL is invalid");
  }
  return errorResult("UPSTREAM_CHANGED", message);
}

async function resolveGrokAttachments(input: unknown): Promise<{ ok: true; attachments: GrokAttachment[] } | { ok: false; result: JsonValue }> {
  if (input === undefined) {
    return { ok: true, attachments: [] };
  }
  if (!Array.isArray(input)) {
    return {
      ok: false,
      result: errorResult("VALIDATION_ERROR", "attachmentPaths must be an array"),
    };
  }

  const attachments: GrokAttachment[] = [];
  for (const [index, rawPath] of input.entries()) {
    const path = typeof rawPath === "string" ? rawPath.trim() : "";
    if (!path) {
      return {
        ok: false,
        result: errorResult("VALIDATION_ERROR", `attachmentPaths[${index}] must be a non-empty string`),
      };
    }
    if (!isAbsolute(path)) {
      return {
        ok: false,
        result: errorResult("VALIDATION_ERROR", `attachmentPaths[${index}] must be an absolute file path`),
      };
    }
    try {
      const fileStat = await stat(path);
      if (!fileStat.isFile()) {
        return {
          ok: false,
          result: errorResult("VALIDATION_ERROR", `attachmentPaths[${index}] must point to a file`),
        };
      }
    } catch {
      return {
        ok: false,
        result: errorResult("VALIDATION_ERROR", `attachmentPaths[${index}] was not found`),
      };
    }

    const resolvedAttachment: GrokAttachment = {
      path,
      name: basename(path),
    };
    attachments.push(resolvedAttachment);
  }

  return { ok: true, attachments };
}

async function resolveArticleAttachment(
  value: unknown,
  fieldName: string,
): Promise<{ ok: true; attachment?: ArticleAttachment } | { ok: false; result: JsonValue }> {
  if (value === undefined) {
    return { ok: true };
  }
  const path = typeof value === "string" ? value.trim() : "";
  if (!path) {
    return {
      ok: false,
      result: errorResult("VALIDATION_ERROR", `${fieldName} must be a non-empty string`),
    };
  }
  if (!isAbsolute(path)) {
    return {
      ok: false,
      result: errorResult("VALIDATION_ERROR", `${fieldName} must be an absolute file path`),
    };
  }
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile()) {
      return {
        ok: false,
        result: errorResult("VALIDATION_ERROR", `${fieldName} must point to a file`),
      };
    }
  } catch {
    return {
      ok: false,
      result: errorResult("VALIDATION_ERROR", `${fieldName} was not found`),
    };
  }
  return {
    ok: true,
    attachment: {
      path,
      name: basename(path),
    },
  };
}

function stripMarkdownImageDestination(rawDestination: string): string {
  const trimmed = rawDestination.trim();
  const withoutAngle = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed;
  const titleMatch = withoutAngle.match(/^(.+?)(?:\s+["'(].*)?$/);
  return (titleMatch?.[1] ?? withoutAngle).trim();
}

function extractArticleTitle(markdown: string, markdownPath: string, explicitTitle?: string): string {
  const title = typeof explicitTitle === "string" ? explicitTitle.trim() : "";
  if (title) {
    return title;
  }
  const headingMatch = markdown.match(/^\s*#\s+(.+?)\s*$/m);
  if (headingMatch?.[1]) {
    return headingMatch[1].trim();
  }
  return basename(markdownPath, extname(markdownPath)).trim() || "Untitled";
}

function prepareArticleMarkdown(markdown: string, markdownPath: string): ArticleDraftAssets {
  const inlineImages: ArticleInlineImage[] = [];
  let nextIndex = 1;
  const prepared = markdown.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, altRaw: string, destinationRaw: string) => {
    const destination = stripMarkdownImageDestination(destinationRaw);
    if (/^(?:https?:|data:)/i.test(destination)) {
      return _match;
    }
    const resolvedPath = isAbsolute(destination) ? destination : resolve(dirname(markdownPath), destination);
    const marker = `${ARTICLE_INLINE_IMAGE_MARKER_PREFIX}${nextIndex}]]`;
    nextIndex += 1;
    const image: ArticleInlineImage = {
      marker,
      path: resolvedPath,
      name: basename(resolvedPath),
    };
    const alt = altRaw.trim();
    if (alt) {
      image.alt = alt;
    }
    inlineImages.push(image);
    return `\n\n${marker}\n\n`;
  });
  return {
    markdown: prepared,
    inlineImages,
  };
}

function normalizeTimelineLimit(input: Record<string, unknown>): number {
  const rawLimit = input.limit;
  if (typeof rawLimit !== "number" || !Number.isFinite(rawLimit)) {
    return DEFAULT_TIMELINE_LIMIT;
  }
  return Math.max(1, Math.min(MAX_TIMELINE_LIMIT, Math.floor(rawLimit)));
}

async function ensureNetworkCaptureInstalled(page: Page): Promise<void> {
  await page.addInitScript(CAPTURE_INJECT_SCRIPT);
  await page.evaluate(CAPTURE_INJECT_SCRIPT);
}

type TimelineMode = "home" | "bookmarks" | "tweet" | "user_timeline" | "search";

async function hasCapturedTemplate(page: Page, mode: TimelineMode): Promise<boolean> {
  const result = await page.evaluate(({ targetMode }) => {
    const globalAny = window as unknown as {
      __WEBMCP_X_CAPTURE__?: {
        entries?: Array<{ op?: string }>;
      };
    };
    const entries = Array.isArray(globalAny.__WEBMCP_X_CAPTURE__?.entries)
      ? globalAny.__WEBMCP_X_CAPTURE__?.entries ?? []
      : [];
    const ops =
      targetMode === "home"
        ? ["HomeTimeline", "TweetDetail"]
        : targetMode === "bookmarks"
          ? ["BookmarksAll", "Bookmarks"]
          : targetMode === "tweet"
            ? ["TweetDetail"]
            : targetMode === "user_timeline"
              ? ["UserTweets", "UserTweetsAndReplies", "UserMedia"]
              : ["SearchTimeline"];
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (entry && typeof entry.op === "string" && ops.includes(entry.op)) {
        return true;
      }
    }
    return false;
  }, { targetMode: mode });
  return result === true;
}

async function warmupNetworkTemplate(page: Page, mode: Exclude<TimelineMode, "tweet">): Promise<void> {
  if (await hasCapturedTemplate(page, mode)) {
    return;
  }
  await waitForTweetSurface(page);
  await page
    .evaluate(() => {
      window.scrollTo(0, Math.max(document.body.scrollHeight * 0.8, 1200));
    })
    .catch(() => {});
  await page.waitForTimeout(900);
  if (await hasCapturedTemplate(page, mode)) {
    return;
  }
  await page
    .evaluate(() => {
      window.scrollTo(0, 0);
    })
    .catch(() => {});
  await page.waitForTimeout(700);
  if (await hasCapturedTemplate(page, mode)) {
    return;
  }
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  await waitForTweetSurface(page);
}

async function detectAuth(page: Page): Promise<AuthProbeResult> {
  return await page.evaluate(({ op }: { op: string }): AuthProbeResult => {
    void op;
    const signals: string[] = [];

    const challengeSelectors = [
      "form[action*='account/access']",
      "input[name='verification_string']",
      "iframe[title*='challenge']",
    ];
    const loginSelectors = [
      "input[name='text']",
      "input[autocomplete='username']",
      "a[href='/login']",
      "a[href*='/i/flow/login']",
    ];
    const authenticatedSelectors = [
      "[data-testid='AppTabBar_Home_Link']",
      "[data-testid='SideNav_NewTweet_Button']",
      "[data-testid='tweetTextarea_0']",
      "nav[aria-label='Primary']",
    ];

    const hasSelector = (selectors: string[]): boolean => {
      return selectors.some((selector) => document.querySelector(selector) !== null);
    };

    const bodyText = (document.body?.innerText ?? "").toLowerCase();
    const pathname = location.pathname.toLowerCase();

    const hasChallengeUi =
      hasSelector(challengeSelectors) ||
      pathname.includes("/account/access") ||
      bodyText.includes("are you human") ||
      bodyText.includes("unusual activity") ||
      bodyText.includes("challenge");

    if (hasChallengeUi) {
      signals.push("challenge_ui");
      return { state: "challenge_required", signals };
    }

    if (hasSelector(authenticatedSelectors)) {
      signals.push("authenticated_ui");
      return { state: "authenticated", signals };
    }

    if (hasSelector(loginSelectors) || pathname.includes("/login") || pathname.includes("/i/flow/login")) {
      signals.push("login_ui");
      return { state: "auth_required", signals };
    }

    signals.push("auth_unknown");
    return { state: "auth_required", signals };
  }, { op: "detect_auth" });
}

async function detectAuthStable(page: Page): Promise<AuthProbeResult> {
  let auth = await detectAuth(page);
  for (let attempt = 1; attempt < AUTH_STABILIZE_ATTEMPTS; attempt += 1) {
    const shouldRetry = auth.state === "auth_required" && auth.signals.includes("auth_unknown");
    if (!shouldRetry) {
      return auth;
    }
    await page.waitForTimeout(AUTH_STABILIZE_DELAY_MS);
    auth = await detectAuth(page);
  }
  return auth;
}

async function warmupAuthProbe(page: Page): Promise<void> {
  const deadline = Date.now() + AUTH_WARMUP_TIMEOUT_MS;
  for (;;) {
    const auth = await detectAuth(page);
    const stable = !(auth.state === "auth_required" && auth.signals.includes("auth_unknown"));
    if (stable || Date.now() >= deadline) {
      return;
    }
    await page.waitForTimeout(AUTH_STABILIZE_DELAY_MS);
  }
}

type TweetCard = {
  id: string;
  text: string;
  url?: string;
  author?: string;
  createdAt?: string;
  media?: TweetMedia[];
};

type TimelineItem = {
  id: string;
  text: string;
  url?: string;
  kind?: string;
  summary?: string;
  tweetText?: string;
  media?: TweetMedia[];
};

type TimelinePage = {
  items: TimelineItem[];
  source: "network" | "dom";
  hasMore: boolean;
  nextCursor?: string;
  debug?: {
    reason: string;
  };
};

function normalizeInlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function canonicalizeStatusUrl(input: string | undefined, fallbackId?: string): string | undefined {
  if (!input) {
    return undefined;
  }
  try {
    const url = new URL(input);
    const segments = url.pathname.split("/").filter(Boolean);
    const statusIndex = segments.findIndex((segment) => segment === "status");
    if (statusIndex < 0) {
      return input;
    }
    const statusId = segments[statusIndex + 1] ?? fallbackId;
    if (!statusId) {
      return input;
    }
    if (segments[0] === "i" && segments[1] === "web") {
      return `${url.origin}/i/web/status/${statusId}`;
    }
    const handle = segments[0];
    if (!handle) {
      return `${url.origin}/i/web/status/${statusId}`;
    }
    return `${url.origin}/${handle}/status/${statusId}`;
  } catch {
    return input;
  }
}

function enrichNotificationItem(item: TimelineItem): TimelineItem {
  const text = normalizeInlineText(item.text);
  const summary = item.summary ? normalizeInlineText(item.summary) : undefined;
  const tweetText = item.tweetText ? normalizeInlineText(item.tweetText) : undefined;
  const next: TimelineItem = {
    id: item.id,
    text,
  };
  if (item.url) {
    next.url = item.url;
  }
  if (summary) {
    next.summary = summary;
  }
  if (tweetText) {
    next.tweetText = tweetText;
  }
  if (item.media && item.media.length > 0) {
    next.media = item.media;
  }
  if (item.kind) {
    next.kind = item.kind;
  }

  const likeMatch = text.match(/^(.+?liked your post·\s*\S+)\s+(?:Article\s+)?(.+)$/i);
  if (likeMatch?.[1] && likeMatch[2]) {
    next.kind = next.kind ?? "like";
    next.summary = next.summary ?? normalizeInlineText(likeMatch[1]);
    next.tweetText = next.tweetText ?? normalizeInlineText(likeMatch[2]);
    next.text = next.tweetText;
    return next;
  }

  const repostMatch = text.match(/^(.+?reposted(?: your post)?·\s*\S+)\s+(.+)$/i);
  if (repostMatch?.[1] && repostMatch[2]) {
    next.kind = next.kind ?? "repost";
    next.summary = next.summary ?? normalizeInlineText(repostMatch[1]);
    next.tweetText = next.tweetText ?? normalizeInlineText(repostMatch[2]);
    next.text = next.tweetText;
    return next;
  }

  const replyMatch = text.match(/^(.+?Replying to @\w+(?:.*?·\s*\S+)?)\s+(.+)$/i);
  if (replyMatch?.[1] && replyMatch[2]) {
    next.kind = next.kind ?? "reply";
    next.summary = next.summary ?? normalizeInlineText(replyMatch[1]);
    next.tweetText = next.tweetText ?? normalizeInlineText(replyMatch[2]);
    next.text = next.tweetText;
    return next;
  }

  const followMatch = text.match(/^(.+?followed you(?:·\s*\S+)?)$/i);
  if (followMatch?.[1]) {
    next.kind = next.kind ?? "follow";
    next.summary = next.summary ?? normalizeInlineText(followMatch[1]);
    return next;
  }

  if (!next.kind && next.url) {
    next.kind = "mention";
  }
  return next;
}

type ReadPageKey = string;
type ProcessTemplateBucket = TimelineMode;

type ReadPageCacheEntry = {
  key: string;
  page: Page;
};

type ReadPageCacheState = {
  pages: Map<string, ReadPageCacheEntry>;
  lru: string[];
};

const READ_PAGE_CACHE = new WeakMap<Page, ReadPageCacheState>();
const ARTICLE_DRAFT_PAGE_CACHE = new WeakMap<Page, Map<string, Page>>();
const PROCESS_TEMPLATE_CACHE = new TemplateCache<ProcessTemplateBucket, RequestTemplate>();

async function readTimelineViaNetwork(
  page: Page,
  options: {
    mode: TimelineMode;
    limit: number;
    cursor?: string;
    tweetId?: string;
  },
): Promise<{ items: TweetCard[]; nextCursor?: string; source: "network" | "dom"; reason?: string }> {
  const fallbackTemplate = PROCESS_TEMPLATE_CACHE.get(options.mode);
  const response = await page.evaluate(
    async ({ mode, limit, cursor: inputCursor, tweetId, cachedTemplate }) => {
      const globalAny = window as unknown as {
        __WEBMCP_X_CAPTURE__?: {
          entries?: Array<{
            op?: string;
            url?: string;
            method?: string;
            headers?: Record<string, string>;
            body?: string;
            responseJson?: unknown;
          }>;
        };
      };

      const capture = globalAny.__WEBMCP_X_CAPTURE__;
      const entries = Array.isArray(capture?.entries) ? capture.entries : [];

      const pickTemplate = (): {
        url: string;
        method: string;
        headers: Record<string, string>;
        body?: string;
      } | null => {
        const acceptOps =
          mode === "home"
            ? ["HomeTimeline", "TweetDetail"]
            : mode === "bookmarks"
              ? ["BookmarksAll", "Bookmarks"]
              : mode === "tweet"
                ? ["TweetDetail"]
                : mode === "user_timeline"
                  ? ["UserTweets", "UserTweetsAndReplies", "UserMedia"]
                  : ["SearchTimeline"];

        for (let i = entries.length - 1; i >= 0; i -= 1) {
          const entry = entries[i];
          if (!entry || !entry.op || !entry.url || !entry.method) {
            continue;
          }
          if (!acceptOps.includes(entry.op)) {
            continue;
          }
          const output: {
            url: string;
            method: string;
            headers: Record<string, string>;
            body?: string;
          } = {
            url: entry.url,
            method: entry.method,
            headers: entry.headers ?? {},
          };
          if (entry.body !== undefined) {
            output.body = entry.body;
          }
          return output;
        }
        return null;
      };

      const template = pickTemplate() ?? cachedTemplate ?? null;
      if (!template) {
        return { items: [], source: "dom" as const, reason: "no_template" };
      }

      const parseJsonSafely = (value: string | null): Record<string, unknown> => {
        if (!value) {
          return {};
        }
        try {
          const parsed = JSON.parse(value);
          return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
        } catch {
          return {};
        }
      };

      const normalizeText = (value: string): string => value.replace(/\s+/g, " ").trim();
      const collectMedia = (value: unknown): Array<Record<string, unknown>> => {
        if (!Array.isArray(value)) {
          return [];
        }
        const output: Array<Record<string, unknown>> = [];
        for (const rawEntry of value) {
          if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
            continue;
          }
          const entry = rawEntry as Record<string, unknown>;
          const type = entry.type;
          const mediaUrlHttps = typeof entry.media_url_https === "string" ? entry.media_url_https : "";
          const mediaUrl = typeof entry.media_url === "string" ? entry.media_url : "";
          const previewUrl = mediaUrlHttps || mediaUrl;
          if (type !== "photo" && type !== "video" && type !== "animated_gif") {
            continue;
          }

          const originalInfo = (entry.original_info as Record<string, unknown> | undefined) ?? {};
          const nextMedia: Record<string, unknown> = {
            type,
            url: previewUrl,
          };
          if (previewUrl) {
            nextMedia.previewUrl = previewUrl;
          }
          if (typeof originalInfo.w === "number" && Number.isFinite(originalInfo.w)) {
            nextMedia.width = originalInfo.w;
          }
          if (typeof originalInfo.h === "number" && Number.isFinite(originalInfo.h)) {
            nextMedia.height = originalInfo.h;
          }

          if (type === "video" || type === "animated_gif") {
            const videoInfo = (entry.video_info as Record<string, unknown> | undefined) ?? {};
            if (typeof videoInfo.duration_millis === "number" && Number.isFinite(videoInfo.duration_millis)) {
              nextMedia.durationMs = videoInfo.duration_millis;
            }
            const variants = Array.isArray(videoInfo.variants) ? videoInfo.variants : [];
            const normalizedVariants = variants.flatMap((rawVariant) => {
              if (!rawVariant || typeof rawVariant !== "object" || Array.isArray(rawVariant)) {
                return [];
              }
              const variant = rawVariant as Record<string, unknown>;
              const variantUrl = typeof variant.url === "string" ? variant.url : "";
              if (!variantUrl) {
                return [];
              }
              const nextVariant: Record<string, unknown> = { url: variantUrl };
              if (typeof variant.content_type === "string" && variant.content_type) {
                nextVariant.contentType = variant.content_type;
              }
              if (typeof variant.bitrate === "number" && Number.isFinite(variant.bitrate)) {
                nextVariant.bitrate = variant.bitrate;
              }
              return [nextVariant];
            });
            if (normalizedVariants.length > 0) {
              nextMedia.variants = normalizedVariants;
              const mp4Variants = normalizedVariants.filter((variant) => variant.contentType === "video/mp4");
              const preferredVariant = (mp4Variants.length > 0 ? mp4Variants : normalizedVariants)
                .slice()
                .sort((left, right) => {
                  const leftBitrate = typeof left.bitrate === "number" ? left.bitrate : -1;
                  const rightBitrate = typeof right.bitrate === "number" ? right.bitrate : -1;
                  return rightBitrate - leftBitrate;
                })[0];
              if (preferredVariant && typeof preferredVariant.url === "string" && preferredVariant.url) {
                nextMedia.url = preferredVariant.url;
              }
            }
          }

          if (typeof nextMedia.url === "string" && nextMedia.url) {
            output.push(nextMedia);
          }
        }
        return output;
      };

      const collectFromResult = (input: unknown): { items: TweetCard[]; nextCursor?: string } => {
        const outputItems: TweetCard[] = [];
        const seen = new Set<string>();
        let nextCursor: string | undefined;

        const visit = (value: unknown): void => {
          if (!value || typeof value !== "object") {
            return;
          }
          if (Array.isArray(value)) {
            for (const item of value) {
              visit(item);
            }
            return;
          }
          const record = value as Record<string, unknown>;
          const entryId = typeof record.entryId === "string" ? record.entryId : "";
          const content = (record.content ?? {}) as Record<string, unknown>;
          const entryType = typeof content.entryType === "string" ? content.entryType : "";

          if (!nextCursor && entryType === "TimelineTimelineCursor") {
            const cursorType = typeof content.cursorType === "string" ? content.cursorType : "";
            const cursorValue = typeof content.value === "string" ? content.value : "";
            if (cursorType.toLowerCase().includes("bottom") && cursorValue) {
              nextCursor = cursorValue;
            }
          }

          if (entryId.includes("cursor-bottom") && !nextCursor) {
            const cursorValue = typeof content.value === "string" ? content.value : "";
            if (cursorValue) {
              nextCursor = cursorValue;
            }
          }

          const contentItem = (content.item as Record<string, unknown> | undefined) ?? undefined;
          const contentItemContent = (contentItem?.itemContent as Record<string, unknown> | undefined) ?? undefined;
          const itemContent = (content.itemContent as Record<string, unknown> | undefined) ?? contentItemContent;
          const tweetResults = (itemContent?.tweet_results as Record<string, unknown> | undefined)?.result;
          let tweet = tweetResults as Record<string, unknown> | undefined;
          if (tweet && typeof tweet === "object" && "tweet" in tweet) {
            tweet = tweet.tweet as Record<string, unknown>;
          }
          const restId = typeof tweet?.rest_id === "string" ? tweet.rest_id : "";
          const legacy = (tweet?.legacy as Record<string, unknown> | undefined) ?? {};
          const entities = (legacy.entities as Record<string, unknown> | undefined) ?? {};
          const extendedEntities = (legacy.extended_entities as Record<string, unknown> | undefined) ?? entities;
          const fullText =
            typeof legacy.full_text === "string"
              ? legacy.full_text
              : typeof legacy.text === "string"
                ? legacy.text
                : "";
          const noteText =
            (((tweet?.note_tweet as Record<string, unknown> | undefined)?.note_tweet_results as Record<string, unknown> | undefined)
              ?.result as Record<string, unknown> | undefined)?.text;
          const text = normalizeText(typeof noteText === "string" && noteText ? noteText : fullText);
          const media = collectMedia(extendedEntities.media);

          if (restId && text) {
            const userResult = (((tweet?.core as Record<string, unknown> | undefined)?.user_results as Record<string, unknown> | undefined)
              ?.result as Record<string, unknown> | undefined) ?? {};
            const userLegacy = (userResult.legacy as Record<string, unknown> | undefined) ?? {};
            const screenName = typeof userLegacy.screen_name === "string" ? userLegacy.screen_name : "";
            const authorName = typeof userLegacy.name === "string" ? userLegacy.name : "";
            const createdAt = typeof legacy.created_at === "string" ? legacy.created_at : undefined;
            const key = `${restId}:${text}`;
            if (!seen.has(key)) {
              seen.add(key);
              const item: TweetCard = {
                id: restId,
                text,
              };
              if (screenName) {
                item.url = `https://x.com/${screenName}/status/${restId}`;
                item.author = authorName ? `${authorName}@${screenName}` : `@${screenName}`;
              }
              if (createdAt) {
                item.createdAt = createdAt;
              }
              if (media.length > 0) {
                item.media = media as unknown as TweetMedia[];
              }
              outputItems.push(item);
            }
          }

          for (const nested of Object.values(record)) {
            visit(nested);
          }
        };

        visit(input);
        const result: { items: TweetCard[]; nextCursor?: string } = { items: outputItems };
        if (nextCursor !== undefined) {
          result.nextCursor = nextCursor;
        }
        return result;
      };

      const sanitizeHeaders = (headers?: Record<string, string>): Record<string, string> => {
        const blockedPrefixes = ["sec-", ":"];
        const blockedExact = new Set(["host", "content-length", "cookie", "origin", "referer", "connection"]);
        const output: Record<string, string> = {};
        if (!headers) {
          return output;
        }
        for (const [key, value] of Object.entries(headers)) {
          const k = key.toLowerCase();
          if (blockedExact.has(k)) {
            continue;
          }
          if (blockedPrefixes.some((prefix) => k.startsWith(prefix))) {
            continue;
          }
          output[k] = value;
        }
        return output;
      };

      const templateUrl = new URL(template.url, location.origin);
      const templateVariables = parseJsonSafely(templateUrl.searchParams.get("variables"));
      const templateFeatures = parseJsonSafely(templateUrl.searchParams.get("features"));
      const templateFieldToggles = parseJsonSafely(templateUrl.searchParams.get("fieldToggles"));
      const headers = sanitizeHeaders(template.headers);

      const cursor: string | undefined = typeof inputCursor === "string" && inputCursor ? inputCursor : undefined;

      const createRequestUrl = (): string => {
        const vars = { ...templateVariables };
        if (mode === "tweet" && tweetId) {
          vars.focalTweetId = tweetId;
        }
        vars.count = Math.max(20, limit);
        if (cursor) {
          vars.cursor = cursor;
        } else {
          delete vars.cursor;
        }
        const next = new URL(template.url, location.origin);
        next.searchParams.set("variables", JSON.stringify(vars));
        if (Object.keys(templateFeatures).length > 0) {
          next.searchParams.set("features", JSON.stringify(templateFeatures));
        }
        if (Object.keys(templateFieldToggles).length > 0) {
          next.searchParams.set("fieldToggles", JSON.stringify(templateFieldToggles));
        }
        return next.toString();
      };

      const requestUrl = createRequestUrl();
      let response: Response;
      try {
        response = await fetch(requestUrl, {
          method: template.method,
          headers,
          credentials: "include",
        });
      } catch {
        return { items: [], source: "dom" as const, reason: "request_failed" };
      }
      if (!response.ok) {
        return {
          items: [],
          source: "dom" as const,
          reason: `http_error_${response.status}`,
        };
      }
      let responseJson: unknown;
      try {
        responseJson = await response.json();
      } catch {
        return { items: [], source: "dom" as const, reason: "response_parse_failed" };
      }

      const parsed = collectFromResult(responseJson);
      const result: {
        items: TweetCard[];
        nextCursor?: string;
        source: "network" | "dom";
        reason?: string;
        selectedTemplate?: RequestTemplate;
      } = {
        items: parsed.items.slice(0, limit),
        source: parsed.items.length > 0 ? ("network" as const) : ("dom" as const),
        selectedTemplate: template,
      };
      if (parsed.nextCursor) {
        result.nextCursor = parsed.nextCursor;
      }
      if (parsed.items.length === 0) {
        result.reason = "empty_result";
      }
      return result;
    },
    {
      mode: options.mode,
      limit: options.limit,
      cursor: options.cursor,
      tweetId: options.tweetId,
      cachedTemplate: fallbackTemplate,
    },
  );

  if (
    !response ||
    typeof response !== "object" ||
    !("items" in response) ||
    !Array.isArray((response as { items?: unknown }).items)
  ) {
    return { items: [], source: "dom", reason: "invalid_response" };
  }
  const typed = response as {
    items: TweetCard[];
    nextCursor?: string;
    source: "network" | "dom";
    reason?: string;
    selectedTemplate?: {
      url?: unknown;
      method?: unknown;
      headers?: unknown;
      body?: unknown;
    };
  };

  const selectedTemplate = typed.selectedTemplate;
  if (
    selectedTemplate &&
    typeof selectedTemplate.url === "string" &&
    typeof selectedTemplate.method === "string"
  ) {
    const cacheValue: RequestTemplate = {
      url: selectedTemplate.url,
      method: selectedTemplate.method,
    };
    if (
      typeof selectedTemplate.headers === "object" &&
      selectedTemplate.headers !== null &&
      !Array.isArray(selectedTemplate.headers)
    ) {
      cacheValue.headers = selectedTemplate.headers as Record<string, string>;
    }
    if (typeof selectedTemplate.body === "string") {
      cacheValue.body = selectedTemplate.body;
    }
    PROCESS_TEMPLATE_CACHE.set(options.mode, cacheValue);
  }

  const result: { items: TweetCard[]; nextCursor?: string; source: "network" | "dom"; reason?: string } = {
    items: typed.items,
    source: typed.source,
  };
  if (typeof typed.nextCursor === "string" && typed.nextCursor.length > 0) {
    result.nextCursor = typed.nextCursor;
  }
  if (typeof typed.reason === "string" && typed.reason.length > 0) {
    result.reason = typed.reason;
  }
  return result;
}

async function extractTweetCards(
  page: Page,
  limit: number,
): Promise<Array<{ id: string; text: string; url?: string; author?: string; createdAt?: string; media?: TweetMedia[] }>> {
  const cards = await page.evaluate(({ maxItems }: { maxItems: number }) => {
    const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
    const cleanText = (value: string): string => {
      return normalize(
        value
          .replace(/\bPromote\b/gi, " ")
          .replace(/\bShow translation\b/gi, " ")
          .replace(/\bRelevant View activity\b/gi, " ")
          .replace(/\bPost your reply\b/gi, " ")
          .replace(/\bReply\b$/gi, " ")
          .replace(/\bShow more replies\b/gi, " "),
      );
    };
    const canonicalizeStatusUrl = (input?: string, fallbackId?: string): string | undefined => {
      if (!input) {
        return undefined;
      }
      try {
        const url = new URL(input);
        const segments = url.pathname.split("/").filter(Boolean);
        const statusIndex = segments.findIndex((segment) => segment === "status");
        if (statusIndex < 0) {
          return input;
        }
        const statusId = segments[statusIndex + 1] ?? fallbackId;
        if (!statusId) {
          return input;
        }
        if (segments[0] === "i" && segments[1] === "web") {
          return `${url.origin}/i/web/status/${statusId}`;
        }
        const handle = segments[0];
        if (!handle) {
          return `${url.origin}/i/web/status/${statusId}`;
        }
        return `${url.origin}/${handle}/status/${statusId}`;
      } catch {
        return input;
      }
    };
    const dedupe = new Set<string>();
    const items: Array<{ id: string; text: string; url?: string; author?: string; createdAt?: string; media?: TweetMedia[] }> = [];
    const collectDomMedia = (root: ParentNode): Array<Record<string, unknown>> => {
      const output: Array<Record<string, unknown>> = [];
      const seen = new Set<string>();
      const pushMedia = (entry: Record<string, unknown>): void => {
        const key = `${String(entry.type ?? "")}:${String(entry.url ?? "")}`;
        if (!entry.url || seen.has(key)) {
          return;
        }
        seen.add(key);
        output.push(entry);
      };

      const imageNodes = Array.from(root.querySelectorAll<HTMLImageElement>("img[src*='pbs.twimg.com/media']"));
      for (const image of imageNodes) {
        const src = image.currentSrc || image.src || "";
        if (!src) {
          continue;
        }
        const media: Record<string, unknown> = {
          type: "photo",
          url: src,
        };
        if (Number.isFinite(image.naturalWidth) && image.naturalWidth > 0) {
          media.width = image.naturalWidth;
        }
        if (Number.isFinite(image.naturalHeight) && image.naturalHeight > 0) {
          media.height = image.naturalHeight;
        }
        pushMedia(media);
      }

      const videoNodes = Array.from(root.querySelectorAll<HTMLVideoElement>("video[src], video source[src]"));
      for (const node of videoNodes) {
        const src = (node instanceof HTMLSourceElement ? node.src : node.currentSrc || node.src) || "";
        if (!src) {
          continue;
        }
        pushMedia({
          type: "video",
          url: src,
        });
      }

      return output;
    };
    const pushItem = (item: { id: string; text: string; url?: string; author?: string; createdAt?: string; media?: TweetMedia[] }): void => {
      const dedupeKey = `${item.id}:${item.text}`;
      if (!item.text || dedupe.has(dedupeKey)) {
        return;
      }
      dedupe.add(dedupeKey);
      items.push(item);
    };

    const articles = Array.from(document.querySelectorAll<HTMLElement>("article"));
    for (const article of articles) {
      const statusAnchor = article.querySelector<HTMLAnchorElement>("a[href*='/status/']");
      const matchedId = statusAnchor?.href?.match(/status\/(\d+)/)?.[1];
      const url = canonicalizeStatusUrl(statusAnchor?.href, matchedId);
      const id = url?.match(/status\/(\d+)/)?.[1] ?? `article-${items.length + 1}`;

      const tweetTextNode = article.querySelector<HTMLElement>("[data-testid='tweetText']");
      const mergedText = cleanText(tweetTextNode?.innerText || tweetTextNode?.textContent || "");
      const fallbackText = cleanText(article.innerText || article.textContent || "");
      const text = mergedText || fallbackText;
      if (!text) {
        continue;
      }

      const authorRaw = article.querySelector<HTMLElement>("[data-testid='User-Name']")?.textContent ?? "";
      const createdAtRaw = article.querySelector<HTMLTimeElement>("time")?.dateTime ?? "";
      const item: { id: string; text: string; url?: string; author?: string; createdAt?: string; media?: TweetMedia[] } = { id, text };
      if (url) {
        item.url = url;
      }
      const author = normalize(authorRaw);
      if (author) {
        item.author = author;
      }
      if (createdAtRaw) {
        item.createdAt = createdAtRaw;
      }
      const media = collectDomMedia(article);
      if (media.length > 0) {
        item.media = media as unknown as TweetMedia[];
      }
      pushItem(item);
      if (items.length >= maxItems) {
        break;
      }
    }

    if (items.length < maxItems) {
      const cells = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='cellInnerDiv']"));
      for (const cell of cells) {
        if (items.length >= maxItems) {
          break;
        }
        const tweetTextNode = cell.querySelector<HTMLElement>("[data-testid='tweetText']");
        const text = cleanText(tweetTextNode?.innerText || tweetTextNode?.textContent || cell.innerText || cell.textContent || "");
        if (!text || text.length < 16) {
          continue;
        }
        const statusAnchor = cell.querySelector<HTMLAnchorElement>("a[href*='/status/']");
        const matchedId = statusAnchor?.href?.match(/status\/(\d+)/)?.[1];
        const url = canonicalizeStatusUrl(statusAnchor?.href, matchedId);
        const id = url?.match(/status\/(\d+)/)?.[1] ?? `cell-${items.length + 1}`;
        const item: { id: string; text: string; url?: string; media?: TweetMedia[] } = { id, text };
        if (url) {
          item.url = url;
        }
        const media = collectDomMedia(cell);
        if (media.length > 0) {
          item.media = media as unknown as TweetMedia[];
        }
        pushItem(item);
      }
    }

    if (items.length === 0) {
      const bodyText = cleanText(document.body?.innerText || "");
      if (bodyText) {
        const snippet = bodyText.slice(0, 280);
        pushItem({
          id: "fallback-body-1",
          text: snippet,
        });
      }
    }
    return items;
  }, { maxItems: limit });
  return cards;
}

async function scrollTweetDetailSurface(page: Page): Promise<boolean> {
  return await page.evaluate(({ op }) => {
    void op;
    const viewportHeight = window.innerHeight || 0;
    const scrollHeight = Math.max(document.documentElement?.scrollHeight ?? 0, document.body?.scrollHeight ?? 0);
    const beforeY = window.scrollY;
    const maxScrollY = Math.max(0, scrollHeight - viewportHeight);
    const delta = Math.max(Math.floor(viewportHeight * 0.9), 900);
    const targetY = Math.min(beforeY + delta, maxScrollY);
    window.scrollTo({ top: targetY, behavior: "instant" });
    return targetY > beforeY;
  }, { op: "scroll_tweet_detail_surface" });
}

async function extractTweetCardsAcrossScroll(
  page: Page,
  limit: number,
): Promise<Array<{ id: string; text: string; url?: string; author?: string; createdAt?: string; media?: TweetMedia[] }>> {
  let merged = mergeTimelineItems(mapTweetCards(await extractTweetCards(page, limit)));
  let stagnantIterations = 0;

  for (let attempt = 0; attempt < 6 && merged.length < limit; attempt += 1) {
    const didScroll = await scrollTweetDetailSurface(page);
    if (!didScroll) {
      break;
    }
    await page.waitForTimeout(1_000);
    const nextCards = mergeTimelineItems([...merged, ...mapTweetCards(await extractTweetCards(page, limit))]);
    if (nextCards.length <= merged.length) {
      stagnantIterations += 1;
      if (stagnantIterations >= 2) {
        break;
      }
    } else {
      stagnantIterations = 0;
    }
    merged = nextCards;
  }

  const hasCanonicalStatusItem = merged.some((item) => Boolean(item.url?.includes("/status/")));
  if (hasCanonicalStatusItem) {
    merged = merged.filter((item) => !item.id.startsWith("fallback-body-"));
  }

  return merged.slice(0, limit).map((item) => {
    const nextItem: { id: string; text: string; url?: string; media?: TweetMedia[] } = {
      id: item.id,
      text: item.text,
    };
    if (item.url) {
      nextItem.url = item.url;
    }
    if (item.media && item.media.length > 0) {
      nextItem.media = item.media;
    }
    return nextItem;
  });
}

async function extractNotificationCards(
  page: Page,
  limit: number,
): Promise<Array<{ id: string; text: string; url?: string; kind?: string; summary?: string; tweetText?: string }>> {
  return await page.evaluate(({ op, maxItems }) => {
    if (op !== "extract_notifications") {
      return [];
    }

    const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
    const classifySummary = (value: string): string => {
      const text = value.toLowerCase();
      if (text.includes("followed you")) return "follow";
      if (text.includes("liked your post")) return "like";
      if (text.includes("reposted your post") || text.includes("reposted")) return "repost";
      if (text.includes("replying to @") || text.includes("replied")) return "reply";
      if (text.includes("@")) return "mention";
      return "notification";
    };
    const isGenericHelperText = (value: string): boolean => {
      const text = value.toLowerCase();
      return (
        text.includes("control which conversations you're mentioned in") ||
        text.includes("control which conversations you’re mentioned in") ||
        (text.includes("learn more") && text.includes("mentioned"))
      );
    };
    const scoreItem = (value: { text: string; summary?: string; tweetText?: string }): number => {
      const text = normalize(value.text);
      let score = text.length;
      if (value.summary) {
        score += 100;
      }
      if (value.tweetText) {
        score += 60;
      }
      return score;
    };
    const pickPreferred = (
      current:
        | { id: string; text: string; url?: string; kind?: string; summary?: string; tweetText?: string }
        | undefined,
      next: { id: string; text: string; url?: string; kind?: string; summary?: string; tweetText?: string },
    ): { id: string; text: string; url?: string; kind?: string; summary?: string; tweetText?: string } => {
      if (!current) {
        return next;
      }
      return scoreItem(next) > scoreItem(current) ? next : current;
    };

    const byKey = new Map<
      string,
      { id: string; text: string; url?: string; kind?: string; summary?: string; tweetText?: string }
    >();
    const pushItem = (item: {
      id: string;
      text: string;
      url?: string;
      kind?: string;
      summary?: string;
      tweetText?: string;
    }): void => {
      const text = normalize(item.text);
      if (!text || isGenericHelperText(text)) {
        return;
      }
      const normalizedItem: {
        id: string;
        text: string;
        url?: string;
        kind?: string;
        summary?: string;
        tweetText?: string;
      } = {
        id: item.id,
        text,
      };
      if (item.url) {
        normalizedItem.url = item.url;
      }
      if (item.kind) {
        normalizedItem.kind = item.kind;
      }
      if (item.summary) {
        normalizedItem.summary = normalize(item.summary);
      }
      if (item.tweetText) {
        normalizedItem.tweetText = normalize(item.tweetText);
      }
      const dedupeKey = item.url ? `url:${item.url}` : `text:${text.toLowerCase()}`;
      byKey.set(dedupeKey, pickPreferred(byKey.get(dedupeKey), normalizedItem));
    };

    const articles = Array.from(document.querySelectorAll<HTMLElement>("article"));
    for (const article of articles) {
      const statusAnchor = article.querySelector<HTMLAnchorElement>("a[href*='/status/']");
      const url = statusAnchor?.href;
      const id = url?.match(/status\/(\d+)/)?.[1] ?? `article-${byKey.size + 1}`;
      const textNodes = Array.from(article.querySelectorAll<HTMLElement>("[data-testid='tweetText'], div[lang], div[dir='auto']"));
      const tweetText = normalize(textNodes.map((node) => node.textContent || "").join(" "));
      const fallbackText = normalize(article.innerText || article.textContent || "");
      const summary = tweetText ? normalize(fallbackText.replace(tweetText, "")) : "";
      const item: { id: string; text: string; url?: string; kind?: string; summary?: string; tweetText?: string } = {
        id,
        text: tweetText || fallbackText,
      };
      if (url) {
        item.url = url;
      }
      if (summary) {
        item.summary = summary;
        item.kind = classifySummary(summary);
      }
      if (tweetText) {
        item.tweetText = tweetText;
      }
      pushItem(item);
    }

    if (byKey.size < maxItems) {
      const cells = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='cellInnerDiv']"));
      for (const cell of cells) {
        const fallbackText = normalize(cell.innerText || cell.textContent || "");
        const tweetNode = cell.querySelector<HTMLElement>("[data-testid='tweetText'], div[lang], div[dir='auto']");
        const tweetText = normalize(tweetNode?.innerText || tweetNode?.textContent || "");
        const summary = tweetText ? normalize(fallbackText.replace(tweetText, "")) : "";
        const statusAnchor = cell.querySelector<HTMLAnchorElement>("a[href*='/status/']");
        const url = statusAnchor?.href;
        const id = url?.match(/status\/(\d+)/)?.[1] ?? `cell-${byKey.size + 1}`;
        const item: { id: string; text: string; url?: string; kind?: string; summary?: string; tweetText?: string } = {
          id,
          text: tweetText || fallbackText,
        };
        if (url) {
          item.url = url;
        }
        if (summary) {
          item.summary = summary;
          item.kind = classifySummary(summary);
        }
        if (tweetText) {
          item.tweetText = tweetText;
        }
        pushItem(item);
      }
    }

    return Array.from(byKey.values()).slice(0, maxItems);
  }, { op: "extract_notifications", maxItems: limit });
}

async function withEphemeralReadOnlyPage<T>(page: Page, url: string, run: (readPage: Page) => Promise<T>): Promise<T> {
  const context = page.context();
  const readPage = await context.newPage();
  try {
    await ensureNetworkCaptureInstalled(readPage);
    await readPage.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitForTweetSurface(readPage);
    return await run(readPage);
  } finally {
    await readPage.close().catch(() => {});
  }
}

async function withEphemeralPage<T>(page: Page, url: string, run: (ephemeralPage: Page) => Promise<T>): Promise<T> {
  const context = page.context();
  const ephemeralPage = await context.newPage();
  try {
    await ensureNetworkCaptureInstalled(ephemeralPage);
    await ephemeralPage.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    return await run(ephemeralPage);
  } finally {
    await ephemeralPage.close().catch(() => {});
  }
}

function getReadPageCacheState(page: Page): ReadPageCacheState {
  let state = READ_PAGE_CACHE.get(page);
  if (!state) {
    state = {
      pages: new Map<string, ReadPageCacheEntry>(),
      lru: [],
    };
    READ_PAGE_CACHE.set(page, state);
  }
  return state;
}

function isSameLocation(currentUrl: string, targetUrl: string): boolean {
  try {
    const current = new URL(currentUrl);
    const target = new URL(targetUrl);
    return current.origin === target.origin && current.pathname === target.pathname && current.search === target.search;
  } catch {
    return false;
  }
}

function touchReadPageLru(state: ReadPageCacheState, key: string): void {
  const next = state.lru.filter((item) => item !== key);
  next.push(key);
  state.lru = next;
}

async function evictReadPagesIfNeeded(state: ReadPageCacheState): Promise<void> {
  while (state.lru.length > MAX_READ_PAGE_CACHE_SIZE) {
    const evictKey = state.lru.shift();
    if (!evictKey) {
      return;
    }
    const entry = state.pages.get(evictKey);
    state.pages.delete(evictKey);
    if (entry && !entry.page.isClosed()) {
      await entry.page.close().catch(() => {});
    }
  }
}

async function getOrCreateCachedReadPage(ownerPage: Page, key: ReadPageKey, url: string): Promise<Page> {
  const state = getReadPageCacheState(ownerPage);
  const existing = state.pages.get(key);
  if (existing && !existing.page.isClosed()) {
    const currentUrl = existing.page.url();
    if (!isSameLocation(currentUrl, url)) {
      await existing.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await waitForTweetSurface(existing.page);
    }
    touchReadPageLru(state, key);
    return existing.page;
  }

  const readPage = await ownerPage.context().newPage();
  await ensureNetworkCaptureInstalled(readPage);
  await readPage.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForTweetSurface(readPage);
  state.pages.set(key, { key, page: readPage });
  touchReadPageLru(state, key);
  await evictReadPagesIfNeeded(state);
  return readPage;
}

async function withCachedReadOnlyPage<T>(
  ownerPage: Page,
  key: ReadPageKey,
  url: string,
  run: (readPage: Page) => Promise<T>,
): Promise<T> {
  const readPage = await getOrCreateCachedReadPage(ownerPage, key, url);
  return await run(readPage);
}

async function closeCachedReadPages(ownerPage: Page): Promise<void> {
  const state = READ_PAGE_CACHE.get(ownerPage);
  READ_PAGE_CACHE.delete(ownerPage);
  if (!state) {
    return;
  }
  for (const entry of state.pages.values()) {
    if (!entry.page.isClosed()) {
      await entry.page.close().catch(() => {});
    }
  }
}

function getArticleDraftPageCache(ownerPage: Page): Map<string, Page> {
  let cache = ARTICLE_DRAFT_PAGE_CACHE.get(ownerPage);
  if (!cache) {
    cache = new Map<string, Page>();
    ARTICLE_DRAFT_PAGE_CACHE.set(ownerPage, cache);
  }
  return cache;
}

async function cacheArticleDraftPage(ownerPage: Page, articleId: string, articlePage: Page): Promise<void> {
  const cache = getArticleDraftPageCache(ownerPage);
  const existing = cache.get(articleId);
  if (existing && existing !== articlePage && !existing.isClosed()) {
    await existing.close().catch(() => {});
  }
  cache.set(articleId, articlePage);
}

function getCachedArticleDraftPage(ownerPage: Page, articleId: string): Page | undefined {
  const cache = ARTICLE_DRAFT_PAGE_CACHE.get(ownerPage);
  const page = cache?.get(articleId);
  if (!page || page.isClosed()) {
    cache?.delete(articleId);
    return undefined;
  }
  return page;
}

async function removeCachedArticleDraftPage(ownerPage: Page, articleId: string): Promise<void> {
  const cache = ARTICLE_DRAFT_PAGE_CACHE.get(ownerPage);
  const page = cache?.get(articleId);
  cache?.delete(articleId);
  if (page && !page.isClosed()) {
    await page.close().catch(() => {});
  }
}

async function closeCachedArticleDraftPages(ownerPage: Page): Promise<void> {
  const cache = ARTICLE_DRAFT_PAGE_CACHE.get(ownerPage);
  ARTICLE_DRAFT_PAGE_CACHE.delete(ownerPage);
  if (!cache) {
    return;
  }
  for (const articlePage of cache.values()) {
    if (!articlePage.isClosed()) {
      await articlePage.close().catch(() => {});
    }
  }
}

async function waitForTweetSurface(page: Page): Promise<void> {
  await page
    .waitForFunction(() => {
      const articleCount = document.querySelectorAll("article").length;
      const cellCount = document.querySelectorAll("[data-testid='cellInnerDiv']").length;
      const hasTweetText = document.querySelectorAll("[data-testid='tweetText'], div[lang], div[dir='auto']").length > 0;
      return articleCount > 0 || cellCount > 0 || hasTweetText;
    }, undefined, { timeout: 8_000 })
    .catch(() => {});
  await page.waitForTimeout(1_000);
}

function mapTweetCards(items: TweetCard[]): TimelineItem[] {
  return items.map((item) => {
    const mapped: TimelineItem = {
      id: item.id,
      text: item.text,
    };
    if (item.url) {
      mapped.url = item.url;
    }
    if (item.media && item.media.length > 0) {
      mapped.media = item.media;
    }
    return mapped;
  });
}

function getTimelineStatusId(item: TimelineItem): string {
  if (item.id && !item.id.startsWith("article-") && !item.id.startsWith("cell-")) {
    return item.id;
  }
  return item.url?.match(/status\/(\d+)/)?.[1] ?? "";
}

function getTimelineDedupeKey(item: TimelineItem): string {
  const statusId = getTimelineStatusId(item);
  if (statusId) {
    return `id:${statusId}`;
  }
  if (item.url) {
    return `url:${item.url}`;
  }
  return `text:${item.text}`;
}

function pickPreferredTimelineItem(current: TimelineItem | undefined, next: TimelineItem): TimelineItem {
  if (!current) {
    return next;
  }
  const score = (item: TimelineItem): number => {
    let total = item.text.length;
    if (item.url) {
      total += 10;
      if (canonicalizeStatusUrl(item.url, item.id) === item.url) {
        total += 20;
      }
    }
    if (item.media && item.media.length > 0) {
      total += item.media.length * 15;
    }
    if (item.text.includes("Post your reply") || item.text.includes("Relevant View activity")) {
      total -= 80;
    }
    return total;
  };
  const currentScore = score(current);
  const nextScore = score(next);
  return nextScore > currentScore ? next : current;
}

function mergeTimelineItems(items: TimelineItem[]): TimelineItem[] {
  const order: string[] = [];
  const merged = new Map<string, TimelineItem>();
  for (const item of items) {
    const key = getTimelineDedupeKey(item);
    if (!merged.has(key)) {
      order.push(key);
    }
    merged.set(key, pickPreferredTimelineItem(merged.get(key), item));
  }
  return order.map((key) => merged.get(key)).filter((item): item is TimelineItem => Boolean(item));
}

function extractHandleFromStatusUrl(url?: string): string {
  if (!url) {
    return "";
  }
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments[0] === "i" && segments[1] === "web") {
      return "";
    }
    const handle = segments[0] ?? "";
    return handle.replace(/^@+/, "").trim().toLowerCase();
  } catch {
    return "";
  }
}

function buildConversationPayload(
  items: TimelineItem[],
  focalStatusId: string,
  replyLimit: number,
  source: "network" | "dom",
  nextCursor?: string,
  debugReason?: string,
): JsonValue {
  const focalIndex = items.findIndex((item) => getTimelineStatusId(item) === focalStatusId);
  if (focalIndex < 0) {
    return errorResult("UPSTREAM_CHANGED", "focal tweet not found in conversation");
  }
  const focal = items[focalIndex];
  if (!focal) {
    return errorResult("UPSTREAM_CHANGED", "focal tweet not found in conversation");
  }
  const ancestors = items.slice(0, focalIndex);
  const allReplies = items.slice(focalIndex + 1);
  const replies = allReplies.slice(0, replyLimit);
  const output: {
    focal: TimelineItem;
    ancestors: TimelineItem[];
    replies: TimelineItem[];
    source: "network" | "dom";
    hasMore: boolean;
    nextCursor?: string;
    debug?: { reason: string };
  } = {
    focal,
    ancestors,
    replies,
    source,
    hasMore: allReplies.length > replyLimit,
  };
  if (nextCursor) {
    output.nextCursor = nextCursor;
    output.hasMore = true;
  }
  if (source === "dom" && debugReason) {
    output.debug = { reason: debugReason };
  }
  return output;
}

function toTimelinePageFromNetwork(input: {
  items: TweetCard[];
  source: "network" | "dom";
  nextCursor?: string;
  reason?: string;
}): TimelinePage {
  const result: TimelinePage = {
    items: mapTweetCards(input.items),
    source: input.source,
    hasMore: false,
  };
  if (input.nextCursor) {
    result.nextCursor = input.nextCursor;
    result.hasMore = true;
  }
  if (input.source === "dom" && input.reason) {
    result.debug = { reason: input.reason };
  }
  return result;
}

async function readTimelineWithMode(
  page: Page,
  mode: Exclude<TimelineMode, "tweet">,
  limit: number,
  cursor?: string,
): Promise<TimelinePage> {
  await waitForTweetSurface(page);
  await warmupNetworkTemplate(page, mode);
  const networkRequest: { mode: Exclude<TimelineMode, "tweet">; limit: number; cursor?: string } = {
    mode,
    limit,
  };
  if (cursor) {
    networkRequest.cursor = cursor;
  }
  const fromNetwork = await readTimelineViaNetwork(page, networkRequest);
  if (fromNetwork.items.length > 0) {
    return toTimelinePageFromNetwork(fromNetwork);
  }
  const cards = await extractTweetCards(page, limit);
  return {
    items: mapTweetCards(cards),
    source: "dom",
    hasMore: false,
    debug: {
      reason: fromNetwork.reason ?? "dom_fallback",
    },
  };
}

function normalizeUsername(input: unknown): string {
  if (typeof input !== "string") {
    return "";
  }
  return input.replace(/^@+/, "").trim();
}

function normalizeSearchMode(input: unknown): "top" | "latest" {
  return input === "top" ? "top" : "latest";
}

function buildSearchUrl(query: string, mode: "top" | "latest"): string {
  const url = new URL("https://x.com/search");
  url.searchParams.set("q", query);
  url.searchParams.set("src", "typed_query");
  url.searchParams.set("f", mode === "top" ? "top" : "live");
  return url.toString();
}

async function readTweetByUrl(page: Page, url: string): Promise<JsonValue> {
  return await withEphemeralReadOnlyPage(page, url, async (readPage) => {
    const matchId = url.match(/status\/(\d+)/)?.[1];
    if (matchId) {
      const fromNetwork = await readTimelineViaNetwork(readPage, {
        mode: "tweet",
        limit: Math.max(DEFAULT_TIMELINE_LIMIT, 20),
        tweetId: matchId,
      });
      const matched = fromNetwork.items.find((item) => item.id === matchId) ?? fromNetwork.items[0];
      if (matched) {
        return { tweet: matched };
      }
    }
    const cards = await extractTweetCardsAcrossScroll(readPage, 20);
    const tweet = (matchId ? cards.find((item) => item.id === matchId) : undefined) ?? cards[0];
    if (!tweet) {
      return errorResult("UPSTREAM_CHANGED", "tweet content not found");
    }
    return { tweet };
  });
}

async function downloadTweetMediaByUrl(page: Page, url: string, mediaIndex?: number): Promise<JsonValue> {
  const tweetResult = await readTweetByUrl(page, url);
  if (!tweetResult || typeof tweetResult !== "object" || !("tweet" in tweetResult)) {
    return tweetResult;
  }
  const tweet = (tweetResult as { tweet: TimelineItem }).tweet;
  const media = Array.isArray(tweet.media) ? tweet.media : [];
  if (media.length === 0) {
    return errorResult("NO_MEDIA", "tweet has no downloadable media");
  }
  if (mediaIndex !== undefined && (!Number.isInteger(mediaIndex) || mediaIndex < 0)) {
    return errorResult("VALIDATION_ERROR", "mediaIndex must be a non-negative integer");
  }
  if (mediaIndex !== undefined && mediaIndex >= media.length) {
    return errorResult("VALIDATION_ERROR", "mediaIndex is out of range");
  }

  const selectedEntries = mediaIndex === undefined
    ? media.map((entry, index) => ({ mediaIndex: index, media: entry }))
    : [{ mediaIndex, media: media[mediaIndex] as TweetMedia }];
  try {
    const artifacts = await materializeTweetMediaArtifacts(tweet, selectedEntries);
    return {
      tweet,
      items: selectedEntries.map((entry, index) => ({
        mediaIndex: entry.mediaIndex,
        media: entry.media,
        artifact: artifacts[index] as TweetMediaArtifact,
      })),
    };
  } catch (error) {
    return mapTweetMediaDownloadError(error);
  }
}

async function readTweetConversationByUrl(page: Page, url: string, limit: number, cursor?: string): Promise<JsonValue> {
  return await withEphemeralReadOnlyPage(page, url, async (readPage) => {
    const matchId = url.match(/status\/(\d+)/)?.[1];
    if (!matchId) {
      return errorResult("VALIDATION_ERROR", "tweet id could not be derived from url");
    }

    const merged: TimelineItem[] = [];
    let source: "network" | "dom" = "dom";

    const request: { mode: "tweet"; limit: number; cursor?: string; tweetId: string } = {
      mode: "tweet",
      limit,
      tweetId: matchId,
    };
    if (cursor) {
      request.cursor = cursor;
    }
    const fromNetwork = await readTimelineViaNetwork(readPage, request);
    if (fromNetwork.items.length > 0) {
      merged.push(...mapTweetCards(fromNetwork.items));
      source = "network";
    }

    if (!cursor) {
      const domCards = await extractTweetCardsAcrossScroll(readPage, Math.max(limit + 1, 20));
      merged.push(...mapTweetCards(domCards));
    }

    const conversationItems = mergeTimelineItems(merged);
    if (conversationItems.length === 0) {
      return errorResult("UPSTREAM_CHANGED", "tweet conversation content not found");
    }
    return buildConversationPayload(
      conversationItems,
      matchId,
      limit,
      source,
      fromNetwork.nextCursor,
      fromNetwork.reason ?? (source === "dom" ? "dom_fallback" : undefined),
    );
  });
}

async function readTweetRepliesByUrl(page: Page, url: string, limit: number, cursor?: string): Promise<JsonValue> {
  const conversation = await readTweetConversationByUrl(page, url, limit, cursor);
  if (!conversation || typeof conversation !== "object" || !("focal" in conversation) || !("replies" in conversation)) {
    return conversation;
  }
  const typed = conversation as {
    focal: TimelineItem;
    replies: TimelineItem[];
    source: "network" | "dom";
    hasMore: boolean;
    nextCursor?: string;
    debug?: { reason: string };
  };
  const output: {
    focal: TimelineItem;
    items: TimelineItem[];
    source: "network" | "dom";
    hasMore: boolean;
    nextCursor?: string;
    debug?: { reason: string };
  } = {
    focal: typed.focal,
    items: typed.replies.slice(0, limit),
    source: typed.source,
    hasMore: typed.hasMore,
  };
  if (typed.nextCursor) {
    output.nextCursor = typed.nextCursor;
  }
  if (typed.debug) {
    output.debug = typed.debug;
  }
  return output;
}

async function readTweetThreadByUrl(page: Page, url: string, limit: number): Promise<JsonValue> {
  const conversation = await readTweetConversationByUrl(page, url, Math.max(limit, 20));
  if (!conversation || typeof conversation !== "object" || !("focal" in conversation)) {
    return conversation;
  }
  const typed = conversation as {
    focal: TimelineItem;
    ancestors: TimelineItem[];
    replies: TimelineItem[];
    source: "network" | "dom";
    hasMore: boolean;
    nextCursor?: string;
    debug?: { reason: string };
  };
  const focalHandle = extractHandleFromStatusUrl(typed.focal.url);
  const threadItems = mergeTimelineItems(
    [...typed.ancestors, typed.focal, ...typed.replies].filter((item) => {
      if (!focalHandle) {
        return true;
      }
      return extractHandleFromStatusUrl(item.url) === focalHandle;
    }),
  ).slice(0, limit);
  if (threadItems.length === 0) {
      return errorResult("UPSTREAM_CHANGED", "tweet conversation content not found");
    }
  const root = threadItems[0];
  if (!root) {
    return errorResult("UPSTREAM_CHANGED", "tweet thread content not found");
  }
  const output: {
    root: TimelineItem;
    focal: TimelineItem;
    tweets: TimelineItem[];
    source: "network" | "dom";
    incomplete?: boolean;
    nextCursor?: string;
    debug?: { reason: string };
  } = {
    root,
    focal: typed.focal,
    tweets: threadItems,
    source: typed.source,
  };
  if (typed.hasMore) {
    output.incomplete = true;
  }
  if (typed.nextCursor) {
    output.nextCursor = typed.nextCursor;
  }
  if (typed.debug) {
    output.debug = typed.debug;
  }
  return output;
}

async function readNotifications(page: Page, limit: number): Promise<TimelinePage> {
  await waitForTweetSurface(page);
  const cards = await extractNotificationCards(page, limit);
  return {
    items: cards.map(enrichNotificationItem),
    source: "dom",
    hasMore: false,
    debug: {
      reason: "notifications_dom",
    },
  };
}

async function readProfile(page: Page, handle: string): Promise<JsonValue> {
  const normalizedHandle = handle.replace(/^@+/, "").trim();
  const profileUrl = `https://x.com/${normalizedHandle}`;
  return await withEphemeralReadOnlyPage(page, profileUrl, async (readPage) => {
    const profile = await readPage.evaluate(() => {
      const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
      const name = document.querySelector<HTMLElement>("[data-testid='UserName'] span")?.textContent ?? "";
      const bio = document.querySelector<HTMLElement>("[data-testid='UserDescription']")?.textContent ?? "";
      const location = document.querySelector<HTMLElement>("[data-testid='UserLocation']")?.textContent ?? "";
      const website = document.querySelector<HTMLAnchorElement>("[data-testid='UserUrl'] a")?.href ?? "";
      const followingText = document.querySelector<HTMLAnchorElement>("a[href$='/following'] span")?.textContent ?? "";
      const followersText = document.querySelector<HTMLAnchorElement>("a[href$='/verified_followers'], a[href$='/followers'] span")
        ?.textContent ?? "";
      const output: {
        name: string;
        bio: string;
        location: string;
        website?: string;
        following: string;
        followers: string;
      } = {
        name: normalize(name),
        bio: normalize(bio),
        location: normalize(location),
        following: normalize(followingText),
        followers: normalize(followersText),
      };
      if (website) {
        output.website = website;
      }
      return output;
    });
    return {
      handle: `@${normalizedHandle}`,
      url: profileUrl,
      profile,
    };
  });
}

async function composePost(page: Page, text: string, dryRun: boolean): Promise<ComposeDomResult> {
  return await page.evaluate(
    ({ content, dryRunMode }) => {
      const pickFirst = (selectors: string[]): HTMLElement | null => {
        for (const selector of selectors) {
          const element = document.querySelector<HTMLElement>(selector);
          if (element) {
            return element;
          }
        }
        return null;
      };

      const clickFirst = (selectors: string[]): void => {
        const element = pickFirst(selectors);
        element?.click();
      };

      const setText = (target: HTMLElement, value: string): boolean => {
        target.focus();

        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
          target.value = value;
          target.dispatchEvent(new Event("input", { bubbles: true }));
          target.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }

        if (target.isContentEditable) {
          try {
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(target);
            selection?.removeAllRanges();
            selection?.addRange(range);
            document.execCommand("insertText", false, value);
          } catch {
            // Ignore and fallback to direct assignment below.
          }

          if ((target.textContent ?? "").trim() !== value) {
            target.textContent = value;
          }
          target.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
          return true;
        }

        return false;
      };

      const composerSelectors = [
        "div[data-testid='tweetTextarea_0']",
        "div[role='textbox'][data-testid='tweetTextarea_0']",
        "div[role='textbox'][aria-label*='Post text']",
        "div[role='textbox'][aria-label*='What is happening']",
      ];
      const openComposerSelectors = [
        "[data-testid='SideNav_NewTweet_Button']",
        "[data-testid='tweetButton']",
        "a[href='/compose/post']",
        "a[href='/compose/tweet']",
      ];
      const submitSelectors = [
        "[data-testid='tweetButtonInline']",
        "[data-testid='tweetButton']",
        "div[data-testid='toolBar'] [data-testid='tweetButtonInline']",
      ];

      let composer = pickFirst(composerSelectors);
      if (!composer) {
        clickFirst(openComposerSelectors);
        composer = pickFirst(composerSelectors);
      }
      if (!composer) {
        return { ok: false, reason: "composer_not_found" };
      }

      const inputOk = setText(composer, content);
      if (!inputOk) {
        return { ok: false, reason: "compose_input_failed" };
      }

      const submit = pickFirst(submitSelectors);
      if (dryRunMode) {
        return {
          ok: true,
          dryRun: true,
          submitVisible: submit !== null,
        };
      }

      if (!submit) {
        return { ok: false, reason: "submit_not_found" };
      }

      submit.click();
      return { ok: true };
    },
    { content: text, dryRunMode: dryRun },
  );
}

async function ensureComposerReady(page: Page): Promise<void> {
  const composerSelectors = [
    "div[data-testid='tweetTextarea_0']",
    "div[role='textbox'][data-testid='tweetTextarea_0']",
    "div[role='textbox'][aria-label*='Post text']",
    "div[role='textbox'][aria-label*='What is happening']",
  ];
  const openComposerSelectors = [
    "[data-testid='SideNav_NewTweet_Button']",
    "[data-testid='tweetButton']",
    "a[href='/compose/post']",
    "a[href='/compose/tweet']",
  ];

  for (const selector of composerSelectors) {
    const handle = await page.waitForSelector(selector, { timeout: 800 }).catch(() => null);
    if (handle) {
      await handle.dispose();
      return;
    }
  }

  await page
    .evaluate((selectors) => {
      for (const selector of selectors) {
        const element = document.querySelector<HTMLElement>(selector);
        if (element) {
          element.click();
          return;
        }
      }
    }, openComposerSelectors)
    .catch(() => {});

  for (const selector of composerSelectors) {
    const handle = await page.waitForSelector(selector, { timeout: 2000 }).catch(() => null);
    if (handle) {
      await handle.dispose();
      return;
    }
  }
}

async function waitForComposeConfirmation(
  page: Page,
  text: string,
  timeoutMs: number,
): Promise<{ confirmed: boolean; statusUrl?: string }> {
  const snippet = text.slice(0, 24).trim();
  if (!snippet) {
    return { confirmed: false };
  }

  try {
    await page.waitForFunction(
      (needle: string) => {
        const normalize = (value: string): string => value.replace(/\s+/g, " ").trim().toLowerCase();
        const normalizedNeedle = normalize(needle);
        const nodes = Array.from(document.querySelectorAll<HTMLElement>("article [data-testid='tweetText'], article div[lang]"));
        return nodes.some((node) => normalize(node.innerText || node.textContent || "").includes(normalizedNeedle));
      },
      snippet,
      { timeout: timeoutMs },
    );
  } catch {
    return { confirmed: false };
  }

  const statusUrl = await page.evaluate(({ needle }: { needle: string }) => {
    const normalize = (value: string): string => value.replace(/\s+/g, " ").trim().toLowerCase();
    const normalizedNeedle = normalize(needle);
    const tweets = Array.from(document.querySelectorAll("article"));

    for (const tweet of tweets) {
      const textNodes = Array.from(tweet.querySelectorAll<HTMLElement>("[data-testid='tweetText'], div[lang]"));
      const matched = textNodes.some((node) =>
        normalize(node.innerText || node.textContent || "").includes(normalizedNeedle),
      );
      if (!matched) {
        continue;
      }
      const statusLink = tweet.querySelector<HTMLAnchorElement>("a[href*='/status/']");
      if (statusLink?.href) {
        return statusLink.href;
      }
    }
    return undefined;
  }, { needle: snippet });

  if (typeof statusUrl === "string" && statusUrl.length > 0) {
    return {
      confirmed: true,
      statusUrl,
    };
  }
  return { confirmed: true };
}

async function ensureReplyComposerReady(page: Page): Promise<void> {
  const composerSelectors = [
    "div[data-testid='tweetTextarea_0']",
    "div[role='textbox'][data-testid='tweetTextarea_0']",
    "div[role='textbox'][aria-label*='Post text']",
    "div[role='textbox'][aria-label*='Reply']",
    "div[role='textbox'][aria-label*='Post your reply']",
  ];
  const openReplySelectors = [
    "[data-testid='reply']",
    "[data-testid='replyButton']",
    "button[aria-label*='Reply']",
    "div[role='button'][aria-label*='Reply']",
  ];

  for (const selector of composerSelectors) {
    const handle = await page.waitForSelector(selector, { timeout: 800 }).catch(() => null);
    if (handle) {
      await handle.dispose();
      return;
    }
  }

  await page
    .evaluate((selectors) => {
      for (const selector of selectors) {
        const element = document.querySelector<HTMLElement>(selector);
        if (element) {
          element.click();
          return;
        }
      }
    }, openReplySelectors)
    .catch(() => {});

  for (const selector of composerSelectors) {
    const handle = await page.waitForSelector(selector, { timeout: 2500 }).catch(() => null);
    if (handle) {
      await handle.dispose();
      return;
    }
  }
}

async function composeReply(page: Page, text: string, dryRun: boolean): Promise<ReplyComposeDomResult> {
  const composerSelectors = [
    "div[data-testid='tweetTextarea_0']",
    "div[role='textbox'][data-testid='tweetTextarea_0']",
    "div[role='textbox'][aria-label*='Reply']",
    "div[role='textbox'][aria-label*='Post your reply']",
    "div[role='textbox'][aria-label*='Post text']",
  ];
  const selectAllShortcut = process.platform === "darwin" ? "Meta+A" : "Control+A";

  let composerSelector: string | undefined;
  for (const selector of composerSelectors) {
    const handle = await page.waitForSelector(selector, { timeout: 800 }).catch(() => null);
    if (!handle) {
      continue;
    }
    await handle.dispose().catch(() => {});
    composerSelector = selector;
    break;
  }

  if (!composerSelector) {
    return { ok: false, reason: "composer_not_found" };
  }

  try {
    await page.click(composerSelector);
    await page.keyboard.press(selectAllShortcut).catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    await page.type(composerSelector, text, { delay: 12 });
  } catch {
    return { ok: false, reason: "compose_input_failed" };
  }

  const submitVisible = await waitForReplySubmitReady(page, 2_000);
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      submitVisible,
    };
  }

  if (!submitVisible) {
    return { ok: false, reason: "submit_not_found" };
  }

  return {
    ok: true,
    submitVisible: true,
  };
}

async function waitForReplySubmitReady(page: Page, timeoutMs: number): Promise<boolean> {
  try {
    await page.waitForFunction(
      ({ op }) => {
        if (op !== "reply_submit_ready") {
          return false;
        }

        const selectors = [
          "[data-testid='tweetButtonInline']",
          "[data-testid='tweetButton']",
          "div[data-testid='toolBar'] [data-testid='tweetButtonInline']",
        ];

        const isEnabled = (element: HTMLElement | null): boolean => {
          if (!element) {
            return false;
          }
          if (element instanceof HTMLButtonElement) {
            return !element.disabled;
          }
          const ariaDisabled = (element.getAttribute("aria-disabled") ?? "").toLowerCase();
          return ariaDisabled !== "true";
        };

        const composerSelectors = [
          "div[data-testid='tweetTextarea_0']",
          "div[role='textbox'][data-testid='tweetTextarea_0']",
          "div[role='textbox'][aria-label*='Reply']",
          "div[role='textbox'][aria-label*='Post your reply']",
          "div[role='textbox'][aria-label*='Post text']",
        ];

        const findNearestSubmit = (composer: HTMLElement | null): HTMLElement | null => {
          if (!composer) {
            return null;
          }
          const roots = [
            composer.closest<HTMLElement>("[role='dialog']"),
            composer.closest<HTMLElement>("form"),
            composer.closest<HTMLElement>("article"),
            composer.parentElement,
            composer.parentElement?.parentElement,
            document.body,
          ];

          for (const root of roots) {
            if (!root) {
              continue;
            }
            for (const selector of selectors) {
              const element = root.querySelector<HTMLElement>(selector);
              if (isEnabled(element)) {
                return element;
              }
            }
          }
          return null;
        };

        let composer: HTMLElement | null = null;
        for (const selector of composerSelectors) {
          composer = document.querySelector<HTMLElement>(selector);
          if (composer) {
            break;
          }
        }

        if (findNearestSubmit(composer)) {
          return true;
        }

        for (const selector of selectors) {
          const element = document.querySelector<HTMLElement>(selector);
          if (isEnabled(element)) {
            return true;
          }
        }
        return false;
      },
      { op: "reply_submit_ready" },
      { timeout: Math.max(1_500, Math.min(timeoutMs, 6_000)) },
    );
    return true;
  } catch {
    return false;
  }
}

async function submitReply(page: Page): Promise<SubmitDomResult> {
  return await page.evaluate(({ op }) => {
    if (op !== "reply_submit") {
      return { ok: false, reason: "invalid_operation" };
    }

    const composerSelectors = [
      "div[data-testid='tweetTextarea_0']",
      "div[role='textbox'][data-testid='tweetTextarea_0']",
      "div[role='textbox'][aria-label*='Reply']",
      "div[role='textbox'][aria-label*='Post your reply']",
      "div[role='textbox'][aria-label*='Post text']",
    ];
    const selectors = [
      "[data-testid='tweetButtonInline']",
      "[data-testid='tweetButton']",
      "div[data-testid='toolBar'] [data-testid='tweetButtonInline']",
    ];

    const isEnabled = (element: HTMLElement | null): boolean => {
      if (!element) {
        return false;
      }
      if (element instanceof HTMLButtonElement) {
        return !element.disabled;
      }
      const ariaDisabled = (element.getAttribute("aria-disabled") ?? "").toLowerCase();
      return ariaDisabled !== "true";
    };

    const findNearestSubmit = (composer: HTMLElement | null): HTMLElement | null => {
      if (!composer) {
        return null;
      }
      const roots = [
        composer.closest<HTMLElement>("[role='dialog']"),
        composer.closest<HTMLElement>("form"),
        composer.closest<HTMLElement>("article"),
        composer.parentElement,
        composer.parentElement?.parentElement,
        document.body,
      ];

      for (const root of roots) {
        if (!root) {
          continue;
        }
        for (const selector of selectors) {
          const element = root.querySelector<HTMLElement>(selector);
          if (isEnabled(element)) {
            return element;
          }
        }
      }
      return null;
    };

    let composer: HTMLElement | null = null;
    for (const selector of composerSelectors) {
      composer = document.querySelector<HTMLElement>(selector);
      if (composer) {
        break;
      }
    }

    const nearestSubmit = findNearestSubmit(composer);
    if (nearestSubmit) {
      nearestSubmit.click();
      return { ok: true };
    }

    for (const selector of selectors) {
      const element = document.querySelector<HTMLElement>(selector);
      if (!isEnabled(element)) {
        continue;
      }
      element?.click();
      return { ok: true };
    }

    return { ok: false, reason: "submit_not_found" };
  }, { op: "reply_submit" });
}

async function waitForReplyConfirmation(
  page: Page,
  targetUrl: string,
  text: string,
  timeoutMs: number,
): Promise<{ confirmed: boolean; statusUrl?: string }> {
  const firstPassTimeoutMs = Math.max(2_500, Math.min(timeoutMs, 5_000));
  const firstPass = await waitForComposeConfirmation(page, text, firstPassTimeoutMs);
  if (firstPass.confirmed) {
    return firstPass;
  }

  await page.waitForTimeout(1_000);
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  await waitForTweetSurface(page);

  const secondPassTimeoutMs = Math.max(2_500, timeoutMs - firstPassTimeoutMs);
  return await waitForComposeConfirmation(page, text, secondPassTimeoutMs);
}

async function waitForArticleEditorSurface(page: Page): Promise<void> {
  await page
    .waitForFunction(() => {
      const title = document.querySelector("textarea[placeholder='Add a title']");
      const composer = document.querySelector("[data-testid='composer'][role='textbox']");
      const publishButton = Array.from(document.querySelectorAll("button")).find(
        (button) => (button.textContent || "").replace(/\s+/g, " ").trim() === "Publish",
      );
      return title !== null && composer !== null && publishButton !== undefined;
    }, undefined, { timeout: 20_000 })
    .catch(() => {});
  await page.waitForTimeout(800);
}

async function ensureArticleDraftLoaded(page: Page, articleId?: string): Promise<void> {
  if (!articleId) {
    return;
  }
  const hasContent = async (): Promise<boolean> => {
    return await page.evaluate(() => {
      const title = document.querySelector("textarea[placeholder='Add a title']");
      const composer = document.querySelector("[data-testid='composer'][role='textbox']");
      const titleValue = title instanceof HTMLTextAreaElement ? title.value.trim() : "";
      const composerText = composer instanceof HTMLElement ? (composer.textContent || "").trim() : "";
      return titleValue.length > 0 || composerText.length > 0;
    }).catch(() => false);
  };
  if (await hasContent()) {
    return;
  }
  await page.goto("https://x.com/compose/articles", { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(1_200);
  await page.evaluate(({ targetId }) => {
    const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"));
    const draftAnchor = anchors.find((anchor) => anchor.href.includes(`/compose/articles/edit/${targetId}`));
    draftAnchor?.click();
  }, { targetId: articleId }).catch(() => {});
  await page.waitForTimeout(1_200);
  if (await hasContent()) {
    return;
  }
  await page.goto(`https://x.com/compose/articles/edit/${articleId}`, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  await waitForArticleEditorSurface(page);
  await page.waitForTimeout(1_000);
}

async function waitForArticleDraftPersisted(page: Page, articleId: string, title: string): Promise<boolean> {
  await page
    .evaluate(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) {
        active.blur();
      }
    })
    .catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  return await page
    .waitForFunction(
      ({ targetId, expectedTitle }) => {
        const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"));
        const draftAnchor = anchors.find((anchor) => anchor.href.includes(`/compose/articles/edit/${targetId}`));
        const containerText = draftAnchor?.closest("article, li, div")?.textContent || draftAnchor?.textContent || "";
        const normalized = containerText.replace(/\s+/g, " ").trim();
        return normalized.includes(expectedTitle) && !normalized.includes("(Needs title)");
      },
      { targetId: articleId, expectedTitle: title.trim() },
      { timeout: 20_000 },
    )
    .then(() => true)
    .catch(() => false);
}

async function openNewArticleEditor(page: Page): Promise<{ ok: true; editUrl: string } | { ok: false; reason: string }> {
  await page.goto("https://x.com/compose/articles", { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(2_500);

  let clicked = false;
  const createSelectors = [
    "a[data-testid='empty_state_button_text']",
    "button[aria-label='create']",
    "a:has-text('Write')",
  ];
  for (const selector of createSelectors) {
    try {
      await page.click(selector, { timeout: 4_000 });
      clicked = true;
      break;
    } catch {
      // Try the next known article entry point.
    }
  }

  if (!clicked) {
    const openedExistingDraft = await page
      .evaluate(() => {
        const draftAnchor = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).find((anchor) => {
          return anchor.href.includes("/compose/articles/edit/");
        });
        if (!draftAnchor) {
          return false;
        }
        draftAnchor.click();
        return true;
      })
      .catch(() => false);
    if (openedExistingDraft) {
      try {
        await page.waitForFunction(
          () => window.location.pathname.includes("/compose/articles/edit/"),
          undefined,
          { timeout: 20_000 },
        );
        await waitForArticleEditorSurface(page);
        return { ok: true, editUrl: page.url() };
      } catch {
        // Fall through to existing edit-url fallback below.
      }
    }
    if (page.url().includes("/compose/articles/edit/")) {
      await waitForArticleEditorSurface(page);
      return { ok: true, editUrl: page.url() };
    }
    return { ok: false, reason: "create_button_not_found" };
  }

  try {
    await page.waitForFunction(
      ({ op }) => op === "article_wait_editor" && window.location.pathname.includes("/compose/articles/edit/"),
      { op: "article_wait_editor" },
      {
      timeout: 20_000,
      },
    );
  } catch {
    return { ok: false, reason: "edit_url_not_reached" };
  }

  await waitForArticleEditorSurface(page);
  const editUrl = page.url();
  return { ok: true, editUrl };
}

async function setArticleTitle(page: Page, title: string): Promise<boolean> {
  const trimmed = title.trim();
  if (!trimmed) {
    return false;
  }
  let interacted = false;
  if (typeof (page as { locator?: unknown }).locator === "function") {
    const titleLocator = page.locator("textarea[placeholder='Add a title']").first();
    interacted = await titleLocator.click().then(() => true).catch(() => false);
    if (interacted) {
      await page.keyboard.press("Meta+A").catch(() => {});
      await page.keyboard.press("Backspace").catch(() => {});
      const keyboard = page.keyboard as { insertText?: (value: string) => Promise<void>; type?: (value: string) => Promise<void> };
      if (typeof keyboard.insertText === "function") {
        interacted = await keyboard.insertText(trimmed).then(() => true).catch(() => false);
      } else if (typeof keyboard.type === "function") {
        interacted = await keyboard.type(trimmed).then(() => true).catch(() => false);
      } else {
        interacted = await titleLocator.fill(trimmed).then(() => true).catch(() => false);
      }
      await titleLocator.blur().catch(() => {});
    }
  }
  const injected = interacted
    ? true
    : await page.evaluate(({ op, value }) => {
      if (op !== "article_set_title") {
        return false;
      }
      const input = document.querySelector("textarea[placeholder='Add a title']");
      if (!(input instanceof HTMLTextAreaElement)) {
        return false;
      }
      input.focus();
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, { op: "article_set_title", value: trimmed }).catch(() => false);
  if (!injected) {
    return false;
  }
  return await page
    .waitForFunction(
      ({ expectedTitle }) => {
        const input = document.querySelector("textarea[placeholder='Add a title']");
        return input instanceof HTMLTextAreaElement && input.value.trim() === expectedTitle;
      },
      { expectedTitle: trimmed },
      { timeout: 3_000 },
    )
    .then(() => true)
    .catch(() => false);
}

async function pasteArticleMarkdown(page: Page, markdown: string): Promise<boolean> {
  let success = false;
  if (typeof (page as { locator?: unknown }).locator === "function") {
    const composerLocator = page.locator("[data-testid='composer'][role='textbox']").first();
    success = await composerLocator.click().then(() => true).catch(() => false);
    if (success) {
      const wroteClipboard = await page.evaluate(async ({ value }) => {
        try {
          await navigator.clipboard.writeText(value);
          return true;
        } catch {
          return false;
        }
      }, { value: markdown }).catch(() => false);
      if (wroteClipboard) {
        success = await page.keyboard.press("Meta+V").then(() => true).catch(() => false);
      }
      if (!success) {
        const keyboard = page.keyboard as { insertText?: (value: string) => Promise<void>; type?: (value: string) => Promise<void> };
        if (typeof keyboard.insertText === "function") {
          success = await keyboard.insertText(markdown).then(() => true).catch(() => false);
        } else if (typeof keyboard.type === "function") {
          success = await keyboard.type(markdown).then(() => true).catch(() => false);
        }
      }
    }
  }
  if (!success) {
    success = await page.evaluate(({ op, markdownText }) => {
      if (op !== "article_paste_markdown") {
        return false;
      }
      const composer = document.querySelector("[data-testid='composer'][role='textbox']");
      if (!(composer instanceof HTMLElement)) {
        return false;
      }
      composer.focus();
      const data = new DataTransfer();
      data.setData("text/plain", markdownText);
      data.setData("text/markdown", markdownText);
      const event = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      });
      composer.dispatchEvent(event);
      return true;
    }, { op: "article_paste_markdown", markdownText: markdown }).catch(() => false);
  }
  if (!success) {
    return false;
  }
  const requiredSnippets = markdown
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 3);
  if (requiredSnippets.length === 0) {
    return true;
  }
  try {
    await page.waitForFunction(
      ({ snippets }) => {
        const bodyText = document.body?.innerText ?? "";
        return snippets.every((snippet) => bodyText.includes(snippet));
      },
      { snippets: requiredSnippets },
      { timeout: 10_000 },
    );
    return true;
  } catch {
    return false;
  }
}

async function triggerArticleCoverUpload(page: Page): Promise<boolean> {
  return (
    (await page.evaluate(({ op }) => {
      if (op !== "article_trigger_cover_upload") {
        return false;
      }
      const hint = Array.from(document.querySelectorAll<HTMLElement>("button, div[role='button'], label, div")).find((element) => {
        const text = (element.textContent || "").replace(/\s+/g, " ").trim();
        return text.includes("5:2 aspect ratio");
      });
      if (hint) {
        hint.click();
        return true;
      }
      const button = Array.from(document.querySelectorAll<HTMLElement>("button")).find((element) => {
        const aria = (element.getAttribute("aria-label") || "").toLowerCase();
        const text = (element.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        return aria.includes("cover") || text.includes("cover");
      });
      if (button) {
        button.click();
        return true;
      }
      return document.querySelector("input[data-testid='fileInput']") !== null;
    }, { op: "article_trigger_cover_upload" }).catch(() => false)) === true
  );
}

async function triggerArticleInlineImageUpload(page: Page): Promise<boolean> {
  return (
    (await page.evaluate(({ op }) => {
      if (op !== "article_trigger_inline_upload") {
        return false;
      }
      const candidates = [
        "button[aria-label='Add Media']",
        "button[aria-label='Add photos or video']",
      ];
      for (const selector of candidates) {
        const button = document.querySelector<HTMLElement>(selector);
        if (!button) {
          continue;
        }
        button.click();
        return true;
      }
      return document.querySelector("input[data-testid='fileInput']") !== null;
    }, { op: "article_trigger_inline_upload" }).catch(() => false)) === true
  );
}

async function uploadArticleFile(page: Page, filePath: string): Promise<boolean> {
  try {
    await page.setInputFiles("input[data-testid='fileInput']", filePath);
    const applyReady = await page
      .waitForFunction(() => {
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
        const apply = buttons.find((button) => (button.textContent || "").replace(/\s+/g, " ").trim() === "Apply");
        if (!apply) {
          return false;
        }
        const ariaDisabled = (apply.getAttribute("aria-disabled") || "").toLowerCase();
        return !apply.disabled && ariaDisabled !== "true";
      }, undefined, { timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    if (applyReady) {
      if (typeof (page as { locator?: unknown }).locator === "function") {
        const applyLocator = page.locator("button:has-text('Apply')").last();
        await applyLocator.click({ timeout: 2_000, force: true }).catch(() => {});
      } else {
        await page.click("button:has-text('Apply')", { timeout: 2_000 }).catch(() => {});
      }
      await page
        .evaluate(() => {
          const buttons = Array.from(document.querySelectorAll<HTMLElement>("button, div[role='button']")).filter((element) => {
            const text = (element.textContent || "").replace(/\s+/g, " ").trim();
            return text === "Apply";
          });
          const button = buttons[buttons.length - 1];
          button?.click();
        })
        .catch(() => {});
      await page
        .waitForFunction(() => {
          const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
          return !buttons.some((button) => (button.textContent || "").replace(/\s+/g, " ").trim() === "Apply");
        }, undefined, { timeout: 8_000 })
        .catch(() => {});
    } else {
      await page.waitForTimeout(1_500);
    }
    return true;
  } catch {
    return false;
  }
}

async function placeArticleCursorAtMarker(page: Page, marker: string): Promise<boolean> {
  return (
    (await page.evaluate(({ op, markerText }) => {
      if (op !== "article_place_marker") {
        return false;
      }
      const composer = document.querySelector("[data-testid='composer'][role='textbox']");
      if (!(composer instanceof HTMLElement)) {
        return false;
      }
      const walker = document.createTreeWalker(composer, NodeFilter.SHOW_TEXT);
      let current: Node | null = walker.nextNode();
      while (current) {
        const textNode = current as Text;
        const content = textNode.textContent ?? "";
        const index = content.indexOf(markerText);
        if (index >= 0) {
          const selection = window.getSelection();
          if (!selection) {
            return false;
          }
          const range = document.createRange();
          range.setStart(textNode, index);
          range.setEnd(textNode, index + markerText.length);
          selection.removeAllRanges();
          selection.addRange(range);
          return true;
        }
        current = walker.nextNode();
      }
      return false;
    }, { op: "article_place_marker", markerText: marker }).catch(() => false)) === true
  );
}

async function deleteArticleSelectedMarker(page: Page): Promise<void> {
  await page.keyboard.press("Backspace").catch(() => {});
  await page.waitForTimeout(200);
}

async function uploadArticleInlineImages(page: Page, images: ArticleInlineImage[]): Promise<{ ok: true } | { ok: false; reason: string }> {
  for (const image of images) {
    const resolved = await resolveArticleAttachment(image.path, image.marker);
    if (!resolved.ok || !resolved.attachment) {
      return { ok: false, reason: "inline_image_missing" };
    }
    const positioned = await placeArticleCursorAtMarker(page, image.marker);
    if (!positioned) {
      return { ok: false, reason: "inline_marker_not_found" };
    }
    await deleteArticleSelectedMarker(page);
    const triggered = await triggerArticleInlineImageUpload(page);
    if (!triggered) {
      return { ok: false, reason: "inline_upload_trigger_not_found" };
    }
    const uploaded = await uploadArticleFile(page, resolved.attachment.path);
    if (!uploaded) {
      return { ok: false, reason: "inline_upload_failed" };
    }
  }
  return { ok: true };
}

async function clearArticleBody(page: Page): Promise<boolean> {
  let cleared = false;
  if (typeof (page as { locator?: unknown }).locator === "function") {
    const composerLocator = page.locator("[data-testid='composer'][role='textbox']").first();
    cleared = await composerLocator.click().then(() => true).catch(() => false);
    if (cleared) {
      await page.keyboard.press("Meta+A").catch(() => {});
      await page.keyboard.press("Backspace").catch(() => {});
      await page.waitForTimeout(200);
    }
  }
  if (cleared) {
    return true;
  }
  return await page.evaluate(({ op }) => {
    if (op !== "article_clear_body") {
      return false;
    }
    const composer = document.querySelector("[data-testid='composer'][role='textbox']");
    if (!(composer instanceof HTMLElement)) {
      return false;
    }
    composer.focus();
    composer.textContent = "";
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }, { op: "article_clear_body" }).catch(() => false);
}

function parseArticleIdFromUrl(url: string): string | undefined {
  const match = url.match(/\/articles\/edit\/(\d+)(?:[/?#]|$)|\/articles\/(\d+)(?:[/?#]|$)/);
  return match?.[1] ?? match?.[2];
}

async function publishArticleEditor(
  page: Page,
  timeoutMs: number,
): Promise<
  | { ok: true; articleId?: string; articleUrl?: string; editUrl: string }
  | { ok: false; reason: string; details?: Record<string, JsonValue> }
> {
  const editUrl = page.url();
  await page
    .evaluate(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) {
        active.blur();
      }
    })
    .catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  await page
    .waitForFunction(() => {
      const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
      return buttons.some((button) => {
        const label = (button.textContent || "").replace(/\s+/g, " ").trim();
        const ariaDisabled = (button.getAttribute("aria-disabled") || "").toLowerCase();
        return label === "Publish" && !button.disabled && ariaDisabled !== "true";
      });
    }, undefined, { timeout: Math.min(timeoutMs, 15_000) })
    .catch(() => {});
  const clickPrimaryPublish = async (): Promise<boolean> => {
    return (
      (await page.evaluate(({ op }) => {
        if (op !== "article_click_publish") {
          return false;
        }
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter((button) => {
          const label = (button.textContent || "").replace(/\s+/g, " ").trim();
          const ariaDisabled = (button.getAttribute("aria-disabled") || "").toLowerCase();
          return label === "Publish" && !button.disabled && ariaDisabled !== "true";
        });
        const button = buttons[buttons.length - 1];
        if (!button) {
          return false;
        }
        button.click();
        return true;
      }, { op: "article_click_publish" }).catch(() => false)) === true
    );
  };

  if (!(await clickPrimaryPublish())) {
    const details = await page
      .evaluate(() => {
        const titleAreas = Array.from(document.querySelectorAll("textarea")).map((input) => ({
          placeholder: input.getAttribute("placeholder") || "",
          value: input instanceof HTMLTextAreaElement ? input.value : "",
        }));
        const composers = Array.from(document.querySelectorAll("[data-testid='composer'][role='textbox']")).map((node) => ({
          text: (node.textContent || "").slice(0, 500),
        }));
        const buttonLabels = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
          .map((button) => ({
            text: (button.textContent || "").replace(/\s+/g, " ").trim(),
            aria: button.getAttribute("aria-label") || "",
            disabled: button.disabled || (button.getAttribute("aria-disabled") || "").toLowerCase() === "true",
          }))
          .filter((item) => item.text || item.aria)
          .slice(0, 30);
        const bodyLines = (document.body?.innerText || "")
          .split(/\n+/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .slice(0, 40);
        return {
          currentUrl: window.location.href,
          titleAreas,
          composers,
          buttonLabels,
          bodyLines,
        };
      })
      .catch(() => undefined);
    return details
      ? { ok: false, reason: "publish_button_not_found", details }
      : { ok: false, reason: "publish_button_not_found" };
  }
  await page.waitForTimeout(1_000);
  await clickPrimaryPublish().catch(() => false);

  try {
    await page.waitForFunction(
      ({ previousUrl }) => {
        const currentUrl = window.location.href;
        if (!currentUrl.includes("/compose/articles/edit/")) {
          return true;
        }
        if (currentUrl !== previousUrl && !currentUrl.includes("/preview")) {
          return true;
        }
        return (document.body?.innerText || "").includes("Published");
      },
      { previousUrl: editUrl },
      { timeout: timeoutMs },
    );
  } catch {
    return { ok: false, reason: "publish_not_confirmed" };
  }

  const details = await page.evaluate(({ op }) => {
    if (op !== "article_collect_publish_details") {
      return {
        currentUrl: window.location.href,
        editUrl: undefined,
        publicUrl: undefined,
      };
    }
    const editAnchor = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).find((anchor) =>
      anchor.href.includes("/compose/articles/edit/"),
    );
    const publicAnchor = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).find((anchor) => {
      return anchor.href.includes("/articles/") && !anchor.href.includes("/compose/articles/edit/");
    });
    return {
      currentUrl: window.location.href,
      editUrl: editAnchor?.href,
      publicUrl: publicAnchor?.href,
    };
  }, { op: "article_collect_publish_details" }).catch(() => ({ currentUrl: page.url(), editUrl: undefined, publicUrl: undefined }));

  const articleId =
    parseArticleIdFromUrl(details.currentUrl) ??
    (typeof details.editUrl === "string" ? parseArticleIdFromUrl(details.editUrl) : undefined) ??
    undefined;
  const articleUrl =
    typeof details.publicUrl === "string" && details.publicUrl.length > 0
      ? details.publicUrl
      : !details.currentUrl.includes("/compose/articles/edit/")
        ? details.currentUrl
        : undefined;

  const output: { ok: true; articleId?: string; articleUrl?: string; editUrl: string } = {
    ok: true,
    editUrl: typeof details.editUrl === "string" && details.editUrl.length > 0 ? details.editUrl : editUrl,
  };
  if (articleId) {
    output.articleId = articleId;
  }
  if (articleUrl) {
    output.articleUrl = articleUrl;
  }
  return output;
}

async function deleteArticleEditor(page: Page, dryRun: boolean): Promise<JsonValue> {
  const menuOpened = await page.evaluate(({ op }) => {
    if (op !== "article_open_delete_menu") {
      return false;
    }
    const buttons = Array.from(document.querySelectorAll<HTMLElement>("button[aria-label='More']"));
    const button = buttons[buttons.length - 1];
    if (!button) {
      return false;
    }
    button.click();
    return true;
  }, { op: "article_open_delete_menu" }).catch(() => false);
  if (!menuOpened) {
    return errorResult("UPSTREAM_CHANGED", "article delete controls not found", {
      reason: "more_button_not_found",
    });
  }

  const deleteReady = await page.waitForFunction(() => {
    return Array.from(document.querySelectorAll<HTMLElement>("[role='menuitem'], button, div[role='button']")).some((element) => {
      const text = (element.textContent || "").replace(/\s+/g, " ").trim();
      return text === "Delete Article";
    });
  }, undefined, { timeout: 5_000 }).then(() => true).catch(() => false);
  if (!deleteReady) {
    return errorResult("UPSTREAM_CHANGED", "article delete controls not found", {
      reason: "delete_menu_item_not_found",
    });
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      deleteVisible: true,
    };
  }

  const firstDelete = await page.evaluate(({ op }) => {
    if (op !== "article_click_delete_menu_item") {
      return false;
    }
    const item = Array.from(document.querySelectorAll<HTMLElement>("[role='menuitem'], button, div[role='button']")).find((element) => {
      const text = (element.textContent || "").replace(/\s+/g, " ").trim();
      return text === "Delete Article";
    });
    if (!item) {
      return false;
    }
    item.click();
    return true;
  }, { op: "article_click_delete_menu_item" }).catch(() => false);
  if (!firstDelete) {
    return errorResult("UPSTREAM_CHANGED", "article delete controls not found", {
      reason: "delete_menu_click_failed",
    });
  }

  await page.waitForTimeout(700);
  await page.evaluate(({ op }) => {
    if (op !== "article_confirm_delete") {
      return;
    }
    const dialog = document.querySelector("[role='dialog'], [data-testid='confirmationSheetDialog']");
    const dialogButtons = dialog
      ? Array.from(dialog.querySelectorAll<HTMLElement>("button, div[role='button']"))
      : [];
    const dialogConfirm = dialogButtons.find((element) => {
      const testId = element.getAttribute("data-testid") || "";
      const text = (element.textContent || "").replace(/\s+/g, " ").trim();
      return testId === "confirmationSheetConfirm" || text === "Delete Article";
    });
    if (dialogConfirm) {
      dialogConfirm.click();
      return;
    }
    const buttons = Array.from(document.querySelectorAll<HTMLElement>("button, div[role='button']")).filter((element) => {
      const text = (element.textContent || "").replace(/\s+/g, " ").trim();
      return text === "Delete Article";
    });
    const button = buttons[buttons.length - 1];
    button?.click();
  }, { op: "article_confirm_delete" }).catch(() => {});

  const deleted = await page
    .waitForFunction(() => {
      const bodyText = document.body?.innerText || "";
      return window.location.pathname === "/compose/articles" || bodyText.includes("Continue a draft or create a new Article");
    }, undefined, { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!deleted) {
    const details = await page.evaluate(() => {
      const buttonLabels = Array.from(document.querySelectorAll<HTMLElement>("button, div[role='button']"))
        .map((element) => ({
          text: (element.textContent || "").replace(/\s+/g, " ").trim(),
          aria: element.getAttribute("aria-label") || "",
          testId: element.getAttribute("data-testid") || "",
        }))
        .filter((item) => item.text || item.aria || item.testId)
        .slice(0, 40);
      const bodyLines = (document.body?.innerText || "")
        .split(/\n+/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(0, 40);
      return {
        currentUrl: window.location.href,
        dialogOpen: document.querySelector("[role='dialog'], [data-testid='confirmationSheetDialog']") !== null,
        buttonLabels,
        bodyLines,
      };
    }).catch(() => undefined);
    return errorResult("ACTION_UNCONFIRMED", "article delete was not confirmed", details);
  }

  return {
    ok: true,
    confirmed: true,
  };
}

async function draftArticleMarkdown(
  page: Page,
  markdownPath: string,
  explicitTitle: string | undefined,
  coverImagePath: string | undefined,
): Promise<JsonValue> {
  const resolvedMarkdown = await resolveArticleAttachment(markdownPath, "markdownPath");
  if (!resolvedMarkdown.ok || !resolvedMarkdown.attachment) {
    return resolvedMarkdown.ok ? errorResult("VALIDATION_ERROR", "markdownPath was not found") : resolvedMarkdown.result;
  }
  const markdown = await readFile(resolvedMarkdown.attachment.path, "utf8").catch(() => undefined);
  if (markdown === undefined) {
    return errorResult("VALIDATION_ERROR", `markdownPath was not found: ${markdownPath}`);
  }

  const title = extractArticleTitle(markdown, resolvedMarkdown.attachment.path, explicitTitle);
  const draftAssets = prepareArticleMarkdown(markdown, resolvedMarkdown.attachment.path);
  const resolvedInlineImages: ArticleInlineImage[] = [];
  for (const image of draftAssets.inlineImages) {
    const resolved = await resolveArticleAttachment(image.path, image.marker);
    if (!resolved.ok || !resolved.attachment) {
      return resolved.ok
        ? errorResult("VALIDATION_ERROR", `${image.marker} was not found`)
        : resolved.result;
    }
    resolvedInlineImages.push({
      ...image,
      path: resolved.attachment.path,
      name: resolved.attachment.name,
    });
  }

  const articlePage = await page.context().newPage();
  let shouldClose = true;
  try {
    await ensureNetworkCaptureInstalled(articlePage);
    await articlePage.goto("https://x.com/compose/articles", { waitUntil: "domcontentloaded", timeout: 60_000 });
    const started = await openNewArticleEditor(articlePage);
    if (!started.ok) {
      return errorResult("UPSTREAM_CHANGED", "article editor could not be opened", {
        reason: started.reason,
      });
    }

    const titleSet = await setArticleTitle(articlePage, title);
    if (!titleSet) {
      return errorResult("UPSTREAM_CHANGED", "article title controls not found");
    }

    if (coverImagePath) {
      const resolvedCover = await resolveArticleAttachment(coverImagePath, "coverImagePath");
      if (!resolvedCover.ok || !resolvedCover.attachment) {
        return resolvedCover.ok ? errorResult("VALIDATION_ERROR", "coverImagePath was not found") : resolvedCover.result;
      }
      const coverTriggered = await triggerArticleCoverUpload(articlePage);
      if (!coverTriggered) {
        return errorResult("UPSTREAM_CHANGED", "article cover upload controls not found");
      }
      const coverUploaded = await uploadArticleFile(articlePage, resolvedCover.attachment.path);
      if (!coverUploaded) {
        return errorResult("UPSTREAM_CHANGED", "article cover upload failed");
      }
    }

    const pasted = await pasteArticleMarkdown(articlePage, draftAssets.markdown);
    if (!pasted) {
      return errorResult("UPSTREAM_CHANGED", "article markdown paste failed");
    }

    const inlineUploadResult = await uploadArticleInlineImages(articlePage, resolvedInlineImages);
    if (!inlineUploadResult.ok) {
      return errorResult("UPSTREAM_CHANGED", "article inline image upload failed", {
        reason: inlineUploadResult.reason,
      });
    }

    const editUrl = started.editUrl;
    const articleId = parseArticleIdFromUrl(editUrl);

    const output: Record<string, JsonValue> = {
      ok: true,
      editUrl,
      title,
      inlineImageCount: resolvedInlineImages.length,
      hasCoverImage: typeof coverImagePath === "string" && coverImagePath.trim().length > 0,
    };
    if (articleId) {
      output.articleId = articleId;
      const persisted = await waitForArticleDraftPersisted(articlePage, articleId, title);
      output.persisted = persisted;
      output.sessionScoped = !persisted;
      await cacheArticleDraftPage(page, articleId, articlePage);
      shouldClose = false;
    }
    return output;
  } finally {
    if (shouldClose) {
      await articlePage.close().catch(() => {});
    }
  }
}

async function publishArticleMarkdown(
  page: Page,
  markdownPath: string,
  explicitTitle: string | undefined,
  coverImagePath: string | undefined,
  dryRun: boolean,
  timeoutMs: number,
): Promise<JsonValue> {
  const drafted = await draftArticleMarkdown(page, markdownPath, explicitTitle, coverImagePath);
  if (dryRun) {
    if (drafted && typeof drafted === "object" && !Array.isArray(drafted) && !("error" in drafted)) {
      return { ...drafted, dryRun: true };
    }
    return drafted;
  }
  if (!drafted || typeof drafted !== "object" || Array.isArray(drafted) || ("error" in drafted)) {
    return drafted;
  }
  const editUrl = typeof drafted.editUrl === "string" ? drafted.editUrl : "";
  if (!editUrl) {
    return errorResult("UPSTREAM_CHANGED", "article draft edit url not found");
  }
  return await withEphemeralPage(page, editUrl, async (articlePage) => {
    await waitForArticleEditorSurface(articlePage);
    const published = await publishArticleEditor(articlePage, timeoutMs);
    if (!published.ok) {
      const details: Record<string, JsonValue> = {
        reason: published.reason,
      };
      if (published.details) {
        details.debug = published.details;
      }
      return errorResult("ACTION_UNCONFIRMED", "article publish was not confirmed", {
        ...details,
      });
    }
    const output: Record<string, JsonValue> = {
      ...drafted,
      confirmed: true,
      editUrl: published.editUrl,
    };
    if (published.articleId) {
      output.articleId = published.articleId;
    }
    if (published.articleUrl) {
      output.articleUrl = published.articleUrl;
    }
    return output;
  });
}

async function publishExistingArticle(page: Page, targetUrl: string, timeoutMs: number): Promise<JsonValue> {
  const articleId = parseArticleIdFromUrl(targetUrl);
  const cachedPage = articleId ? getCachedArticleDraftPage(page, articleId) : undefined;
  const runPublish = async (articlePage: Page): Promise<JsonValue> => {
    await waitForArticleEditorSurface(articlePage);
    await ensureArticleDraftLoaded(articlePage, articleId);
    const published = await publishArticleEditor(articlePage, timeoutMs);
    if (!published.ok) {
      const details: Record<string, JsonValue> = {
        reason: published.reason,
      };
      if (published.details) {
        details.debug = published.details;
      }
      return errorResult("ACTION_UNCONFIRMED", "article publish was not confirmed", details);
    }
    const output: Record<string, JsonValue> = {
      ok: true,
      confirmed: true,
      editUrl: published.editUrl,
    };
    if (published.articleId) {
      output.articleId = published.articleId;
    }
    if (published.articleUrl) {
      output.articleUrl = published.articleUrl;
    }
    return output;
  };
  if (cachedPage) {
    const result = await runPublish(cachedPage);
    if (articleId && (!result || typeof result !== "object" || Array.isArray(result) || !("error" in result))) {
      await removeCachedArticleDraftPage(page, articleId);
    }
    return result;
  }
  return await withEphemeralPage(page, targetUrl, runPublish);
}

async function withArticleDraftPage<T>(
  ownerPage: Page,
  targetUrl: string,
  run: (articlePage: Page, articleId?: string, sessionScoped?: boolean) => Promise<T>,
): Promise<T> {
  const articleId = parseArticleIdFromUrl(targetUrl);
  const cachedPage = articleId ? getCachedArticleDraftPage(ownerPage, articleId) : undefined;
  if (cachedPage) {
    const cachedUrl = cachedPage.url();
    const cachedArticleId = parseArticleIdFromUrl(cachedUrl);
    if (!articleId || cachedArticleId === articleId) {
      await waitForArticleEditorSurface(cachedPage);
      await ensureArticleDraftLoaded(cachedPage, articleId);
      return await run(cachedPage, articleId, true);
    }
  }
  return await withEphemeralPage(ownerPage, targetUrl, async (articlePage) => {
    await waitForArticleEditorSurface(articlePage);
    await ensureArticleDraftLoaded(articlePage, articleId);
    return await run(articlePage, articleId, false);
  });
}

async function setArticleCoverImage(
  page: Page,
  targetUrl: string,
  coverImagePath: string,
): Promise<JsonValue> {
  const resolvedCover = await resolveArticleAttachment(coverImagePath, "coverImagePath");
  if (!resolvedCover.ok || !resolvedCover.attachment) {
    return resolvedCover.ok ? errorResult("VALIDATION_ERROR", "coverImagePath was not found") : resolvedCover.result;
  }
  const coverAttachment = resolvedCover.attachment;
  return await withArticleDraftPage(page, targetUrl, async (articlePage, articleId, sessionScoped) => {
    const coverTriggered = await triggerArticleCoverUpload(articlePage);
    if (!coverTriggered) {
      return errorResult("UPSTREAM_CHANGED", "article cover upload controls not found");
    }
    const coverUploaded = await uploadArticleFile(articlePage, coverAttachment.path);
    if (!coverUploaded) {
      return errorResult("UPSTREAM_CHANGED", "article cover upload failed");
    }
    const output: Record<string, JsonValue> = {
      ok: true,
      editUrl: articlePage.url(),
      hasCoverImage: true,
    };
    if (articleId) {
      output.articleId = articleId;
      output.sessionScoped = sessionScoped === true;
    }
    return output;
  });
}

async function updateArticleMarkdown(
  page: Page,
  targetUrl: string,
  markdownPath: string,
  explicitTitle: string | undefined,
): Promise<JsonValue> {
  const resolvedMarkdown = await resolveArticleAttachment(markdownPath, "markdownPath");
  if (!resolvedMarkdown.ok || !resolvedMarkdown.attachment) {
    return resolvedMarkdown.ok ? errorResult("VALIDATION_ERROR", "markdownPath was not found") : resolvedMarkdown.result;
  }
  const markdown = await readFile(resolvedMarkdown.attachment.path, "utf8").catch(() => undefined);
  if (markdown === undefined) {
    return errorResult("VALIDATION_ERROR", `markdownPath was not found: ${markdownPath}`);
  }
  const title = extractArticleTitle(markdown, resolvedMarkdown.attachment.path, explicitTitle);
  const draftAssets = prepareArticleMarkdown(markdown, resolvedMarkdown.attachment.path);
  const resolvedInlineImages: ArticleInlineImage[] = [];
  for (const image of draftAssets.inlineImages) {
    const resolved = await resolveArticleAttachment(image.path, image.marker);
    if (!resolved.ok || !resolved.attachment) {
      return resolved.ok
        ? errorResult("VALIDATION_ERROR", `${image.marker} was not found`)
        : resolved.result;
    }
    resolvedInlineImages.push({
      ...image,
      path: resolved.attachment.path,
      name: resolved.attachment.name,
    });
  }
  return await withArticleDraftPage(page, targetUrl, async (articlePage, articleId, sessionScoped) => {
    const titleSet = await setArticleTitle(articlePage, title);
    if (!titleSet) {
      return errorResult("UPSTREAM_CHANGED", "article title controls not found");
    }
    const cleared = await clearArticleBody(articlePage);
    if (!cleared) {
      return errorResult("UPSTREAM_CHANGED", "article body controls not found");
    }
    const pasted = await pasteArticleMarkdown(articlePage, draftAssets.markdown);
    if (!pasted) {
      return errorResult("UPSTREAM_CHANGED", "article markdown paste failed");
    }
    const inlineUploadResult = await uploadArticleInlineImages(articlePage, resolvedInlineImages);
    if (!inlineUploadResult.ok) {
      return errorResult("UPSTREAM_CHANGED", "article inline image upload failed", {
        reason: inlineUploadResult.reason,
      });
    }
    const output: Record<string, JsonValue> = {
      ok: true,
      title,
      editUrl: articlePage.url(),
      inlineImageCount: resolvedInlineImages.length,
    };
    if (articleId) {
      output.articleId = articleId;
      const persisted = await waitForArticleDraftPersisted(articlePage, articleId, title);
      output.persisted = persisted;
      output.sessionScoped = sessionScoped === true || !persisted;
    }
    return output;
  });
}

async function waitForGrokSurface(page: Page): Promise<void> {
  await page
    .waitForFunction(() => {
      const composer =
        document.querySelector("textarea") ||
        document.querySelector("[contenteditable='true'][role='textbox']") ||
        document.querySelector("[role='textbox'][contenteditable='true']");
      const messages =
        document.querySelector("[data-message-author-role='assistant']") ||
        document.querySelector("[data-testid*='assistant']") ||
        document.querySelector("article");
      return composer !== null || messages !== null;
    }, undefined, { timeout: 12_000 })
    .catch(() => {});
  await page.waitForTimeout(800);
}

async function submitGrokPrompt(page: Page, prompt: string): Promise<GrokComposeDomResult> {
  const composerSelectors = [
    "textarea",
    "[contenteditable='true'][role='textbox']",
    "[role='textbox'][contenteditable='true']",
  ];
  const submitSelectors = [
    "button[aria-label*='Grok something']",
    "button[aria-label*='Send']",
    "button[aria-label*='send']",
    "button[data-testid*='send']",
    "button[type='submit']",
  ];
  const selectAllShortcut = process.platform === "darwin" ? "Meta+A" : "Control+A";

  let composerSelector: string | undefined;
  for (const selector of composerSelectors) {
    const handle = await page.waitForSelector(selector, { timeout: 1_200 }).catch(() => null);
    if (!handle) {
      continue;
    }
    await handle.dispose().catch(() => {});
    composerSelector = selector;
    break;
  }

  if (!composerSelector) {
    return { ok: false, reason: "composer_not_found" };
  }

  try {
    await page.click(composerSelector);
    await page.keyboard.press(selectAllShortcut).catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    await page.type(composerSelector, prompt, { delay: 12 });
  } catch {
    return { ok: false, reason: "compose_input_failed" };
  }

  const submitSelector = await page.evaluate((selectors) => {
    const normalize = (value: string): string => value.replace(/\s+/g, " ").trim().toLowerCase();

    for (const selector of selectors) {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) {
        continue;
      }
      if (element instanceof HTMLButtonElement && element.disabled) {
        continue;
      }
      const ariaDisabled = (element.getAttribute("aria-disabled") ?? "").toLowerCase();
      if (ariaDisabled === "true") {
        continue;
      }
      const label = normalize(element.getAttribute("aria-label") ?? element.textContent ?? "");
      if (label.includes("stop")) {
        continue;
      }
      return selector;
    }
    return undefined;
  }, submitSelectors);

  if (!submitSelector) {
    return { ok: false, reason: "submit_not_found" };
  }

  try {
    await page.click(submitSelector);
  } catch {
    return { ok: false, reason: "submit_click_failed" };
  }

  return { ok: true };
}

async function prepareGrokSession(page: Page, conversationId?: string): Promise<void> {
  const targetUrl =
    typeof conversationId === "string" && conversationId.trim().length > 0
      ? `https://x.com/i/grok?conversation=${encodeURIComponent(conversationId.trim())}`
      : "https://x.com/i/grok";

  if (!isSameLocation(page.url(), targetUrl)) {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  }

  await waitForGrokSurface(page);

  if (conversationId && conversationId.trim().length > 0) {
    return;
  }

  const currentConversationId = (() => {
    try {
      return new URL(page.url()).searchParams.get("conversation") ?? undefined;
    } catch {
      return undefined;
    }
  })();

  if (typeof (page as { locator?: unknown }).locator !== "function") {
    return;
  }

  const newChatButton = page
    .locator("button[aria-label*='New Chat'], button:has-text('New Chat')")
    .first();
  if ((await newChatButton.count().catch(() => 0)) === 0) {
    return;
  }

  await newChatButton.click({ timeout: 2_000 }).catch(() => {});
  await page
    .waitForFunction(
      ({ previousConversationId }) => {
        const currentUrl = window.location.href;
        try {
          const conversation = new URL(currentUrl).searchParams.get("conversation") ?? undefined;
          if (!previousConversationId) {
            return conversation === undefined || conversation.length === 0;
          }
          return conversation !== previousConversationId;
        } catch {
          return false;
        }
      },
      { previousConversationId: currentConversationId },
      { timeout: 5_000 },
    )
    .catch(() => {});
  await page.waitForTimeout(600);
  await waitForGrokSurface(page);
}

async function uploadGrokAttachments(page: Page, attachments: GrokAttachment[]): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (attachments.length === 0) {
    return { ok: true };
  }

  const uploadSelectors = [
    "input[type='file'][accept*='application/pdf']",
    "input[type='file'][accept*='text/csv']",
    "input[type='file'][accept*='text/plain']",
    "input[type='file']",
  ];

  let uploadSelector: string | undefined;
  for (const selector of uploadSelectors) {
    const handle = await page.waitForSelector(selector, { timeout: 1_200 }).catch(() => null);
    if (!handle) {
      continue;
    }
    await handle.dispose().catch(() => {});
    uploadSelector = selector;
    break;
  }

  if (!uploadSelector) {
    return { ok: false, reason: "attachment_input_not_found" };
  }

  try {
    await page.setInputFiles(uploadSelector, attachments.map((attachment) => attachment.path));
  } catch {
    return { ok: false, reason: "attachment_upload_failed" };
  }

  const attachmentNames = attachments.map((attachment) => attachment.name);
  await page
    .waitForFunction(
      ({ names }) => {
        const bodyText = document.body?.innerText ?? "";
        return names.every((name) => bodyText.includes(name));
      },
      { names: attachmentNames },
      { timeout: 10_000 },
    )
    .catch(() => {});

  await page.waitForTimeout(600);
  return { ok: true };
}

async function askGrokViaNetwork(
  page: Page,
  prompt: string,
  timeoutMs: number,
): Promise<{ ok: true; response: string; url: string; conversationId?: string; artifacts?: GrokArtifact[] } | undefined> {
  const captured = await captureRoutedResponseText(
    page,
    "https://grok.x.com/2/grok/add_response.json*",
    async () => {
      const submitResult = await submitGrokPrompt(page, prompt);
      return submitResult.ok;
    },
    {
      timeoutMs,
    },
  );

  if (!captured || captured.status < 200 || captured.status >= 300) {
    return undefined;
  }

  const responseText = captured.text;
  const entries = parseNdjsonLines<{
    conversationId?: string;
    result?: {
      message?: string;
      messageTag?: string;
    };
  }>(responseText);
  const finalParts = collectTextByTag(
    entries.map((entry) => {
      const output: { message?: string; messageTag?: string } = {};
      if (typeof entry.result?.message === "string") {
        output.message = entry.result.message;
      }
      if (typeof entry.result?.messageTag === "string") {
        output.messageTag = entry.result.messageTag;
      }
      return output;
    }),
    "final",
  );
    let conversationId: string | undefined;
    for (const entry of entries) {
      if (!conversationId && typeof entry.conversationId === "string") {
        conversationId = entry.conversationId;
      }
    }

  const finalResponse = joinTextParts(finalParts).trim();
  if (!finalResponse) {
    return undefined;
  }
  const artifactResult = await materializeGrokArtifacts(finalResponse);

  const output: { ok: true; response: string; url: string; conversationId?: string; artifacts?: GrokArtifact[] } = {
    ok: true,
    response: artifactResult.response,
    url: typeof conversationId === "string" ? `https://x.com/i/grok?conversation=${conversationId}` : page.url(),
  };
  if (typeof conversationId === "string") {
    output.conversationId = conversationId;
  }
  if (artifactResult.artifacts) {
    output.artifacts = artifactResult.artifacts;
  }
  return output;
}

async function waitForGrokResponse(
  page: Page,
  previousResponse: string | undefined,
  prompt: string,
  timeoutMs: number,
): Promise<{ confirmed: boolean; response?: string }> {
  try {
    await page.waitForFunction(
      ({ op, previous, promptText }) => {
        if (op !== "grok_wait") {
          return false;
        }

        const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
        const previousText = normalize(previous);
        const normalizedPrompt = normalize(promptText);
        const isIgnoredResponse = (value: string): boolean => {
          const lower = value.toLowerCase();
          return (
            lower.length < 3 ||
            lower.startsWith("see new posts") ||
            lower.startsWith("thought for ") ||
            lower.startsWith("agents thinking") ||
            lower.startsWith("ask anything") ||
            lower === "agents" ||
            lower === "thinking" ||
            lower === "expert" ||
            lower.startsWith("grok") ||
            lower.includes("explore ") ||
            lower.includes("discuss ") ||
            lower.includes("create images") ||
            lower.includes("edit image") ||
            lower.includes("latest news") ||
            lower === normalizedPrompt.toLowerCase() ||
            lower === previousText.toLowerCase()
          );
        };
        const scope =
          document.querySelector<HTMLElement>("div[aria-label='Grok']") ??
          document.querySelector<HTMLElement>("main");
        if (!scope) {
          return false;
        }
        const lines = (scope.innerText || scope.textContent || "")
          .split(/\n+/)
          .map((line) => normalize(line))
          .filter((line) => line.length > 0);
        const linePromptIndex = lines.lastIndexOf(normalizedPrompt);
        if (linePromptIndex >= 0) {
          const hasStopControl = Array.from(document.querySelectorAll<HTMLElement>("button")).some((button) => {
            const label = normalize(button.getAttribute("aria-label") ?? button.textContent ?? "").toLowerCase();
            return label.includes("stop");
          });
          let hasLineCandidate = false;
          for (let index = linePromptIndex + 1; index < lines.length; index += 1) {
            const candidate = lines[index];
            if (!candidate || isIgnoredResponse(candidate)) {
              continue;
            }
            hasLineCandidate = true;
          }
          if (!hasStopControl && hasLineCandidate) {
            return true;
          }
        }
        const entries: string[] = [];
        for (const node of Array.from(scope.querySelectorAll<HTMLElement>("div, span, p"))) {
          if (node.closest("button, a, textarea, nav")) {
            continue;
          }
          const text = normalize(node.innerText || node.textContent || "");
          if (!text) {
            continue;
          }
          const childWithSameText = Array.from(node.children).some((child) => {
            if (!(child instanceof HTMLElement)) {
              return false;
            }
            return normalize(child.innerText || child.textContent || "") === text;
          });
          if (childWithSameText) {
            continue;
          }
          if (entries[entries.length - 1] !== text) {
            entries.push(text);
          }
        }

        const hasStopControl = Array.from(document.querySelectorAll<HTMLElement>("button")).some((button) => {
          const label = normalize(button.getAttribute("aria-label") ?? button.textContent ?? "").toLowerCase();
          return label.includes("stop");
        });

        const promptIndex = entries.lastIndexOf(normalizedPrompt);
        if (promptIndex < 0) {
          return false;
        }

        let hasCandidate = false;
        for (let index = promptIndex + 1; index < entries.length; index += 1) {
          const candidate = entries[index];
          if (!candidate || isIgnoredResponse(candidate)) {
            continue;
          }
          hasCandidate = true;
        }

        return !hasStopControl && hasCandidate;
      },
      {
        op: "grok_wait",
        previous: (previousResponse ?? "").replace(/\s+/g, " ").trim(),
        promptText: prompt,
      },
      { timeout: timeoutMs },
    );
  } catch {
    return { confirmed: false };
  }

  const state = await page.evaluate(({ op, promptText, previousText }) => {
    if (op !== "grok_extract_state") {
      return undefined;
    }

    const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
    const normalizedPrompt = normalize(promptText);
    const normalizedPrevious = normalize(previousText);
    const isIgnoredResponse = (value: string): boolean => {
      const lower = value.toLowerCase();
      return (
        lower.length < 3 ||
        lower.startsWith("see new posts") ||
        lower.startsWith("thought for ") ||
        lower.startsWith("agents thinking") ||
        lower.startsWith("ask anything") ||
        lower === "agents" ||
        lower === "thinking" ||
        lower === "expert" ||
        lower.startsWith("grok") ||
        lower.includes("explore ") ||
        lower.includes("discuss ") ||
        lower.includes("create images") ||
        lower.includes("edit image") ||
        lower.includes("latest news") ||
        lower === normalizedPrompt.toLowerCase() ||
        lower === normalizedPrevious.toLowerCase()
      );
    };
    const scope =
      document.querySelector<HTMLElement>("div[aria-label='Grok']") ??
      document.querySelector<HTMLElement>("main");
    if (!scope) {
      return undefined;
    }
    const lines = (scope.innerText || scope.textContent || "")
      .split(/\n+/)
      .map((line) => normalize(line))
      .filter((line) => line.length > 0);
    const lineResponseCandidates: string[] = [];
    const linePromptIndex = lines.lastIndexOf(normalizedPrompt);
    if (linePromptIndex >= 0) {
      for (let index = linePromptIndex + 1; index < lines.length; index += 1) {
        const candidate = lines[index];
        if (!candidate || isIgnoredResponse(candidate)) {
          continue;
        }
        lineResponseCandidates.push(candidate);
      }
    }
    let responseForPrompt: string | undefined;
    if (lineResponseCandidates.length > 0) {
      responseForPrompt = lineResponseCandidates.sort((left, right) => right.length - left.length)[0];
    }
    if (responseForPrompt) {
      let latestResponse = responseForPrompt;
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const candidate = lines[index];
        if (!candidate || isIgnoredResponse(candidate)) {
          continue;
        }
        latestResponse = candidate;
        break;
      }
      return {
        responseForPrompt,
        latestResponse,
      };
    }

    const entries: string[] = [];
    for (const node of Array.from(scope.querySelectorAll<HTMLElement>("div, span, p"))) {
      if (node.closest("button, a, textarea, nav")) {
        continue;
      }
      const text = normalize(node.innerText || node.textContent || "");
      if (!text) {
        continue;
      }
      const childWithSameText = Array.from(node.children).some((child) => {
        if (!(child instanceof HTMLElement)) {
          return false;
        }
        return normalize(child.innerText || child.textContent || "") === text;
      });
      if (childWithSameText) {
        continue;
      }
      if (entries[entries.length - 1] !== text) {
        entries.push(text);
      }
    }

    const responseCandidates: string[] = [];
    const promptIndex = entries.lastIndexOf(normalizedPrompt);
    if (promptIndex >= 0) {
      for (let index = promptIndex + 1; index < entries.length; index += 1) {
        const candidate = entries[index];
        if (!candidate || isIgnoredResponse(candidate)) {
          continue;
        }
        responseCandidates.push(candidate);
      }
    }

    responseForPrompt = undefined;
    if (responseCandidates.length > 0) {
      responseForPrompt = responseCandidates.sort((left, right) => right.length - left.length)[0];
    }

    let latestResponse: string | undefined;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const candidate = entries[index];
      if (!candidate || isIgnoredResponse(candidate)) {
        continue;
      }
      latestResponse = candidate;
      break;
    }

    return {
      responseForPrompt,
      latestResponse,
    };
  }, {
    op: "grok_extract_state",
    promptText: prompt,
    previousText: previousResponse ?? "",
  });

  if (state && typeof state === "object" && typeof state.responseForPrompt === "string" && state.responseForPrompt.length > 0) {
    await page.waitForTimeout(600);
    const settledState = await page.evaluate(({ op, promptText, previousText }) => {
      if (op !== "grok_extract_state") {
        return undefined;
      }

      const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
      const normalizedPrompt = normalize(promptText);
      const normalizedPrevious = normalize(previousText);
      const isIgnoredResponse = (value: string): boolean => {
        const lower = value.toLowerCase();
        return (
          lower.length < 3 ||
          lower.startsWith("see new posts") ||
          lower.startsWith("thought for ") ||
          lower.startsWith("agents thinking") ||
          lower.startsWith("ask anything") ||
          lower === "agents" ||
          lower === "thinking" ||
          lower === "expert" ||
          lower.startsWith("grok") ||
          lower.includes("explore ") ||
          lower.includes("discuss ") ||
          lower.includes("create images") ||
          lower.includes("edit image") ||
          lower.includes("latest news") ||
          lower === normalizedPrompt.toLowerCase() ||
          lower === normalizedPrevious.toLowerCase()
        );
      };
      const scope =
        document.querySelector<HTMLElement>("div[aria-label='Grok']") ??
        document.querySelector<HTMLElement>("main");
      if (!scope) {
        return undefined;
      }
      const lines = (scope.innerText || scope.textContent || "")
        .split(/\n+/)
        .map((line) => normalize(line))
        .filter((line) => line.length > 0);
      const lineResponseCandidates: string[] = [];
      const linePromptIndex = lines.lastIndexOf(normalizedPrompt);
      if (linePromptIndex >= 0) {
        for (let index = linePromptIndex + 1; index < lines.length; index += 1) {
          const candidate = lines[index];
          if (!candidate || isIgnoredResponse(candidate)) {
            continue;
          }
          lineResponseCandidates.push(candidate);
        }
      }
      if (lineResponseCandidates.length > 0) {
        return {
          responseForPrompt: lineResponseCandidates.sort((left, right) => right.length - left.length)[0],
        };
      }

      const entries: string[] = [];
      for (const node of Array.from(scope.querySelectorAll<HTMLElement>("div, span, p"))) {
        if (node.closest("button, a, textarea, nav")) {
          continue;
        }
        const text = normalize(node.innerText || node.textContent || "");
        if (!text) {
          continue;
        }
        const childWithSameText = Array.from(node.children).some((child) => {
          if (!(child instanceof HTMLElement)) {
            return false;
          }
          return normalize(child.innerText || child.textContent || "") === text;
        });
        if (childWithSameText) {
          continue;
        }
        if (entries[entries.length - 1] !== text) {
          entries.push(text);
        }
      }

      const responseCandidates: string[] = [];
      const promptIndex = entries.lastIndexOf(normalizedPrompt);
      if (promptIndex >= 0) {
        for (let index = promptIndex + 1; index < entries.length; index += 1) {
          const candidate = entries[index];
          if (!candidate || isIgnoredResponse(candidate)) {
            continue;
          }
          responseCandidates.push(candidate);
        }
      }

      let responseForPrompt: string | undefined;
      if (responseCandidates.length > 0) {
        responseForPrompt = responseCandidates.sort((left, right) => right.length - left.length)[0];
      }

      return {
        responseForPrompt,
      };
    }, {
      op: "grok_extract_state",
      promptText: prompt,
      previousText: previousResponse ?? "",
    });

    if (
      settledState &&
      typeof settledState === "object" &&
      typeof settledState.responseForPrompt === "string" &&
      settledState.responseForPrompt.length > 0
    ) {
      return {
        confirmed: true,
        response: settledState.responseForPrompt,
      };
    }
  }

  if (state && typeof state === "object" && typeof state.responseForPrompt === "string" && state.responseForPrompt.length > 0) {
    return {
      confirmed: true,
      response: state.responseForPrompt,
    };
  }
  return { confirmed: false };
}

async function readLatestGrokResponse(page: Page): Promise<string | undefined> {
  const state = await page.evaluate(({ op }) => {
    if (op !== "grok_extract_state") {
      return undefined;
    }

    const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
    const isIgnoredResponse = (value: string): boolean => {
      const lower = value.toLowerCase();
      return (
        lower.length < 3 ||
        lower.startsWith("see new posts") ||
        lower.startsWith("thought for ") ||
        lower.startsWith("agents thinking") ||
        lower.startsWith("ask anything") ||
        lower === "agents" ||
        lower === "thinking" ||
        lower === "expert" ||
        lower.startsWith("grok") ||
        lower.includes("explore ")
      );
    };
    const scope =
      document.querySelector<HTMLElement>("div[aria-label='Grok']") ??
      document.querySelector<HTMLElement>("main");
    if (!scope) {
      return undefined;
    }
    const lines = (scope.innerText || scope.textContent || "")
      .split(/\n+/)
      .map((line) => normalize(line))
      .filter((line) => line.length > 0);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const candidate = lines[index];
      if (!candidate || isIgnoredResponse(candidate)) {
        continue;
      }
      return { latestResponse: candidate };
    }

    const entries: string[] = [];
    for (const node of Array.from(scope.querySelectorAll<HTMLElement>("div, span, p"))) {
      if (node.closest("button, a, textarea, nav")) {
        continue;
      }
      const text = normalize(node.innerText || node.textContent || "");
      if (!text || isIgnoredResponse(text)) {
        continue;
      }
      const childWithSameText = Array.from(node.children).some((child) => {
        if (!(child instanceof HTMLElement)) {
          return false;
        }
        return normalize(child.innerText || child.textContent || "") === text;
      });
      if (childWithSameText) {
        continue;
      }
      if (entries[entries.length - 1] !== text) {
        entries.push(text);
      }
    }

    let latestResponse: string | undefined;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const candidate = entries[index];
      if (!candidate || isIgnoredResponse(candidate)) {
        continue;
      }
      latestResponse = candidate;
      break;
    }

    return { latestResponse };
  }, { op: "grok_extract_state" });

  if (state && typeof state === "object" && typeof state.latestResponse === "string") {
    return state.latestResponse;
  }
  return undefined;
}

function logGrokPhase(phase: string, details?: Record<string, JsonValue>): void {
  const payload: Record<string, JsonValue> = {
    phase,
  };
  if (details) {
    for (const [key, value] of Object.entries(details)) {
      if (value !== undefined) {
        payload[key] = value;
      }
    }
  }
  process.stderr.write(`[adapter-x grok] ${JSON.stringify(payload)}\n`);
}

async function askGrok(
  page: Page,
  prompt: string,
  timeoutMs: number,
  attachments: GrokAttachment[],
  conversationId?: string,
): Promise<JsonValue> {
  logGrokPhase("start", { timeoutMs, promptLength: prompt.length });
  try {
    const targetUrl =
      typeof conversationId === "string" && conversationId.trim().length > 0
        ? `https://x.com/i/grok?conversation=${encodeURIComponent(conversationId.trim())}`
        : "https://x.com/i/grok";
    return await withEphemeralPage(page, targetUrl, async (grokPage) => {
      logGrokPhase("page_opened", { url: grokPage.url() });
      await prepareGrokSession(grokPage, conversationId);
      logGrokPhase("surface_ready");
      const uploadResult = await uploadGrokAttachments(grokPage, attachments);
      const attachmentLogDetails: Record<string, JsonValue> = {
        ok: uploadResult.ok,
        attachmentCount: attachments.length,
      };
      if (!uploadResult.ok) {
        attachmentLogDetails.reason = uploadResult.reason;
      }
      logGrokPhase("attachments_ready", attachmentLogDetails);
      if (!uploadResult.ok) {
        return errorResult("UPSTREAM_CHANGED", "grok attachment controls not found", {
          reason: uploadResult.reason,
        });
      }
      const networkResult = await askGrokViaNetwork(grokPage, prompt, timeoutMs);
      logGrokPhase("network_result", {
        ok: networkResult?.ok === true,
        responseLength: networkResult?.response.length ?? 0,
      });
      if (networkResult?.ok) {
        const output: Record<string, JsonValue> = {
          ok: true,
          response: networkResult.response,
          url: networkResult.url,
        };
        if (networkResult.conversationId) {
          output.conversationId = networkResult.conversationId;
        }
        if (networkResult.artifacts) {
          output.artifacts = networkResult.artifacts as unknown as JsonValue;
        }
        return output;
      }
      await grokPage.goto("https://x.com/i/grok", { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
      await waitForGrokSurface(grokPage);
      const previousResponse = await readLatestGrokResponse(grokPage);
      logGrokPhase("previous_response_read", {
        hasPreviousResponse: previousResponse !== undefined,
        previousResponseLength: previousResponse?.length ?? 0,
      });
      const submitResult = await submitGrokPrompt(grokPage, prompt);
      const submitLogDetails: Record<string, JsonValue> = {
        ok: submitResult.ok,
      };
      if (submitResult.reason !== undefined) {
        submitLogDetails.reason = submitResult.reason;
      }
      logGrokPhase("submit_result", submitLogDetails);
      if (!submitResult.ok) {
        return errorResult("UPSTREAM_CHANGED", "grok controls not found", {
          reason: submitResult.reason ?? "unknown",
        });
      }

      logGrokPhase("wait_start", { timeoutMs });
      const confirmation = await waitForGrokResponse(grokPage, previousResponse, prompt, timeoutMs);
      logGrokPhase("wait_result", {
        confirmed: confirmation.confirmed,
        responseLength: confirmation.response?.length ?? 0,
      });
      if (!confirmation.confirmed || !confirmation.response) {
        return errorResult("ACTION_UNCONFIRMED", "grok response was not confirmed");
      }

      logGrokPhase("success", {
        responseLength: confirmation.response.length,
        url: grokPage.url(),
      });
      const output: Record<string, JsonValue> = {
        ok: true,
        response: confirmation.response,
        url: grokPage.url(),
      };
      if (conversationId) {
        output.conversationId = conversationId;
      }
      return output;
    });
  } catch (error) {
    const details: Record<string, JsonValue> = {};
    if (error instanceof Error) {
      details.name = error.name;
      details.message = error.message;
    } else if (error !== undefined) {
      details.message = String(error);
    }
    logGrokPhase("error", details);
    return errorResult("UPSTREAM_CHANGED", "grok execution threw", details);
  }
}

async function replyToTweet(
  page: Page,
  targetUrl: string,
  text: string,
  dryRun: boolean,
  timeoutMs: number,
): Promise<JsonValue> {
  return await withEphemeralPage(page, targetUrl, async (replyPage) => {
    await waitForTweetSurface(replyPage);
    await ensureReplyComposerReady(replyPage);
    const composeResult = await composeReply(replyPage, text, dryRun);
    if (!composeResult.ok) {
      return errorResult("UPSTREAM_CHANGED", "reply controls not found", {
        reason: composeResult.reason ?? "unknown",
      });
    }
    if (composeResult.dryRun) {
      return {
        ok: true,
        dryRun: true,
        submitVisible: composeResult.submitVisible === true,
        replyToUrl: targetUrl,
      };
    }

    const submitReady = await waitForReplySubmitReady(replyPage, timeoutMs);
    if (!submitReady) {
      return errorResult("UPSTREAM_CHANGED", "reply controls not ready", {
        reason: "submit_not_ready",
      });
    }

    const submitResult = await submitReply(replyPage);
    if (!submitResult.ok) {
      return errorResult("UPSTREAM_CHANGED", "reply controls not found", {
        reason: submitResult.reason ?? "unknown",
      });
    }

    const confirmation = await waitForReplyConfirmation(replyPage, targetUrl, text, timeoutMs);
    if (!confirmation.confirmed) {
      return errorResult("ACTION_UNCONFIRMED", "reply submit was not confirmed in timeline");
    }

    const result: Record<string, JsonValue> = {
      ok: true,
      confirmed: true,
      replyToUrl: targetUrl,
    };
    if (confirmation.statusUrl !== undefined) {
      result.statusUrl = confirmation.statusUrl;
    }
    return result;
  });
}

async function requireAuthenticated(page: Page): Promise<
  | {
      ok: true;
      auth: AuthProbeResult;
    }
  | {
      ok: false;
      result: JsonValue;
    }
> {
  const auth = await detectAuthStable(page);
  if (auth.state === "authenticated") {
    return { ok: true, auth };
  }
  if (auth.state === "challenge_required") {
    return {
      ok: false,
      result: errorResult("CHALLENGE_REQUIRED", "x.com challenge is blocking actions", {
        state: auth.state,
        signals: auth.signals,
      }),
    };
  }
  return {
    ok: false,
    result: errorResult("AUTH_REQUIRED", "login required", {
      state: auth.state,
      signals: auth.signals,
    }),
  };
}

export function createXAdapter(options?: CreateXAdapterOptions): SiteAdapter {
  const composeConfirmTimeoutMs = options?.composeConfirmTimeoutMs ?? DEFAULT_COMPOSE_CONFIRM_TIMEOUT_MS;
  const grokResponseTimeoutMs = options?.grokResponseTimeoutMs ?? DEFAULT_GROK_RESPONSE_TIMEOUT_MS;
  const articlePublishTimeoutMs = options?.articlePublishTimeoutMs ?? DEFAULT_ARTICLE_PUBLISH_TIMEOUT_MS;
  const maxPostLength = options?.maxPostLength ?? DEFAULT_MAX_POST_LENGTH;

  return {
    name: "adapter-x",
    start: async ({ page }) => {
      await ensureNetworkCaptureInstalled(page);
      await page.waitForLoadState("domcontentloaded").catch(() => {
        // Keep startup best-effort; auth probing will still run.
      });
      await warmupAuthProbe(page);
    },
    listTools: async () => TOOL_DEFINITIONS,
    callTool: async ({ name, input }, { page }) => {
      const args = toRecord(input);

      if (name === "auth.get") {
        const auth = await detectAuthStable(page);
        return {
          state: auth.state,
          signals: auth.signals,
        };
      }

      if (name === "timeline.home.list") {
        const authCheck = await requireAuthenticated(page);
        if (!authCheck.ok) {
          return authCheck.result;
        }

        const limit = normalizeTimelineLimit(args);
        const cursor = typeof args.cursor === "string" ? args.cursor.trim() : "";
        const result = cursor
          ? await readTimelineWithMode(page, "home", limit, cursor)
          : await readTimelineWithMode(page, "home", limit);
        if (result.source === "network" || result.items.length > 0) {
          return result;
        }
        return await withCachedReadOnlyPage(page, "home", "https://x.com/home", async (readPage) => {
          return cursor
            ? await readTimelineWithMode(readPage, "home", limit, cursor)
            : await readTimelineWithMode(readPage, "home", limit);
        });
      }

      if (name === "tweet.get") {
        const authCheck = await requireAuthenticated(page);
        if (!authCheck.ok) {
          return authCheck.result;
        }
        const url = typeof args.url === "string" ? args.url.trim() : "";
        const id = typeof args.id === "string" ? args.id.trim() : "";
        const targetUrl = url || (id ? `https://x.com/i/web/status/${id}` : "");
        if (!targetUrl) {
          return errorResult("VALIDATION_ERROR", "url or id is required");
        }
        return await readTweetByUrl(page, targetUrl);
      }

      if (name === "tweet.thread.get") {
        const authCheck = await requireAuthenticated(page);
        if (!authCheck.ok) {
          return authCheck.result;
        }
        const url = typeof args.url === "string" ? args.url.trim() : "";
        const id = typeof args.id === "string" ? args.id.trim() : "";
        const targetUrl = url || (id ? `https://x.com/i/web/status/${id}` : "");
        if (!targetUrl) {
          return errorResult("VALIDATION_ERROR", "url or id is required");
        }
        const limit = normalizeTimelineLimit(args);
        return await readTweetThreadByUrl(page, targetUrl, limit);
      }

      if (name === "tweet.media.download") {
        const authCheck = await requireAuthenticated(page);
        if (!authCheck.ok) {
          return authCheck.result;
        }
        const url = typeof args.url === "string" ? args.url.trim() : "";
        const id = typeof args.id === "string" ? args.id.trim() : "";
        const targetUrl = url || (id ? `https://x.com/i/web/status/${id}` : "");
        if (!targetUrl) {
          return errorResult("VALIDATION_ERROR", "url or id is required");
        }
        const mediaIndex = typeof args.mediaIndex === "number" && Number.isFinite(args.mediaIndex)
          ? Math.floor(args.mediaIndex)
          : undefined;
        return await downloadTweetMediaByUrl(page, targetUrl, mediaIndex);
      }

      if (name === "tweet.conversation.get") {
        const authCheck = await requireAuthenticated(page);
        if (!authCheck.ok) {
          return authCheck.result;
        }
        const url = typeof args.url === "string" ? args.url.trim() : "";
        const id = typeof args.id === "string" ? args.id.trim() : "";
        const targetUrl = url || (id ? `https://x.com/i/web/status/${id}` : "");
        if (!targetUrl) {
          return errorResult("VALIDATION_ERROR", "url or id is required");
        }
        const limit = normalizeTimelineLimit(args);
        const cursor = typeof args.cursor === "string" ? args.cursor.trim() : "";
        return await readTweetConversationByUrl(page, targetUrl, limit, cursor || undefined);
      }

      if (name === "tweet.replies.list") {
        const authCheck = await requireAuthenticated(page);
        if (!authCheck.ok) {
          return authCheck.result;
        }
        const url = typeof args.url === "string" ? args.url.trim() : "";
        const id = typeof args.id === "string" ? args.id.trim() : "";
        const targetUrl = url || (id ? `https://x.com/i/web/status/${id}` : "");
        if (!targetUrl) {
          return errorResult("VALIDATION_ERROR", "url or id is required");
        }
        const limit = normalizeTimelineLimit(args);
        const cursor = typeof args.cursor === "string" ? args.cursor.trim() : "";
        return await readTweetRepliesByUrl(page, targetUrl, limit, cursor || undefined);
      }

      if (name === "favorites.list") {
        const authCheck = await requireAuthenticated(page);
        if (!authCheck.ok) {
          return authCheck.result;
        }
        const limit = normalizeTimelineLimit(args);
        const cursor = typeof args.cursor === "string" ? args.cursor.trim() : "";
        return await withCachedReadOnlyPage(page, "bookmarks", "https://x.com/i/bookmarks", async (readPage) => {
          return cursor
            ? await readTimelineWithMode(readPage, "bookmarks", limit, cursor)
            : await readTimelineWithMode(readPage, "bookmarks", limit);
        });
      }

      if (name === "notifications.list") {
        const authCheck = await requireAuthenticated(page);
        if (!authCheck.ok) {
          return authCheck.result;
        }
        const limit = normalizeTimelineLimit(args);
        return await withCachedReadOnlyPage(page, "notifications", "https://x.com/notifications", async (readPage) => {
          return await readNotifications(readPage, limit);
        });
      }

      if (name === "mentions.list") {
        const authCheck = await requireAuthenticated(page);
        if (!authCheck.ok) {
          return authCheck.result;
        }
        const limit = normalizeTimelineLimit(args);
        return await withCachedReadOnlyPage(
          page,
          "notifications:mentions",
          "https://x.com/notifications/mentions",
          async (readPage) => {
            return await readNotifications(readPage, limit);
          },
        );
      }

      if (name === "timeline.user.list") {
        const authCheck = await requireAuthenticated(page);
        if (!authCheck.ok) {
          return authCheck.result;
        }
        const username = normalizeUsername(args.username);
        if (!username) {
          return errorResult("VALIDATION_ERROR", "username is required");
        }
        const limit = normalizeTimelineLimit(args);
        const cursor = typeof args.cursor === "string" ? args.cursor.trim() : "";
        const profileUrl = `https://x.com/${username}`;
        const cacheKey = `user:${username.toLowerCase()}`;
        return await withCachedReadOnlyPage(page, cacheKey, profileUrl, async (readPage) => {
          return cursor
            ? await readTimelineWithMode(readPage, "user_timeline", limit, cursor)
            : await readTimelineWithMode(readPage, "user_timeline", limit);
        });
      }

      if (name === "search.tweets.list") {
        const authCheck = await requireAuthenticated(page);
        if (!authCheck.ok) {
          return authCheck.result;
        }
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (!query) {
          return errorResult("VALIDATION_ERROR", "query is required");
        }
        const mode = normalizeSearchMode(args.mode);
        const limit = normalizeTimelineLimit(args);
        const cursor = typeof args.cursor === "string" ? args.cursor.trim() : "";
        const searchUrl = buildSearchUrl(query, mode);
        const cacheKey = `search:${mode}:${query.toLowerCase()}`;
        return await withCachedReadOnlyPage(page, cacheKey, searchUrl, async (readPage) => {
          return cursor
            ? await readTimelineWithMode(readPage, "search", limit, cursor)
            : await readTimelineWithMode(readPage, "search", limit);
        });
      }

      if (name === "user.get") {
        const authCheck = await requireAuthenticated(page);
        if (!authCheck.ok) {
          return authCheck.result;
        }
        const handle = typeof args.handle === "string" ? args.handle.trim() : "";
        if (!handle) {
          return errorResult("VALIDATION_ERROR", "handle is required");
        }
        return await readProfile(page, handle);
      }

      if (name === "tweet.create") {
        const authCheck = await requireAuthenticated(page);
        if (!authCheck.ok) {
          return authCheck.result;
        }

        const text = typeof args.text === "string" ? args.text.trim() : "";
        if (!text) {
          return errorResult("VALIDATION_ERROR", "text is required");
        }
        if (text.length > maxPostLength) {
          return errorResult("VALIDATION_ERROR", `text exceeds max length ${maxPostLength}`);
        }

        const dryRun = args.dryRun === true;
        await ensureComposerReady(page);
        const composeResult = await composePost(page, text, dryRun);
        if (!composeResult.ok) {
          return errorResult("UPSTREAM_CHANGED", "compose controls not found", {
            reason: composeResult.reason ?? "unknown",
          });
        }
        if (composeResult.dryRun) {
          return {
            ok: true,
            dryRun: true,
            submitVisible: composeResult.submitVisible === true,
          };
        }

        const confirmation = await waitForComposeConfirmation(page, text, composeConfirmTimeoutMs);
        if (!confirmation.confirmed) {
          return errorResult("ACTION_UNCONFIRMED", "post submit was not confirmed in timeline");
        }

        const result: Record<string, JsonValue> = {
          ok: true,
          confirmed: true,
        };
        if (confirmation.statusUrl !== undefined) {
          result.statusUrl = confirmation.statusUrl;
        }
        return result;
      }

      if (name === "tweet.reply") {
        const authCheck = await requireAuthenticated(page);
        if (!authCheck.ok) {
          return authCheck.result;
        }

        const text = typeof args.text === "string" ? args.text.trim() : "";
        if (!text) {
          return errorResult("VALIDATION_ERROR", "text is required");
        }
        if (text.length > maxPostLength) {
          return errorResult("VALIDATION_ERROR", `text exceeds max length ${maxPostLength}`);
        }

        const url = typeof args.url === "string" ? args.url.trim() : "";
        const id = typeof args.id === "string" ? args.id.trim() : "";
        const targetUrl = url || (id ? `https://x.com/i/web/status/${id}` : "");
        if (!targetUrl) {
          return errorResult("VALIDATION_ERROR", "url or id is required");
        }

        const dryRun = args.dryRun === true;
        return await replyToTweet(page, targetUrl, text, dryRun, composeConfirmTimeoutMs);
      }

      if (name === "grok.chat") {
        const authCheck = await requireAuthenticated(page);
        if (!authCheck.ok) {
          return authCheck.result;
        }

        const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
        if (!prompt) {
          return errorResult("VALIDATION_ERROR", "prompt is required");
        }

        const resolvedAttachments = await resolveGrokAttachments(args.attachmentPaths);
        if (!resolvedAttachments.ok) {
          return resolvedAttachments.result;
        }
        const conversationId = typeof args.conversationId === "string" ? args.conversationId.trim() : "";
        return await askGrok(
          page,
          prompt,
          grokResponseTimeoutMs,
          resolvedAttachments.attachments,
          conversationId || undefined,
        );
      }

      if (name === "article.draftMarkdown") {
        const authCheck = await requireAuthenticated(page);
        if (!authCheck.ok) {
          return authCheck.result;
        }

        const markdownPath = typeof args.markdownPath === "string" ? args.markdownPath.trim() : "";
        if (!markdownPath) {
          return errorResult("VALIDATION_ERROR", "markdownPath is required");
        }
        const explicitTitle = typeof args.title === "string" ? args.title.trim() : "";
        const coverImagePath = typeof args.coverImagePath === "string" ? args.coverImagePath.trim() : "";
        return await draftArticleMarkdown(
          page,
          markdownPath,
          explicitTitle || undefined,
          coverImagePath || undefined,
        );
      }

      if (name === "article.publishMarkdown") {
        const authCheck = await requireAuthenticated(page);
        if (!authCheck.ok) {
          return authCheck.result;
        }

        const markdownPath = typeof args.markdownPath === "string" ? args.markdownPath.trim() : "";
        if (!markdownPath) {
          return errorResult("VALIDATION_ERROR", "markdownPath is required");
        }
        const explicitTitle = typeof args.title === "string" ? args.title.trim() : "";
        const coverImagePath = typeof args.coverImagePath === "string" ? args.coverImagePath.trim() : "";
        const dryRun = args.dryRun === true;
        return await publishArticleMarkdown(
          page,
          markdownPath,
          explicitTitle || undefined,
          coverImagePath || undefined,
          dryRun,
          articlePublishTimeoutMs,
        );
      }

      if (name === "article.publish") {
        const authCheck = await requireAuthenticated(page);
        if (!authCheck.ok) {
          return authCheck.result;
        }
        const url = typeof args.url === "string" ? args.url.trim() : "";
        const id = typeof args.id === "string" ? args.id.trim() : "";
        const articleId = id || (url ? parseArticleIdFromUrl(url) : undefined);
        if (!articleId && !url) {
          return errorResult("VALIDATION_ERROR", "url or id is required");
        }
        const targetUrl =
          url && url.includes("/compose/articles/edit/")
            ? url
            : articleId
              ? `https://x.com/compose/articles/edit/${articleId}`
              : url;
        if (!targetUrl) {
          return errorResult("VALIDATION_ERROR", "url or id is required");
        }
        return await publishExistingArticle(page, targetUrl, articlePublishTimeoutMs);
      }

      if (name === "article.setCoverImage") {
        const authCheck = await requireAuthenticated(page);
        if (!authCheck.ok) {
          return authCheck.result;
        }
        const url = typeof args.url === "string" ? args.url.trim() : "";
        const id = typeof args.id === "string" ? args.id.trim() : "";
        const articleId = id || (url ? parseArticleIdFromUrl(url) : undefined);
        if (!articleId && !url) {
          return errorResult("VALIDATION_ERROR", "url or id is required");
        }
        const coverImagePath = typeof args.coverImagePath === "string" ? args.coverImagePath.trim() : "";
        if (!coverImagePath) {
          return errorResult("VALIDATION_ERROR", "coverImagePath is required");
        }
        const targetUrl =
          url && url.includes("/compose/articles/edit/")
            ? url
            : articleId
              ? `https://x.com/compose/articles/edit/${articleId}`
              : url;
        if (!targetUrl) {
          return errorResult("VALIDATION_ERROR", "url or id is required");
        }
        return await setArticleCoverImage(page, targetUrl, coverImagePath);
      }

      if (name === "article.updateMarkdown") {
        const authCheck = await requireAuthenticated(page);
        if (!authCheck.ok) {
          return authCheck.result;
        }
        const url = typeof args.url === "string" ? args.url.trim() : "";
        const id = typeof args.id === "string" ? args.id.trim() : "";
        const articleId = id || (url ? parseArticleIdFromUrl(url) : undefined);
        if (!articleId && !url) {
          return errorResult("VALIDATION_ERROR", "url or id is required");
        }
        const markdownPath = typeof args.markdownPath === "string" ? args.markdownPath.trim() : "";
        if (!markdownPath) {
          return errorResult("VALIDATION_ERROR", "markdownPath is required");
        }
        const explicitTitle = typeof args.title === "string" ? args.title.trim() : "";
        const targetUrl =
          url && url.includes("/compose/articles/edit/")
            ? url
            : articleId
              ? `https://x.com/compose/articles/edit/${articleId}`
              : url;
        if (!targetUrl) {
          return errorResult("VALIDATION_ERROR", "url or id is required");
        }
        return await updateArticleMarkdown(page, targetUrl, markdownPath, explicitTitle || undefined);
      }

      if (name === "article.delete") {
        const authCheck = await requireAuthenticated(page);
        if (!authCheck.ok) {
          return authCheck.result;
        }

        const url = typeof args.url === "string" ? args.url.trim() : "";
        const id = typeof args.id === "string" ? args.id.trim() : "";
        const dryRun = args.dryRun === true;
        const articleId = id || (url ? parseArticleIdFromUrl(url) : undefined);
        if (!articleId && !url) {
          return errorResult("VALIDATION_ERROR", "url or id is required");
        }
        const targetUrl =
          url && url.includes("/compose/articles/edit/")
            ? url
            : articleId
              ? `https://x.com/compose/articles/edit/${articleId}`
              : url;
        if (!targetUrl) {
          return errorResult("VALIDATION_ERROR", "url or id is required");
        }
        const cachedPage = articleId ? getCachedArticleDraftPage(page, articleId) : undefined;
        if (cachedPage) {
          const result = await deleteArticleEditor(cachedPage, dryRun);
          if (!dryRun && articleId && (!result || typeof result !== "object" || Array.isArray(result) || !("error" in result))) {
            await removeCachedArticleDraftPage(page, articleId);
          }
          return result;
        }
        return await withEphemeralPage(page, targetUrl, async (articlePage) => {
          await waitForArticleEditorSurface(articlePage);
          return await deleteArticleEditor(articlePage, dryRun);
        });
      }

      return errorResult("TOOL_NOT_FOUND", `unknown tool: ${name}`);
    },
    stop: async ({ page }) => {
      await closeCachedReadPages(page);
      await closeCachedArticleDraftPages(page);
    },
  };
}
