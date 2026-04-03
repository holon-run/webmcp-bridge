/**
 * This module re-exports browser session primitives from agent-browser-core for local-mcp.
 * It depends on agent-browser-core so local-mcp can keep its existing import surface while shedding lifecycle ownership.
 */

export * from "@webmcp-bridge/agent-browser-core";
