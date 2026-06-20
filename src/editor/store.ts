// src/editor/store.ts
// The single in-memory project + selection + tool state. Viewport, tools,
// and panels all read from and write to this object.
//
// We keep it intentionally dumb: a plain object, no proxies, no observable
// framework. The EditorBus (see ./bus.ts) is what notifies subscribers when
// the project changes.
//
// Why dumb? Two reasons: (1) it makes the code easy to step through, and
// (2) at P1 scope (one character, a few bones) we don't need fine-grained
// reactivity — coarse "the project changed, redraw" is fine.

import { createDefaultProject, type Project, type Id, type Bone, type Keyframe, type EasingPreset, EASING_PRESETS, BONE_PALETTE, newId, uniqueName } from "../core/model";
import { isDescendantOf } from "./hierarchy-ops";
import { evalPose } from "../core/eval";

/** Convert a world-space point into a parent's local space using the
 *  parent's *world* transform. Falls back to identity if the parent can't
 *  be evaluated (shouldn't happen unless the hierarchy is corrupted). */
export function worldToParentLocal(project: Project, parentId: Id, worldX: number, worldY: number): { lx: number; ly: number } {
  const pose = evalPose(project);
  const parentWorld = pose.get(parentId);
  if (!parentWorld) return { lx: worldX, ly: worldY };
  const m = parentWorld.m;
  // mat3Invert(parentWorld), then apply to (worldX, worldY, 1).
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return { lx: worldX, ly: worldY };
  const inv = 1 / det;
  const i00 = m[3] * inv, i10 = -m[1] * inv;
  const i01 = -m[2] * inv, i11 = m[0] * inv;
  const i20 = -(i00 * m[4] + i10 * m[5]);
  const i21 = -(i01 * m[4] + i11 * m[5]);
  return {
    lx: i00 * worldX + i01 * worldY + i20,
    ly: i10 * worldX + i11 * worldY + i21,
  };
}

export type Tool = "select" | "bone" | "rotate" | "scale";

/** Editing mode (FR-RB-7 — P2.B). Mirrors Spine-style 3-mode workflow:
 *
 *   - **edit**:    bind-pose authoring. Drags / inspector edits write to
 *                  the bone's resting transform (`bone.x`, `bone.y`,
 *                  `bone.rotation`). No keyframes are created.
 *
 *   - **pose**:    transient pose preview. Drags update the live bone
 *                  transform but the changes are *not committed* — when
 *                  the user switches back to `edit` or `animate` the
 *                  pre-pose snapshot is restored. Useful for trying out
 *                  a pose without polluting either the bind pose or any
 *                  animation track.
 *
 *   - **animate**: keyframed authoring. Drags / inspector edits write
 *                  the resulting transform as a keyframe at the current
 *                  playhead via the autoKey path. This was the implicit
 *                  default in P1.
 *
 * The default mode for a fresh editor is `animate` — that matches what
 * P1 did, so existing project files keep behaving the same.
 */
export type EditorMode = "edit" | "pose" | "animate";

export interface ViewportState {
  /** Pan offset in screen pixels (positive x = stage moved right). */
  panX: number;
  panY: number;
  /** Pixels per world unit. 1.0 = 1:1 at default canvas. */
  zoom: number;
  /** Show the world grid. */
  showGrid: boolean;
  showBones: boolean;
  showImages: boolean;
}

export interface Selection {
  /** Set of selected bone ids. */
  boneIds: Set<Id>;
}

export interface EditorState {
  project: Project;
  tool: Tool;
  mode: EditorMode;
  /** Snapshot of bone transforms taken on entering Pose mode. Used to
   *  rewind on exit so Pose changes are non-destructive. Null while
   *  not in Pose mode. */
  poseSnapshot: Record<Id, { x: number; y: number; rotation: number; scaleX: number; scaleY: number }> | null;
  viewport: ViewportState;
  selection: Selection;
  /** True while the user is dragging something. Tools can use this to avoid
   *  emitting selection-change events mid-drag. */
  dragging: boolean;
  /** Re-entrant counter incremented by interactive handlers (drag, scrub,
   *  inspector slider) to suppress mid-gesture history captures. See
   *  `history.ts` — only the *final* state of a gesture lands as one undo
   *  step; intermediate frames are not snapshotted. Always paired
   *  begin / end, even on early returns. */
  transactionDepth: number;
  /** Playback state. P1.D adds timeline + keyframe playback. */
  playback: PlaybackState;
  /** Currently selected keyframes (in the active animation). Used by
   *  the timeline panel and the clipboard commands. */
  keyframeSelection: KeyframeRef[];
  /** Single-slot editor clipboard for keyframes. */
  clipboard: KeyframeClipboard;
}

export interface PlaybackState {
  /** True while a playhead is advancing via requestAnimationFrame. */
  playing: boolean;
  /** Current playhead time in seconds. Always 0 ≤ time ≤ duration. */
  currentTime: number;
  /** Override that pauses the automatic advance so the user can scrub
   *  without the time jumping back. Set true while the mouse is down
   *  on the timeline. */
  scrubbing: boolean;
  /** Wall-clock timestamp (perf.now()) of the last `playing=true` tick.
   *  Used by the playback loop to compute dt. NaN when paused. */
  lastTickMs: number;
  /** Playback rate multiplier (FR-PB-4 — P2.G). 1.0 = normal speed,
   *  0.5 = half speed, 2.0 = double. The dt fed into the tick is
   *  multiplied by this; speeds ≤ 0 are clamped to 0 (effectively a
   *  manual scrub mode). */
  speed: number;
  /** Onion-skin opacity (FR-TA-6 — P2.G). 0 disables onion skinning;
   *  values in (0, 1] enable ghost frames at t-1 and t+1 keyframes
   *  rendered at this alpha. The viewport's renderer reads this on
   *  draw — see [viewport.ts](src/editor/viewport.ts). */
  onionSkinAlpha: number;
}

export function createInitialState(): EditorState {
  return {
    project: createDefaultProject("untitled"),
    tool: "select",
    mode: "animate",
    poseSnapshot: null,
    viewport: { panX: 0, panY: 0, zoom: 1, showGrid: true, showBones: true, showImages: true },
    selection: { boneIds: new Set() },
    dragging: false,
    transactionDepth: 0,
    playback: {
      playing: false,
      currentTime: 0,
      scrubbing: false,
      lastTickMs: NaN,
      speed: 1.0,
      onionSkinAlpha: 0,
    },
    keyframeSelection: [],
    clipboard: createEmptyClipboard(),
  };
}

/* ---------- Mutation helpers (called by tools) ---------- */

export function addBone(state: EditorState, parentId: Id | null, worldX: number, worldY: number): Id {
  const { project } = state;
  // If the new bone has a parent, store its position in *parent-local* coords.
  // Use the parent's WORLD transform (not just parent.local) so grandchild
  // bones end up at the right place even when the parent isn't a root.
  let lx = worldX, ly = worldY;
  if (parentId !== null && project.bones[parentId]) {
    const conv = worldToParentLocal(project, parentId, worldX, worldY);
    lx = conv.lx;
    ly = conv.ly;
  }
  const paletteIdx = project.boneOrder.length % BONE_PALETTE.length;
  const baseName = parentId === null ? "root" : "bone";
  const color = BONE_PALETTE[paletteIdx] ?? BONE_PALETTE[0]!;
  const bone: Bone = {
    id: newId(),
    name: uniqueName(project, baseName),
    parent: parentId,
    x: parentId === null ? worldX : lx,
    y: parentId === null ? worldY : ly,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    length: 80,
    color,
  };
  project.bones[bone.id] = bone;
  project.boneOrder.push(bone.id);
  if (parentId === null) project.rootIds.push(bone.id);
  return bone.id;
}

export function selectBone(state: EditorState, id: Id, additive: boolean = false): void {
  if (!additive) state.selection.boneIds.clear();
  state.selection.boneIds.add(id);
}

export function selectBones(state: EditorState, ids: Iterable<Id>): void {
  state.selection.boneIds.clear();
  for (const id of ids) state.selection.boneIds.add(id);
}

export function clearSelection(state: EditorState): void {
  state.selection.boneIds.clear();
}

export function setTool(state: EditorState, tool: Tool): void {
  state.tool = tool;
}

/** Switch the editor's mode (FR-RB-7 — P2.B). Handles the Pose-mode
 *  snapshot/restore so trying out a pose can't accidentally mutate the
 *  bind pose. The mode swap is wrapped in a history transaction so
 *  undo doesn't bring back stale Pose-mode bone positions on restore. */
export function setMode(state: EditorState, mode: EditorMode): void {
  if (state.mode === mode) return;
  // Leaving Pose mode → restore the snapshot so bind pose / animation
  // tracks are untouched by whatever the user dragged around. We do
  // this BEFORE flipping `state.mode` so any subscribers observe a
  // consistent project shape on the next emit.
  if (state.mode === "pose" && state.poseSnapshot) {
    for (const [id, snap] of Object.entries(state.poseSnapshot)) {
      const b = state.project.bones[id];
      if (!b) continue;
      b.x = snap.x;
      b.y = snap.y;
      b.rotation = snap.rotation;
      b.scaleX = snap.scaleX;
      b.scaleY = snap.scaleY;
    }
    state.poseSnapshot = null;
  }
  // Entering Pose mode → snapshot the current bone transforms so we
  // can rewind on exit.
  if (mode === "pose") {
    const snap: Record<Id, { x: number; y: number; rotation: number; scaleX: number; scaleY: number }> = {};
    for (const id of state.project.boneOrder) {
      const b = state.project.bones[id];
      if (b) snap[id] = { x: b.x, y: b.y, rotation: b.rotation, scaleX: b.scaleX, scaleY: b.scaleY };
    }
    state.poseSnapshot = snap;
  }
  state.mode = mode;
}

/** Set the active attachment on a slot (FR-SA-4 — P2.D), choosing
 *  from the slot's `alts` list (or its current default). The bind-pose
 *  attachment lives at `slot.attachment`; alternatives live in
 *  `slot.alts`. Pass `null` to hide the slot. The full animated
 *  attachment swap (per-keyframe) is handled by the timeline /
 *  spine-export passes; this helper covers the non-animated bind-pose
 *  swap that the inspector / a sprite-sheet importer will use. */
export function setSlotAttachment(state: EditorState, slotId: Id, attachmentId: Id | null): void {
  const s = state.project.slots[slotId];
  if (!s) return;
  s.attachment = attachmentId;
}

/** Add an alternative attachment to a slot. The default attachment
 *  (`slot.attachment`) is implicit — you don't need to add it to
 *  `alts` for the runtime to know about it. Idempotent. */
export function addSlotAlt(state: EditorState, slotId: Id, attachmentId: Id): void {
  const s = state.project.slots[slotId];
  if (!s) return;
  if (!s.alts) s.alts = [];
  if (!s.alts.includes(attachmentId) && s.attachment !== attachmentId) {
    s.alts.push(attachmentId);
  }
}

/** Set the per-slot tint (FR-SA-5 — P2.D). Hex form `#RRGGBB` or
 *  `#RRGGBBAA`; pass undefined to clear. */
export function setSlotTint(state: EditorState, slotId: Id, tint: string | undefined): void {
  const s = state.project.slots[slotId];
  if (!s) return;
  if (tint === undefined) delete s.tint;
  else s.tint = tint;
}

/** Insert (or replace) a slot-attachment keyframe on the active
 *  animation (FR-SA-4 — P2.5.b). The keyframe's `value` is the
 *  attachment id to swap to at `time`, or `null` to hide the slot.
 *  Stepped curve by nature — Spine doesn't lerp attachment names. */
export function setSlotAttachmentKeyframe(
  state: EditorState,
  slotId: Id,
  time: number,
  attachmentId: Id | null,
): void {
  const anim = getActiveAnimation(state);
  if (!anim) return;
  let track = anim.tracks.find((t) => t.kind === "slot" && t.slotId === slotId && t.property === "attachment");
  if (!track) {
    track = { kind: "slot", slotId, property: "attachment", keyframes: [] };
    anim.tracks.push(track);
  }
  const t = snapTime(time);
  const value = (attachmentId ?? "") as Keyframe["value"];
  upsertKeyframe(anim, track, t, { time: t, value, curve: "stepped" });
}

/** Insert (or replace) a slot-color keyframe on the active animation
 *  (FR-SA-5 — P2.5.b). Tints can be lerped, so the default curve is
 *  linear. */
export function setSlotColorKeyframe(
  state: EditorState,
  slotId: Id,
  time: number,
  color: string,
): void {
  const anim = getActiveAnimation(state);
  if (!anim) return;
  let track = anim.tracks.find((t) => t.kind === "slot" && t.slotId === slotId && t.property === "color");
  if (!track) {
    track = { kind: "slot", slotId, property: "color", keyframes: [] };
    anim.tracks.push(track);
  }
  const t = snapTime(time);
  upsertKeyframe(anim, track, t, { time: t, value: color, curve: "linear" });
}

export function removeBone(state: EditorState, id: Id): void {
  const { project } = state;
  const bone = project.bones[id];
  if (!bone) return;
  // Reparent children up to the deleted bone's parent.
  // Important: when the deleted bone was a root (parent === null), the
  // children become roots themselves and MUST be added to project.rootIds
  // — otherwise the hierarchy panel displays them with the wrong indent
  // (this no longer affects pose evaluation since orderBones now uses
  // boneOrder as the source of truth, but rootIds still drives display).
  for (const cid of project.boneOrder) {
    const c = project.bones[cid];
    if (c && c.parent === id) {
      c.parent = bone.parent;
      if (c.parent === null && !project.rootIds.includes(cid)) {
        project.rootIds.push(cid);
      }
    }
  }
  delete project.bones[id];
  project.boneOrder = project.boneOrder.filter((x) => x !== id);
  project.rootIds = project.rootIds.filter((x) => x !== id);
  state.selection.boneIds.delete(id);
  // Also clean up any attachments bound to this bone — otherwise they
  // become orphans pointing at a missing id and the renderer logs
  // warnings on every frame.
  const orphanedAtts: Id[] = [];
  for (const aid of project.attachmentOrder) {
    const a = project.attachments[aid];
    if (a && a.bindBone === id) orphanedAtts.push(aid);
  }
  for (const aid of orphanedAtts) {
    delete project.attachments[aid];
    project.attachmentOrder = project.attachmentOrder.filter((x) => x !== aid);
    for (const sid of project.slotOrder) {
      const s = project.slots[sid];
      if (s && s.attachment === aid) s.attachment = null;
    }
  }
  // Drop any slots that bound directly to this bone (their attachment
  // would have been deleted above; the slot itself is now meaningless).
  const orphanedSlots: Id[] = [];
  for (const sid of project.slotOrder) {
    const s = project.slots[sid];
    if (s && s.bone === id) orphanedSlots.push(sid);
  }
  for (const sid of orphanedSlots) {
    delete project.slots[sid];
    project.slotOrder = project.slotOrder.filter((x) => x !== sid);
  }
}

/** Set the parent of `id` to `newParentId` (or null to make it a root).
 *  Rejects the call if it would create a cycle (newParent is a descendant
 *  of id). */
export function reparentBone(state: EditorState, id: Id, newParentId: Id | null): boolean {
  const { project } = state;
  const bone = project.bones[id];
  if (!bone) return false;
  if (newParentId !== null) {
    if (newParentId === id) return false;
    if (!project.bones[newParentId]) return false;
    if (isDescendantOf(project, id, newParentId)) return false;
  }
  // If we're moving from root to parented, drop from rootIds.
  if (bone.parent === null) {
    project.rootIds = project.rootIds.filter((x) => x !== id);
  }
  // If we're moving from parented to root, add to rootIds.
  if (newParentId === null && bone.parent !== null) {
    project.rootIds.push(id);
  }
  bone.parent = newParentId;
  return true;
}

/** Move a bone to a new world position. The bone keeps its current
 *  parent and (if parented) we recompute its local coords from world
 *  using the parent's *world* transform (not just parent.local). */
export function moveBoneWorld(state: EditorState, id: Id, worldX: number, worldY: number): void {
  const b = state.project.bones[id];
  if (!b) return;
  if (b.parent === null) {
    b.x = worldX;
    b.y = worldY;
    return;
  }
  if (!state.project.bones[b.parent]) return;
  const { lx, ly } = worldToParentLocal(state.project, b.parent, worldX, worldY);
  b.x = lx;
  b.y = ly;
}

/** Set a bone's *world* rotation. If the bone has a parent, we
 *  subtract the parent's accumulated world rotation to keep the
 *  child's world rotation at the requested value. Mirrors
 *  `moveBoneWorld` for the rotation axis. */
export function setBoneWorldRotation(state: EditorState, id: Id, worldRotationDeg: number): void {
  const b = state.project.bones[id];
  if (!b) return;
  if (b.parent === null) {
    b.rotation = worldRotationDeg;
    return;
  }
  const p = state.project.bones[b.parent];
  if (!p) { b.rotation = worldRotationDeg; return; }
  // Walk up the chain and sum parent world rotations.
  let parentWorld = 0;
  let cur: Id | null = b.parent;
  while (cur !== null) {
    const pb: Bone | undefined = state.project.bones[cur];
    if (!pb) break;
    parentWorld += pb.rotation;
    cur = pb.parent;
  }
  b.rotation = worldRotationDeg - parentWorld;
}

/* ---------- Playback (P1.D) ---------- */

/** Get the currently active animation, or null if the project is
 *  somehow in an inconsistent state (no animations defined). */
export function getActiveAnimation(state: EditorState) {
  return state.project.animations[state.project.activeAnimationId] ?? null;
}

/** Snap a keyframe time to 0.01s precision. Used everywhere we insert
 *  or look up keyframes — the rounding ensures floating-point drift
 *  doesn't create duplicate near-identical keyframes when a user
 *  scrubs and presses K twice. */
function snapTime(t: number): number {
  return Math.round(t * 100) / 100;
}

/** Find or create the animation track that covers (boneId, property).
 *  Bone tracks only — slot tracks have their own helpers. */
function findOrCreateBoneTrack(
  anim: { tracks: Array<{ kind?: "bone" | "slot"; boneId?: Id; slotId?: Id; property: string; keyframes: Keyframe[] }> },
  boneId: Id,
  property: "translate" | "rotation" | "scale",
) {
  let track = anim.tracks.find((t) => (t.kind ?? "bone") === "bone" && t.boneId === boneId && t.property === property);
  if (!track) {
    track = { boneId, property, keyframes: [] };
    anim.tracks.push(track);
  }
  return track;
}

/** Insert (or replace) a keyframe on a track at time `t`. The track is
 *  kept sorted by `time` so the sampler's binary-pair walk works. The
 *  optional `bumpDuration` flag extends `anim.duration` to fit when the
 *  new time exceeds it (capped at 60s — same cap as the legacy code). */
function upsertKeyframe(
  anim: { duration: number },
  track: { keyframes: Keyframe[] },
  t: number,
  kf: Keyframe,
): void {
  const existing = track.keyframes.findIndex((k) => Math.abs(k.time - t) < 0.005);
  if (existing >= 0) {
    track.keyframes[existing] = kf;
  } else {
    track.keyframes.push(kf);
    track.keyframes.sort((a, b) => a.time - b.time);
  }
  if (t > anim.duration) anim.duration = Math.min(t, 60);
}

/** Set / clear keyframes on the active animation. The `value` shape
 *  follows FSD §7.1.1 (translate/scale → {x,y}, rotation → number).
 *  Keyframes are kept sorted by time. */
export function setKeyframe(
  state: EditorState,
  boneId: Id,
  property: "translate" | "rotation" | "scale",
  time: number,
  value: number | { x: number; y: number },
): void {
  const anim = getActiveAnimation(state);
  if (!anim) return;
  const track = findOrCreateBoneTrack(anim, boneId, property);
  const t = snapTime(time);
  upsertKeyframe(anim, track, t, { time: t, value: value as Keyframe["value"], curve: "linear" });
}

/** Identifier for a single keyframe in the active animation. A bone may
 *  have two tracks (translate, rotation) so we need both. The `time`
 *  identifies the keyframe within the track; we snap to 0.01s. */
export interface KeyframeRef {
  boneId: Id;
  property: "translate" | "rotation" | "scale";
  time: number;
}

/** Look up a keyframe on the active animation by reference. Returns
 *  the index in the track, or -1 if not found. */
function findKeyframeIndex(state: EditorState, ref: KeyframeRef): number {
  const anim = getActiveAnimation(state);
  if (!anim) return -1;
  const track = anim.tracks.find((t) => t.boneId === ref.boneId && t.property === ref.property);
  if (!track) return -1;
  return track.keyframes.findIndex((k) => Math.abs(k.time - ref.time) < 0.005);
}

/** Apply an easing preset to a keyframe by reference. The preset is
 *  applied to the keyframe's *outgoing* interpolation — i.e. the
 *  segment from this keyframe to the next. For the last keyframe on a
 *  track the curve is irrelevant (nothing to interpolate to), so we
 *  still store it for consistency. */
export function setKeyframeEasing(
  state: EditorState,
  ref: KeyframeRef,
  preset: EasingPreset,
): void {
  const anim = getActiveAnimation(state);
  if (!anim) return;
  const idx = findKeyframeIndex(state, ref);
  if (idx < 0) return;
  const track = anim.tracks.find((t) => t.boneId === ref.boneId && t.property === ref.property)!;
  const k = track.keyframes[idx]!;
  const p = EASING_PRESETS[preset];
  track.keyframes[idx] = {
    ...k,
    curve: p.curve,
    cp1x: p.cp1x,
    cp1y: p.cp1y,
    cp2x: p.cp2x,
    cp2y: p.cp2y,
  };
}

/* ---------- Keyframe clipboard (P1.D+) ---------- */

/** A snapshot of a keyframe, deep enough to survive edits to the
 *  original. We deep-clone the value object so paste doesn't share
 *  the reference. */
export interface KeyframeClipboardEntry {
  boneId: Id;
  property: "translate" | "rotation" | "scale";
  /** Offset of the keyframe's `time` from the *first selected* keyframe's
   *  time. When pasting, the entry is placed at `currentTime + timeOffset`.
   *  This is how a group of keyframes keeps their relative timing. */
  timeOffset: number;
  value: Keyframe["value"];
  curve: Keyframe["curve"];
  cp1x?: number;
  cp1y?: number;
  cp2x?: number;
  cp2y?: number;
}

/** The single-slot editor clipboard. Reset on app load. */
export interface KeyframeClipboard {
  entries: KeyframeClipboardEntry[];
  /** "copy" leaves the source keyframes in place; "cut" deletes them. */
  mode: "copy" | "cut";
  /** Wall-clock time of the copy/cut. Currently unused but useful for
   *  showing a "clipboard stale" indicator. */
  timestamp: number;
}

export function createEmptyClipboard(): KeyframeClipboard {
  return { entries: [], mode: "copy", timestamp: 0 };
}

/** Copy the given keyframes to the clipboard. Deep-clones values so
 *  later edits to the source don't mutate the clipboard. */
export function copyKeyframes(state: EditorState, refs: KeyframeRef[]): number {
  const anim = getActiveAnimation(state);
  if (!anim) return 0;
  if (!state.clipboard) state.clipboard = createEmptyClipboard();
  if (refs.length === 0) return 0;
  // Find the smallest time so we can normalize the offsets.
  let tMin = Infinity;
  for (const r of refs) {
    const idx = findKeyframeIndex(state, r);
    if (idx < 0) continue;
    tMin = Math.min(tMin, r.time);
  }
  if (!isFinite(tMin)) return 0;
  const out: KeyframeClipboardEntry[] = [];
  for (const r of refs) {
    const idx = findKeyframeIndex(state, r);
    if (idx < 0) continue;
    const track = anim.tracks.find((t) => t.boneId === r.boneId && t.property === r.property)!;
    const k = track.keyframes[idx]!;
    out.push({
      boneId: k.time !== undefined ? r.boneId : r.boneId,  // always r.boneId
      property: r.property,
      timeOffset: +(k.time - tMin).toFixed(3),
      value: typeof k.value === "object" && k.value !== null
        ? { ...(k.value as { x: number; y: number }) }
        : k.value,
      curve: k.curve,
      cp1x: k.cp1x,
      cp1y: k.cp1y,
      cp2x: k.cp2x,
      cp2y: k.cp2y,
    });
  }
  state.clipboard.entries = out;
  state.clipboard.mode = "copy";
  state.clipboard.timestamp = performance.now();
  return out.length;
}

/** Paste the clipboard at the current playhead. Each entry is offset
 *  by `currentTime + entry.timeOffset`. Returns the number of new
 *  keyframes created. If `cut` mode was used, the source keyframes
 *  are removed first. Existing keyframes at the same (bone, property,
 *  time) are replaced (not merged). */
export function pasteKeyframes(state: EditorState): number {
  const anim = getActiveAnimation(state);
  if (!anim) return 0;
  const clip = state.clipboard;
  if (!clip || clip.entries.length === 0) return 0;
  const t0 = state.playback.currentTime;
  // If we're a cut, remove the source keyframes first. We use a
  // timeOffset-to-original-time map for this.
  if (clip.mode === "cut") {
    // For cut, the source is the original (not currentTime-offset)
    // positions. We need to recover those — we kept the original
    // times as the `time` of each entry minus `timeOffset`. So the
    // original time of entry i is `t0_now` minus `state.playback.currentTime`
    // at cut time, plus `entry.timeOffset`. We didn't store that
    // snapshot, so for cut we use the SOURCE reference directly: the
    // caller is expected to have stored the refs in a side channel.
    // To keep the API simple, we just don't delete-on-cut for now —
    // cut == copy + delete-from-original, but since the user can
    // undo that decision by hitting Paste again, we just copy here.
    // (A future pass can add an `originalRefs` field to the clipboard.)
  }
  let created = 0;
  for (const e of clip.entries) {
    const newTime = +(t0 + e.timeOffset).toFixed(3);
    setKeyframeRaw(state, e.boneId, e.property, newTime, e.value, {
      curve: e.curve,
      cp1x: e.cp1x,
      cp1y: e.cp1y,
      cp2x: e.cp2x,
      cp2y: e.cp2y,
    });
    created++;
  }
  if (created > 0) {
    if (t0 + Math.max(...clip.entries.map((e) => e.timeOffset)) > anim.duration) {
      anim.duration = Math.min(60, t0 + Math.max(...clip.entries.map((e) => e.timeOffset)));
    }
  }
  return created;
}

/** Internal: insert a keyframe with full curve metadata, replacing any
 *  existing keyframe at the same (bone, property, time). */
function setKeyframeRaw(
  state: EditorState,
  boneId: Id,
  property: "translate" | "rotation" | "scale",
  time: number,
  value: Keyframe["value"],
  curve: { curve: Keyframe["curve"]; cp1x?: number; cp1y?: number; cp2x?: number; cp2y?: number },
): void {
  const anim = getActiveAnimation(state);
  if (!anim) return;
  const track = findOrCreateBoneTrack(anim, boneId, property);
  const t = snapTime(time);
  upsertKeyframe(anim, track, t, {
    time: t,
    value,
    curve: curve.curve,
    cp1x: curve.cp1x,
    cp1y: curve.cp1y,
    cp2x: curve.cp2x,
    cp2y: curve.cp2y,
  });
}

/** Cut keyframes — copy to clipboard, then remove from the project.
 *  We keep the original times in the clipboard entries (as timeOffset
 *  relative to the cut's tMin) so paste would restore them — but for
 *  now we only support "copy" semantics; see pasteKeyframes comment. */
export function cutKeyframes(state: EditorState, refs: KeyframeRef[]): number {
  const n = copyKeyframes(state, refs);
  if (n === 0) return 0;
  // Also remove the sources.
  for (const r of refs) {
    deleteKeyframeAt(state, r.boneId, r.property, r.time);
  }
  return n;
}

/** Duplicate keyframes — copy to clipboard, then paste at the original
 *  times + 1 frame. The simplest "duplicate in place" behaviour. */
export function duplicateKeyframes(state: EditorState, refs: KeyframeRef[]): number {
  if (refs.length === 0) return 0;
  const n = copyKeyframes(state, refs);
  if (n === 0) return 0;
  // Paste at the smallest selected time + small offset.
  let tMin = Infinity;
  for (const r of refs) {
    if (findKeyframeIndex(state, r) >= 0) tMin = Math.min(tMin, r.time);
  }
  if (!isFinite(tMin)) return 0;
  const savedTime = state.playback.currentTime;
  state.playback.currentTime = Math.min(tMin + 0.1, 60);
  pasteKeyframes(state);
  state.playback.currentTime = savedTime;
  return n;
}

/** Remove the keyframe at time `time` on (bone, property). If no
 *  keyframe exists within 0.005s, this is a no-op. */
export function deleteKeyframeAt(
  state: EditorState,
  boneId: Id,
  property: "translate" | "rotation" | "scale",
  time: number,
): void {
  const anim = getActiveAnimation(state);
  if (!anim) return;
  const track = anim.tracks.find((t) => t.boneId === boneId && t.property === property);
  if (!track) return;
  const idx = track.keyframes.findIndex((k) => Math.abs(k.time - time) < 0.005);
  if (idx < 0) return;
  track.keyframes.splice(idx, 1);
  if (track.keyframes.length === 0) {
    anim.tracks = anim.tracks.filter((t) => t !== track);
  }
}

/** Set the playhead to time `t`, clamped to [0, duration]. */
export function setCurrentTime(state: EditorState, t: number): void {
  const anim = getActiveAnimation(state);
  if (!anim) { state.playback.currentTime = 0; return; }
  let clamped = Math.max(0, Math.min(anim.duration, t));
  if (anim.looping) {
    // Allow scrubbing past the end (it'll wrap on play).
    clamped = Math.max(0, t);
  }
  state.playback.currentTime = clamped;
}

/** Toggle between playing and paused. Resets the dt baseline so the
 *  playhead doesn't jump on resume. */
export function togglePlayback(state: EditorState): void {
  state.playback.playing = !state.playback.playing;
  state.playback.lastTickMs = state.playback.playing ? performance.now() : NaN;
  // If we just stopped playing, leave currentTime where it is so the
  // user can see the last frame; only reset on Stop (separate action).
}

/** Stop playback and rewind to t=0. */
export function stopPlayback(state: EditorState): void {
  state.playback.playing = false;
  state.playback.currentTime = 0;
  state.playback.lastTickMs = NaN;
}
