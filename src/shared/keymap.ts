// src/shared/keymap.ts
// Keyboard shortcut registry. Centralised so the `?` help panel and the
// global keydown handler read from the same source. Mirrors Spine's
// conventions per FSD §9.1 / §14.2 #4.

export interface Shortcut {
  /** Stable id used by the help panel. */
  id: string;
  /** Human label. */
  label: string;
  /**
   * Key value. Either:
   *   - the literal `keydown.key` string (lower-cased), e.g. "v", "n", ".", " "
   *   - or a friendly alias for keys whose `key` is hard to write:
   *       "space" → " ", "delete" → "Delete"
   */
  key: string;
  /** Optional ctrl/cmd modifier. */
  mod?: boolean;
  /** Optional shift modifier. */
  shift?: boolean;
  /** Group for the help panel (Tools, View, File, Playback). */
  group: "Tools" | "View" | "File" | "Playback" | "Edit" | "Mode";
}

const KEY_ALIASES: Record<string, string> = {
  space: " ",
  delete: "Delete",
};

export const SHORTCUTS: Shortcut[] = [
  // Tools
  { id: "tool.select",   label: "Select / move tool",     key: "v", group: "Tools" },
  { id: "tool.bone",     label: "Bone tool",              key: "b", group: "Tools" },
  { id: "tool.rotate",   label: "Rotate bone (drag around head)", key: "r", group: "Tools" },
  { id: "tool.scale",    label: "Scale bone (drag away from head)", key: "q", group: "Tools" },
  // Hierarchy
  { id: "hierarchy.addChild", label: "Add child bone to selection", key: "n", group: "Tools" },
  // Mesh
  { id: "mesh.autoWeights", label: "Recompute auto-weights for all meshes", key: "w", shift: true, group: "Tools" },
  { id: "mesh.subdivide",   label: "Subdivide mesh on selected bone (1→4 triangles)", key: "u", shift: true, group: "Tools" },
  { id: "mesh.cut",         label: "Cut selected mesh along diagonal", key: "x", shift: true, group: "Tools" },
  { id: "ik.create",        label: "Create two-bone IK on selected child", key: "k", shift: true, group: "Tools" },
  // View
  { id: "view.reset",    label: "Frame all (reset view)", key: "f", group: "View" },
  { id: "view.frameSel", label: "Frame selection",        key: "f", shift: true, group: "View" },
  { id: "view.grid",     label: "Toggle grid",            key: "g", shift: true, group: "View" },
  // Mode (FR-RB-7 — P2.B)
  { id: "mode.edit",     label: "Edit mode (bind pose)",  key: "1", group: "Mode" },
  { id: "mode.pose",     label: "Pose mode (preview)",    key: "2", group: "Mode" },
  { id: "mode.animate",  label: "Animate mode (keyframe)",key: "3", group: "Mode" },
  // File
  { id: "file.new",      label: "New project",            key: "n", mod: true,  group: "File" },
  { id: "file.save",     label: "Save project",           key: "s", mod: true,  group: "File" },
  { id: "file.open",     label: "Open project",           key: "o", mod: true,  group: "File" },
  { id: "file.insert",   label: "Insert image attachment",key: "i", mod: true,  group: "File" },
  { id: "file.recent",   label: "Recent projects",        key: "r", mod: true,  shift: true, group: "File" },
  { id: "export.mp4",    label: "Export MP4 preview",      key: "p", mod: true,  shift: true, group: "File" },
  // Playback
  { id: "play.toggle",   label: "Play / pause",           key: "space", group: "Playback" },
  { id: "play.stop",     label: "Stop and rewind",        key: "s", group: "Playback" },
  { id: "play.key",      label: "Set keyframe at playhead (K)", key: "k", group: "Playback" },
  { id: "play.stepNext", label: "Step forward 1 frame",   key: ".", group: "Playback" },
  { id: "play.stepPrev", label: "Step back 1 frame",      key: ",", group: "Playback" },
  { id: "play.speedUp",  label: "Increase playback speed",key: ".", shift: true, group: "Playback" },
  { id: "play.speedDown",label: "Decrease playback speed",key: ",", shift: true, group: "Playback" },
  { id: "play.onion",    label: "Toggle onion skin",      key: "o", shift: true, group: "Playback" },
  // Edit
  { id: "edit.undo",     label: "Undo",                   key: "z", mod: true,  group: "Edit" },
  { id: "edit.redo",     label: "Redo",                   key: "z", mod: true, shift: true, group: "Edit" },
  { id: "edit.cut",      label: "Cut keyframe(s)",        key: "x", mod: true,  group: "Edit" },
  { id: "edit.copy",     label: "Copy keyframe(s)",       key: "c", mod: true,  group: "Edit" },
  { id: "edit.paste",    label: "Paste keyframe(s)",      key: "v", mod: true,  group: "Edit" },
  { id: "edit.duplicate",label: "Duplicate keyframe(s)",  key: "d", mod: true,  group: "Edit" },
  { id: "edit.delete",   label: "Delete selection",       key: "delete", group: "Edit" },
  { id: "attachment.insertSample", label: "Insert sample sprite", key: "i", group: "Edit" },
];

/** Returns true if a keyboard event matches the given shortcut. */
export function matches(ev: KeyboardEvent, sc: Shortcut): boolean {
  const want = (KEY_ALIASES[sc.key] ?? sc.key).toLowerCase();
  if (ev.key.toLowerCase() !== want) return false;
  if (!!sc.mod !== (ev.ctrlKey || ev.metaKey)) return false;
  if (!!sc.shift !== ev.shiftKey) return false;
  return true;
}
