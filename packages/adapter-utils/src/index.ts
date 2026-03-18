/**
 * This module exports shared low-level utilities for fallback adapters.
 * It groups stream, text, and DOM helpers while keeping site-specific behavior in adapter packages.
 */

export * from "./dom.js";
export * from "./network.js";
export * from "./playwright.js";
export * from "./stream.js";
export * from "./text.js";
