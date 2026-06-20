// src/shared/dom.ts
// Tiny DOM-related helpers shared across the editor and runtime.

/** HTML-escape a string for safe interpolation into innerHTML. Handles
 *  the standard SGML-special characters; both the editor's panel
 *  rendering and the timeline's row labels go through this. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
