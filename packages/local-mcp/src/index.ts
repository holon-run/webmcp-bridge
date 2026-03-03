/**
 * This module exposes the local-mcp package public API.
 * It depends on server/client/type modules for Unix-socket MCP host and consumer integrations.
 */

export * from "./server.js";
export * from "./client.js";
export * from "./event-buffer.js";
export * from "./mcp-types.js";
