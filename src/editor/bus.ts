// src/editor/bus.ts
// The editor's global event bus. Modules emit "project:changed" when the
// project state mutates, and the viewport subscribes to redraw.

import { EventBus } from "../shared/events";

export const bus = new EventBus();

/** Standard events. Add new ones here so subscribers have one place to look. */
export const EV = {
  PROJECT_CHANGED: "project:changed",
  SELECTION_CHANGED: "selection:changed",
  TOOL_CHANGED: "tool:changed",
  VIEWPORT_CHANGED: "viewport:changed",
  STATUS: "status", // arbitrary status text update
} as const;
