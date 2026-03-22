/**
 * This module owns auth-policy normalization, managed profile metadata, and non-Playwright browser bootstrap helpers.
 * It depends on adapter manifest types and Node process/filesystem APIs so local-mcp can orchestrate auth-sensitive sessions without introducing a daemon.
 */

import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import type { AdapterManifest } from "@webmcp-bridge/playwright";
import type { BrowserChannel, BrowserEngine } from "./runtime.js";

export type BridgeAuthState = "unknown" | "authenticated" | "auth_required" | "challenge_required";
export type BridgeSessionOwnership = "none" | "managed" | "external";
export type BridgeSessionState =
  | "profile_missing"
  | "profile_present_unverified"
  | "bootstrap_active"
  | "auth_required"
  | "challenge_required"
  | "authenticated"
  | "runtime_active";
export type BridgeControlMode = "none" | "bootstrap" | "launch" | "attach";
export type AuthPolicyMode = "none" | "bootstrap_then_attach";

export type ResolvedAuthPolicy = {
  mode: AuthPolicyMode;
  authProbeTool?: string;
  allowAnonymousTools: boolean;
};

export type SessionMetadata = {
  version: 1;
  site: string;
  profilePath: string;
  targetUrl: string;
  authPolicyMode: AuthPolicyMode;
  authProbeTool?: string;
  allowAnonymousTools: boolean;
  sessionState: BridgeSessionState;
  authState: BridgeAuthState;
  controlMode: BridgeControlMode;
  ownership: BridgeSessionOwnership;
  browserUrl?: string;
  browserPid?: number;
  lastBackupPath?: string;
  updatedAt: string;
};

export type SessionMetadataPatch = Omit<Partial<SessionMetadata>, "browserUrl" | "browserPid" | "lastBackupPath"> & {
  browserUrl?: string | null;
  browserPid?: number | null;
  lastBackupPath?: string | null;
};

export type BootstrapBrowserOptions = {
  targetUrl: string;
  userDataDir: string;
  browserChannel?: BrowserChannel;
};

export type ManagedAttachBrowserOptions = BootstrapBrowserOptions;

const SESSION_METADATA_VERSION = 1;
const SESSION_METADATA_PATH = ".webmcp-bridge/session.json";
const CDP_READY_TIMEOUT_MS = 10_000;
const CDP_READY_POLL_INTERVAL_MS = 250;
const PROCESS_EXIT_TIMEOUT_MS = 5_000;
const PROCESS_EXIT_POLL_INTERVAL_MS = 100;

function timestamp(): string {
  return new Date().toISOString();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function getSessionMetadataPath(userDataDir: string): string {
  return join(userDataDir, SESSION_METADATA_PATH);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBridgeAuthState(value: unknown): value is BridgeAuthState {
  return (
    value === "unknown" ||
    value === "authenticated" ||
    value === "auth_required" ||
    value === "challenge_required"
  );
}

function isBridgeSessionState(value: unknown): value is BridgeSessionState {
  return (
    value === "profile_missing" ||
    value === "profile_present_unverified" ||
    value === "bootstrap_active" ||
    value === "auth_required" ||
    value === "challenge_required" ||
    value === "authenticated" ||
    value === "runtime_active"
  );
}

function isBridgeControlMode(value: unknown): value is BridgeControlMode {
  return value === "none" || value === "bootstrap" || value === "launch" || value === "attach";
}

function isBridgeSessionOwnership(value: unknown): value is BridgeSessionOwnership {
  return value === "none" || value === "managed" || value === "external";
}

function normalizeMetadata(
  value: unknown,
  fallback: {
    site: string;
    profilePath: string;
    targetUrl: string;
    authPolicy: ResolvedAuthPolicy;
    profileExists: boolean;
  },
): SessionMetadata {
  const base: SessionMetadata = {
    version: SESSION_METADATA_VERSION,
    site: fallback.site,
    profilePath: fallback.profilePath,
    targetUrl: fallback.targetUrl,
    authPolicyMode: fallback.authPolicy.mode,
    ...(fallback.authPolicy.authProbeTool !== undefined ? { authProbeTool: fallback.authPolicy.authProbeTool } : {}),
    allowAnonymousTools: fallback.authPolicy.allowAnonymousTools,
    sessionState: fallback.profileExists ? "profile_present_unverified" : "profile_missing",
    authState: "unknown",
    controlMode: "none",
    ownership: "none",
    updatedAt: timestamp(),
  };

  if (!isRecord(value)) {
    return base;
  }
  const metadata = { ...base };
  if (typeof value.site === "string" && value.site.trim()) {
    metadata.site = value.site;
  }
  if (typeof value.profilePath === "string" && value.profilePath.trim()) {
    metadata.profilePath = value.profilePath;
  }
  if (typeof value.targetUrl === "string" && value.targetUrl.trim()) {
    metadata.targetUrl = value.targetUrl;
  }
  if (value.authPolicyMode === "none" || value.authPolicyMode === "bootstrap_then_attach") {
    metadata.authPolicyMode = value.authPolicyMode;
  }
  if (typeof value.authProbeTool === "string" && value.authProbeTool.trim()) {
    metadata.authProbeTool = value.authProbeTool;
  }
  if (typeof value.allowAnonymousTools === "boolean") {
    metadata.allowAnonymousTools = value.allowAnonymousTools;
  }
  if (isBridgeSessionState(value.sessionState)) {
    metadata.sessionState = value.sessionState;
  }
  if (isBridgeAuthState(value.authState)) {
    metadata.authState = value.authState;
  }
  if (isBridgeControlMode(value.controlMode)) {
    metadata.controlMode = value.controlMode;
  }
  if (isBridgeSessionOwnership(value.ownership)) {
    metadata.ownership = value.ownership;
  }
  if (typeof value.browserUrl === "string" && value.browserUrl.trim()) {
    metadata.browserUrl = value.browserUrl;
  }
  if (typeof value.browserPid === "number" && Number.isInteger(value.browserPid) && value.browserPid > 0) {
    metadata.browserPid = value.browserPid;
  }
  if (typeof value.lastBackupPath === "string" && value.lastBackupPath.trim()) {
    metadata.lastBackupPath = value.lastBackupPath;
  }
  if (typeof value.updatedAt === "string" && value.updatedAt.trim()) {
    metadata.updatedAt = value.updatedAt;
  }
  return metadata;
}

export function resolveAuthPolicy(manifest: AdapterManifest): ResolvedAuthPolicy {
  const declared = manifest.authPolicy;
  if (declared) {
    return {
      mode: declared.mode,
      ...(declared.authProbeTool !== undefined ? { authProbeTool: declared.authProbeTool } : {}),
      allowAnonymousTools: declared.allowAnonymousTools ?? false,
    };
  }
  const mode: AuthPolicyMode =
    manifest.deferBridgeUntilAuthenticated === true ? "bootstrap_then_attach" : "none";
  return {
    mode,
    ...(manifest.authProbeTool !== undefined ? { authProbeTool: manifest.authProbeTool } : {}),
    allowAnonymousTools: manifest.deferBridgeUntilAuthenticated === true,
  };
}

export async function ensureManagedProfile(userDataDir: string): Promise<void> {
  await mkdir(userDataDir, { recursive: true });
}

export async function readSessionMetadata(
  userDataDir: string,
  fallback: {
    site: string;
    targetUrl: string;
    authPolicy: ResolvedAuthPolicy;
  },
): Promise<SessionMetadata> {
  const profileExists = await pathExists(userDataDir);
  const metadataPath = getSessionMetadataPath(userDataDir);
  if (!(await pathExists(metadataPath))) {
    return normalizeMetadata(undefined, {
      site: fallback.site,
      profilePath: userDataDir,
      targetUrl: fallback.targetUrl,
      authPolicy: fallback.authPolicy,
      profileExists,
    });
  }

  try {
    const parsed = JSON.parse(await readFile(metadataPath, "utf8")) as unknown;
    return normalizeMetadata(parsed, {
      site: fallback.site,
      profilePath: userDataDir,
      targetUrl: fallback.targetUrl,
      authPolicy: fallback.authPolicy,
      profileExists,
    });
  } catch {
    return normalizeMetadata(undefined, {
      site: fallback.site,
      profilePath: userDataDir,
      targetUrl: fallback.targetUrl,
      authPolicy: fallback.authPolicy,
      profileExists,
    });
  }
}

export async function writeSessionMetadata(userDataDir: string, metadata: SessionMetadata): Promise<void> {
  const metadataPath = getSessionMetadataPath(userDataDir);
  await mkdir(dirname(metadataPath), { recursive: true });
  await writeFile(metadataPath, `${JSON.stringify({ ...metadata, version: SESSION_METADATA_VERSION }, null, 2)}\n`, "utf8");
}

export async function updateSessionMetadata(
  userDataDir: string,
  fallback: {
    site: string;
    targetUrl: string;
    authPolicy: ResolvedAuthPolicy;
  },
  patch: SessionMetadataPatch,
): Promise<SessionMetadata> {
  const current = await readSessionMetadata(userDataDir, fallback);
  const normalizedPatch = { ...patch } as Record<string, unknown>;
  if (normalizedPatch.browserUrl === null) {
    delete normalizedPatch.browserUrl;
  }
  if (normalizedPatch.browserPid === null) {
    delete normalizedPatch.browserPid;
  }
  if (normalizedPatch.lastBackupPath === null) {
    delete normalizedPatch.lastBackupPath;
  }
  const next: SessionMetadata = {
    ...current,
    ...(normalizedPatch as Partial<SessionMetadata>),
    updatedAt: timestamp(),
  };
  if ("browserUrl" in patch && patch.browserUrl === null) {
    delete next.browserUrl;
  }
  if ("browserPid" in patch && patch.browserPid === null) {
    delete next.browserPid;
  }
  if ("lastBackupPath" in patch && patch.lastBackupPath === null) {
    delete next.lastBackupPath;
  }
  await writeSessionMetadata(userDataDir, next);
  return next;
}

export async function backupAndResetProfile(
  userDataDir: string,
  fallback: {
    site: string;
    targetUrl: string;
    authPolicy: ResolvedAuthPolicy;
  },
): Promise<{ metadata: SessionMetadata; backupPath?: string }> {
  let backupPath: string | undefined;
  if (await pathExists(userDataDir)) {
    const profileStat = await stat(userDataDir).catch(() => undefined);
    if (profileStat?.isDirectory()) {
      backupPath = `${userDataDir}-backup-${timestamp().replace(/[:.]/g, "-")}`;
      await rename(userDataDir, backupPath);
    } else {
      await rm(userDataDir, { force: true, recursive: true });
    }
  }
  await mkdir(userDataDir, { recursive: true });
  const resetPatch: SessionMetadataPatch = {
    sessionState: "profile_missing",
    authState: "unknown",
    controlMode: "none",
    ownership: "none",
    browserUrl: null,
    browserPid: null,
  };
  if (backupPath !== undefined) {
    resetPatch.lastBackupPath = backupPath;
  }
  const metadata = await updateSessionMetadata(userDataDir, fallback, resetPatch);
  return { metadata, ...(backupPath !== undefined ? { backupPath } : {}) };
}

function getChromiumCandidates(channel: BrowserChannel | undefined): string[] {
  if (process.env.WEBMCP_CHROMIUM_EXECUTABLE) {
    return [process.env.WEBMCP_CHROMIUM_EXECUTABLE];
  }
  const normalizedChannel = channel ?? "chrome";
  if (process.platform === "darwin") {
    const appNames: Record<BrowserChannel, string> = {
      chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "chrome-beta": "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
      "chrome-dev": "/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev",
      "chrome-canary": "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      msedge: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "msedge-beta": "/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta",
      "msedge-dev": "/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev",
      "msedge-canary": "/Applications/Microsoft Edge Canary.app/Contents/MacOS/Microsoft Edge Canary",
    };
    const fallback = [appNames.chrome, "/Applications/Chromium.app/Contents/MacOS/Chromium"];
    return [appNames[normalizedChannel], ...fallback].filter(Boolean);
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const programFiles = process.env.PROGRAMFILES ?? "C:\\Program Files";
    const programFilesX86 = process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
    const candidates: Record<BrowserChannel, string[]> = {
      chrome: [
        `${programFiles}\\Google\\Chrome\\Application\\chrome.exe`,
        `${programFilesX86}\\Google\\Chrome\\Application\\chrome.exe`,
        `${localAppData}\\Google\\Chrome\\Application\\chrome.exe`,
      ],
      "chrome-beta": [
        `${programFiles}\\Google\\Chrome Beta\\Application\\chrome.exe`,
        `${programFilesX86}\\Google\\Chrome Beta\\Application\\chrome.exe`,
        `${localAppData}\\Google\\Chrome Beta\\Application\\chrome.exe`,
      ],
      "chrome-dev": [`${localAppData}\\Google\\Chrome Dev\\Application\\chrome.exe`],
      "chrome-canary": [`${localAppData}\\Google\\Chrome SxS\\Application\\chrome.exe`],
      msedge: [
        `${programFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
        `${programFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe`,
      ],
      "msedge-beta": [
        `${programFiles}\\Microsoft\\Edge Beta\\Application\\msedge.exe`,
        `${programFilesX86}\\Microsoft\\Edge Beta\\Application\\msedge.exe`,
      ],
      "msedge-dev": [
        `${programFiles}\\Microsoft\\Edge Dev\\Application\\msedge.exe`,
        `${programFilesX86}\\Microsoft\\Edge Dev\\Application\\msedge.exe`,
      ],
      "msedge-canary": [`${localAppData}\\Microsoft\\Edge SxS\\Application\\msedge.exe`],
    };
    return candidates[normalizedChannel];
  }
  const commands: Record<BrowserChannel, string[]> = {
    chrome: ["google-chrome", "google-chrome-stable", "chromium-browser", "chromium"],
    "chrome-beta": ["google-chrome-beta"],
    "chrome-dev": ["google-chrome-unstable"],
    "chrome-canary": ["google-chrome-canary"],
    msedge: ["microsoft-edge", "microsoft-edge-stable"],
    "msedge-beta": ["microsoft-edge-beta"],
    "msedge-dev": ["microsoft-edge-dev"],
    "msedge-canary": ["microsoft-edge-canary"],
  };
  return commands[normalizedChannel];
}

async function resolveChromiumExecutable(channel: BrowserChannel | undefined): Promise<string> {
  const candidates = getChromiumCandidates(channel);
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (candidate.includes("/") || candidate.includes("\\") || candidate.endsWith(".exe")) {
      if (await pathExists(candidate)) {
        return candidate;
      }
      continue;
    }
    return candidate;
  }
  throw new Error(
    "BROWSER_NOT_FOUND: unable to locate a Chromium browser for bootstrap/attach. Set WEBMCP_CHROMIUM_EXECUTABLE or install a supported browser channel.",
  );
}

function getChromiumAppName(channel: BrowserChannel | undefined): string | undefined {
  const normalizedChannel = channel ?? "chrome";
  if (process.platform !== "darwin") {
    return undefined;
  }
  const appNames: Record<BrowserChannel, string> = {
    chrome: "Google Chrome",
    "chrome-beta": "Google Chrome Beta",
    "chrome-dev": "Google Chrome Dev",
    "chrome-canary": "Google Chrome Canary",
    msedge: "Microsoft Edge",
    "msedge-beta": "Microsoft Edge Beta",
    "msedge-dev": "Microsoft Edge Dev",
    "msedge-canary": "Microsoft Edge Canary",
  };
  return appNames[normalizedChannel];
}

function buildBootstrapArgs(options: BootstrapBrowserOptions): string[] {
  return [
    `--user-data-dir=${options.userDataDir}`,
    "--disable-extensions",
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    options.targetUrl,
  ];
}

async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => {
          reject(new Error("PORT_RESERVATION_FAILED: unable to allocate a debugging port"));
        });
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForCdp(browserUrl: string, timeoutMs = CDP_READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${browserUrl}/json/version`);
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until timeout while the browser starts.
    }
    await new Promise((resolve) => setTimeout(resolve, CDP_READY_POLL_INTERVAL_MS));
  }
  throw new Error(`BROWSER_ATTACH_TIMEOUT: timed out waiting for remote debugging at ${browserUrl}`);
}

type BrowserProcessEntry = {
  pid: number;
  command: string;
};

async function listBrowserProcesses(): Promise<BrowserProcessEntry[]> {
  if (process.platform === "win32") {
    return [];
  }
  return await new Promise<BrowserProcessEntry[]>((resolve) => {
    let stdout = "";
    const child = spawn("ps", ["-ax", "-o", "pid=,command="], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.once("error", () => resolve([]));
    child.once("close", () => {
      const entries = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const match = line.match(/^(\d+)\s+(.*)$/);
          if (!match) {
            return undefined;
          }
          return {
            pid: Number.parseInt(match[1] ?? "", 10),
            command: match[2] ?? "",
          };
        })
        .filter((entry): entry is BrowserProcessEntry => entry !== undefined && Number.isInteger(entry.pid));
      resolve(entries);
    });
  });
}

function isRootBrowserProcessForProfile(command: string, userDataDir: string): boolean {
  return command.includes(`--user-data-dir=${userDataDir}`) && !command.includes("--type=");
}

function spawnDetachedBrowser(executable: string, args: string[]): number | undefined {
  const child = spawn(executable, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid ?? undefined;
}

async function waitForProcessExitInternal(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isProcessRunning(pid))) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, PROCESS_EXIT_POLL_INTERVAL_MS));
  }
  return !(await isProcessRunning(pid));
}

async function waitForBrowserProcessForProfile(
  userDataDir: string,
  timeoutMs: number,
): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = await listBrowserProcesses();
    const match = entries
      .filter((entry) => isRootBrowserProcessForProfile(entry.command, userDataDir))
      .sort((left, right) => right.pid - left.pid)[0];
    if (match) {
      return match.pid;
    }
    await new Promise((resolve) => setTimeout(resolve, CDP_READY_POLL_INTERVAL_MS));
  }
  return undefined;
}

export async function launchBootstrapBrowser(options: BootstrapBrowserOptions): Promise<{ pid?: number }> {
  const executable = await resolveChromiumExecutable(options.browserChannel);
  const pid = spawnDetachedBrowser(executable, buildBootstrapArgs(options));
  const trackedPid = (await waitForBrowserProcessForProfile(options.userDataDir, CDP_READY_TIMEOUT_MS)) ?? pid;
  return { ...(trackedPid !== undefined ? { pid: trackedPid } : {}) };
}

export async function launchManagedAttachBrowser(
  options: ManagedAttachBrowserOptions,
): Promise<{ browserUrl: string; pid?: number }> {
  const executable = await resolveChromiumExecutable(options.browserChannel);
  const port = await reservePort();
  const browserUrl = `http://127.0.0.1:${port}`;
  const pid = spawnDetachedBrowser(executable, [
    `--user-data-dir=${options.userDataDir}`,
    "--disable-extensions",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${port}`,
    "--new-window",
    options.targetUrl,
  ]);
  await waitForCdp(browserUrl);
  const trackedPid = (await waitForBrowserProcessForProfile(options.userDataDir, CDP_READY_TIMEOUT_MS)) ?? pid;
  return {
    browserUrl,
    ...(trackedPid !== undefined ? { pid: trackedPid } : {}),
  };
}

export async function isProcessRunning(pid: number | undefined): Promise<boolean> {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function stopBrowserProcess(pid: number | undefined): Promise<void> {
  if (!(await isProcessRunning(pid))) {
    return;
  }
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
      });
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    return;
  }
  try {
    process.kill(-(pid as number), "SIGTERM");
  } catch {
    try {
      process.kill(pid as number, "SIGTERM");
    } catch {
      // Ignore missing/stale processes during cleanup.
    }
  }
}

export async function waitForProcessExit(pid: number | undefined, timeoutMs = PROCESS_EXIT_TIMEOUT_MS): Promise<boolean> {
  if (!pid) {
    return true;
  }
  return await waitForProcessExitInternal(pid, timeoutMs);
}

export async function focusBrowserWindow(browserChannel: BrowserChannel | undefined): Promise<boolean> {
  const appName = getChromiumAppName(browserChannel);
  if (!appName) {
    return false;
  }
  return await new Promise<boolean>((resolve) => {
    const child = spawn("open", ["-a", appName], {
      stdio: "ignore",
    });
    child.once("exit", (code) => resolve(code === 0));
    child.once("error", () => resolve(false));
  });
}

export async function findBrowserProcessForProfile(userDataDir: string): Promise<number | undefined> {
  const entries = await listBrowserProcesses();
  return entries
    .filter((entry) => isRootBrowserProcessForProfile(entry.command, userDataDir))
    .sort((left, right) => right.pid - left.pid)[0]?.pid;
}

export async function stopManagedBrowser(metadata: SessionMetadata): Promise<void> {
  if (metadata.ownership !== "managed" || !(await isProcessRunning(metadata.browserPid))) {
    return;
  }
  await stopBrowserProcess(metadata.browserPid);
}

export function assertAuthSensitiveBrowserSupport(
  browser: BrowserEngine | undefined,
  userDataDir: string | undefined,
): void {
  const browserEngine = browser ?? "chromium";
  if (browserEngine !== "chromium") {
    throw new Error(
      `CONFIG_ERROR: auth-sensitive bootstrap/attach sessions require --browser chromium (received ${browserEngine})`,
    );
  }
  if (!userDataDir) {
    throw new Error("CONFIG_ERROR: auth-sensitive bootstrap/attach sessions require --user-data-dir");
  }
}

export function describeSessionStateFromAuth(authState: BridgeAuthState): BridgeSessionState {
  if (authState === "authenticated") {
    return "authenticated";
  }
  if (authState === "challenge_required") {
    return "challenge_required";
  }
  if (authState === "auth_required") {
    return "auth_required";
  }
  return "profile_present_unverified";
}
