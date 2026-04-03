/**
 * This module defines browser engine/channel types shared by agent-browser-core session helpers.
 * It is depended on by session lifecycle primitives so browser launch metadata can stay transport-agnostic.
 */

export type BrowserEngine = "chromium" | "firefox" | "webkit";
export type BrowserChannel =
  | "chrome"
  | "chrome-beta"
  | "chrome-dev"
  | "chrome-canary"
  | "msedge"
  | "msedge-beta"
  | "msedge-dev"
  | "msedge-canary";
