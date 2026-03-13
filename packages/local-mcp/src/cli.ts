#!/usr/bin/env node
/**
 * This module implements the local-mcp CLI entrypoint for one-site stdio MCP proxy sessions.
 * It depends on bridge startup APIs so command-line usage reuses the same runtime/server lifecycle.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startLocalMcpBridge } from "./bridge.js";
import { resolveSiteDefinition, type BuiltinSite } from "./sites.js";
import type { BrowserEngine } from "./runtime.js";

const USAGE = `Usage:
  webmcp-local-mcp [--site <site> | --adapter-module <specifier>] [options]

Source:
  --site <site>                Built-in site id (currently: x, fixture)
  --adapter-module <specifier> External adapter module (npm package, file path, or file:// URL)
  If neither source is provided, --url runs in native/polyfill mode without adapter fallback.

Optional:
  --url <url>                  Target URL (required when no source is set; otherwise overrides adapter default URL)
  --browser <name>             chromium | firefox | webkit (default: chromium)
  --headless                   Run browser in headless mode (default: false)
  --no-headless                Force headed mode
  --auto-login-fallback        Auto-switch to headed mode when auth is required in headless mode (default: true)
  --no-auto-login-fallback     Disable auto-switch login fallback
  --user-data-dir <path>       Playwright persistent profile directory
  --service-version <value>    MCP server version string (default: 0.1.0)
  --help                       Show this help message
`;

export type LocalMcpCliOptions = {
  site?: BuiltinSite;
  adapterModule?: string;
  url?: string;
  browser: BrowserEngine;
  headless: boolean;
  autoLoginFallback: boolean;
  userDataDir?: string;
  serviceVersion: string;
};

function parseFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`missing value for ${flag}`);
  }
  return value;
}

export function parseCliArgs(args: string[]): LocalMcpCliOptions {
  let site: BuiltinSite | undefined;
  let adapterModule: string | undefined;
  let url: string | undefined;
  let browser: BrowserEngine = "chromium";
  let headless = false;
  let autoLoginFallback = true;
  let userDataDir: string | undefined;
  let serviceVersion = "0.1.0";

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === "--site") {
      const value = parseFlagValue(args, i, "--site");
      site = resolveSiteDefinition(value).id as BuiltinSite;
      i += 1;
      continue;
    }

    if (arg === "--adapter-module") {
      adapterModule = parseFlagValue(args, i, "--adapter-module");
      i += 1;
      continue;
    }

    if (arg === "--url") {
      url = parseFlagValue(args, i, "--url");
      i += 1;
      continue;
    }

    if (arg === "--browser") {
      const value = parseFlagValue(args, i, "--browser");
      if (value !== "chromium" && value !== "firefox" && value !== "webkit") {
        throw new Error(`unsupported browser: ${value}`);
      }
      browser = value;
      i += 1;
      continue;
    }

    if (arg === "--headless") {
      headless = true;
      continue;
    }

    if (arg === "--no-headless") {
      headless = false;
      continue;
    }

    if (arg === "--user-data-dir") {
      userDataDir = parseFlagValue(args, i, "--user-data-dir");
      i += 1;
      continue;
    }

    if (arg === "--auto-login-fallback") {
      autoLoginFallback = true;
      continue;
    }

    if (arg === "--no-auto-login-fallback") {
      autoLoginFallback = false;
      continue;
    }

    if (arg === "--service-version") {
      serviceVersion = parseFlagValue(args, i, "--service-version");
      i += 1;
      continue;
    }

    throw new Error(`unknown argument: ${arg}`);
  }

  if (site && adapterModule) {
    throw new Error("use either --site or --adapter-module, not both");
  }

  if (!site && !adapterModule && !url) {
    throw new Error("missing required --url or one of --site/--adapter-module");
  }

  const options: LocalMcpCliOptions = {
    browser,
    headless,
    autoLoginFallback,
    serviceVersion,
  };

  if (site !== undefined) {
    options.site = site;
  }
  if (adapterModule !== undefined) {
    options.adapterModule = adapterModule;
  }
  if (url !== undefined) {
    options.url = url;
  }
  if (userDataDir !== undefined) {
    options.userDataDir = userDataDir;
  }

  return options;
}

function resolveCanonicalPath(pathValue: string): string {
  const absolutePath = resolve(pathValue);
  try {
    return realpathSync(absolutePath);
  } catch {
    return absolutePath;
  }
}

export function isMainModule(metaUrl: string, mainPath = process.argv[1]): boolean {
  if (!mainPath) {
    return false;
  }
  const canonicalMainPath = resolveCanonicalPath(mainPath);
  const canonicalModulePath = resolveCanonicalPath(fileURLToPath(metaUrl));
  return canonicalMainPath === canonicalModulePath;
}

export async function runCli(args = process.argv.slice(2)): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }

  let options: LocalMcpCliOptions;
  try {
    options = parseCliArgs(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n\n${USAGE}`);
    return 1;
  }

  let handle;
  try {
    handle = await startLocalMcpBridge({
      ...options,
      moduleBaseDir: process.cwd(),
      onError: (error) => {
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        process.stderr.write(`${message}\n`);
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 1;
  }

  process.stderr.write(
    `[local-mcp] site=${handle.site} mode=${handle.mode} headless=${String(handle.headless)} url=${handle.targetUrl} transport=stdio\n`,
  );

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    await handle.close();
  };

  const signalHandler = (signal: NodeJS.Signals): void => {
    void shutdown()
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        process.stderr.write(`${message}\n`);
      })
      .finally(() => {
        process.exit(signal === "SIGTERM" ? 0 : 130);
      });
  };

  process.once("SIGINT", signalHandler);
  process.once("SIGTERM", signalHandler);
  return 0;
}

if (isMainModule(import.meta.url)) {
  void runCli().then((code) => {
    if (code !== 0) {
      process.exit(code);
    }
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
