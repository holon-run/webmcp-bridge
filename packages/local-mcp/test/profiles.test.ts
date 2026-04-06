/**
 * This module tests deterministic managed-profile path defaults for local-mcp sessions.
 * It depends on the profile helper so managed launches reuse stable directories across site and URL entrypoints.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE_ROOT, resolveDefaultUserDataDir } from "../src/profiles.js";

describe("resolveDefaultUserDataDir", () => {
  it("uses built-in site ids directly", () => {
    expect(
      resolveDefaultUserDataDir(
        {
          id: "x",
          source: "builtin",
          manifest: {
            id: "x.com",
            displayName: "X",
            version: "0.1.0",
            bridgeApiVersion: "1.0.0",
            hostPatterns: ["x.com"],
          },
        },
        "https://x.com/home",
      ),
    ).toBe(join(DEFAULT_PROFILE_ROOT, "x"));
  });

  it("slugifies external adapter ids", () => {
    expect(
      resolveDefaultUserDataDir(
        {
          id: "gemini.google.com",
          source: "external",
          manifest: {
            id: "gemini.google.com",
            displayName: "Google Gemini",
            version: "0.1.0",
            bridgeApiVersion: "1.0.0",
            hostPatterns: ["google.com"],
          },
        },
        "https://gemini.google.com/app",
      ),
    ).toBe(join(DEFAULT_PROFILE_ROOT, "gemini-google-com"));
  });

  it("uses target hostname for native URL mode", () => {
    expect(
      resolveDefaultUserDataDir(
        {
          id: "native:board.holon.run",
          source: "native",
          manifest: {
            id: "native:board.holon.run",
            displayName: "Board",
            version: "0.1.0",
            bridgeApiVersion: "1.0.0",
            hostPatterns: ["board.holon.run"],
          },
        },
        "https://board.holon.run",
      ),
    ).toBe(join(DEFAULT_PROFILE_ROOT, "board-holon-run"));
  });

  it("uses about-blank for about:blank native mode", () => {
    expect(
      resolveDefaultUserDataDir(
        {
          id: "native:about-blank",
          source: "native",
          manifest: {
            id: "native:about-blank",
            displayName: "Blank",
            version: "0.1.0",
            bridgeApiVersion: "1.0.0",
            hostPatterns: ["about:blank"],
          },
        },
        "about:blank",
      ),
    ).toBe(join(DEFAULT_PROFILE_ROOT, "about-blank"));
  });
});
