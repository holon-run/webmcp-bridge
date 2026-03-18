/**
 * This module provides generic DOM filtering helpers for adapter extraction paths.
 * It avoids site-specific selectors and keeps only mechanical browser-side checks reusable across adapters.
 */

import { normalizeText } from "./text.js";

export function isInteractiveElement(element: Element): boolean {
  return element.matches("button, a, textarea, input, select, option, nav");
}

export function collectReadableNodeTexts(root: ParentNode, selector = "div, span, p"): string[] {
  const output: string[] = [];
  for (const node of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
    if (node.closest("button, a, textarea, input, select, nav")) {
      continue;
    }
    const text = normalizeText(node.innerText || node.textContent || "");
    if (!text) {
      continue;
    }
    const childWithSameText = Array.from(node.children).some((child) => {
      return child instanceof HTMLElement && normalizeText(child.innerText || child.textContent || "") === text;
    });
    if (childWithSameText) {
      continue;
    }
    if (output[output.length - 1] !== text) {
      output.push(text);
    }
  }
  return output;
}
