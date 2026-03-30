/**
 * This module tests auth-policy normalization and managed profile metadata helpers.
 * It depends on the session control module so lifecycle metadata remains stable across bootstrap and reset flows.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  backupAndResetProfile,
  readSessionMetadata,
  resolveAuthPolicy,
  stopBrowserProcess,
  updateSessionMetadata,
  waitForProcessExit,
} from "../src/session.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function createTempProfileDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "local-mcp-session-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("resolveAuthPolicy", () => {
  it("uses the explicit authPolicy when present", () => {
    expect(
      resolveAuthPolicy({
        id: "google",
        displayName: "Google",
        version: "0.1.0",
        bridgeApiVersion: "1.0.0",
        hostPatterns: ["google.com"],
        authPolicy: {
          mode: "bootstrap_then_attach",
          authProbeTool: "auth.get",
          allowAnonymousTools: true,
        },
      }),
    ).toEqual({
      mode: "bootstrap_then_attach",
      authProbeTool: "auth.get",
      allowAnonymousTools: true,
    });
  });

  it("maps legacy authProbeTool/deferBridgeUntilAuthenticated fields", () => {
    expect(
      resolveAuthPolicy({
        id: "legacy",
        displayName: "Legacy",
        version: "0.1.0",
        bridgeApiVersion: "1.0.0",
        hostPatterns: ["legacy.test"],
        authProbeTool: "auth.get",
        deferBridgeUntilAuthenticated: true,
      }),
    ).toEqual({
      mode: "bootstrap_then_attach",
      authProbeTool: "auth.get",
      allowAnonymousTools: true,
    });
  });
});

describe("session metadata helpers", () => {
  it("clears optional fields when updateSessionMetadata receives null sentinels", async () => {
    const profileDir = await createTempProfileDir();
    const fallback = {
      site: "google",
      targetUrl: "https://gemini.google.com/",
      authPolicy: {
        mode: "bootstrap_then_attach",
        authProbeTool: "auth.get",
        allowAnonymousTools: true,
      } as const,
    };

    await updateSessionMetadata(profileDir, fallback, {
      sessionState: "runtime_active",
      authState: "authenticated",
      controlMode: "attach",
      ownership: "managed",
      browserUrl: "http://127.0.0.1:9222",
      browserPid: 1234,
    });

    const updated = await updateSessionMetadata(profileDir, fallback, {
      controlMode: "bootstrap",
      ownership: "external",
      browserUrl: null,
      browserPid: null,
    });

    expect(updated.browserUrl).toBeUndefined();
    expect(updated.browserPid).toBeUndefined();
    expect(updated.controlMode).toBe("bootstrap");
  });

  it("backs up and recreates a profile directory", async () => {
    const profileDir = await createTempProfileDir();
    await writeFile(join(profileDir, "marker.txt"), "marker", "utf8");
    const fallback = {
      site: "google",
      targetUrl: "https://gemini.google.com/",
      authPolicy: {
        mode: "bootstrap_then_attach",
        authProbeTool: "auth.get",
        allowAnonymousTools: true,
      } as const,
    };

    const result = await backupAndResetProfile(profileDir, fallback);
    const markerPath = join(result.backupPath as string, "marker.txt");

    expect(result.backupPath).toBeDefined();
    expect(await readFile(markerPath, "utf8")).toBe("marker");
    const metadata = await readSessionMetadata(profileDir, fallback);
    expect(metadata.sessionState).toBe("profile_missing");
    expect(metadata.lastBackupPath).toBe(result.backupPath);
  });

  it("escalates to a forced kill when a browser process ignores SIGTERM", async () => {
    if (process.platform === "win32") {
      return;
    }

    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
      ],
      {
        stdio: "ignore",
      },
    );

    try {
      expect(child.pid).toBeDefined();
      await stopBrowserProcess(child.pid);
      await expect(waitForProcessExit(child.pid, 100)).resolves.toBe(true);
      expect(() => process.kill(child.pid as number, 0)).toThrow();
    } finally {
      if (child.pid) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // Ignore already-exited processes during test cleanup.
        }
        await waitForProcessExit(child.pid, 1000).catch(() => {
          // Ignore cleanup failures so the original assertion error is preserved.
        });
      }
    }
  });
});
