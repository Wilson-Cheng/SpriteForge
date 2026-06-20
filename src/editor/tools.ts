// src/editor/tools.ts
// Mouse handlers for the editor tools: select, bone, rotate.
//
// We translate screen-space mouse events into world coordinates (via the
// viewport), then dispatch to the right tool. Tools are stateless — they
// read/write the shared EditorState and emit bus events.

import type { EditorState } from "./store";
import { addBone, clearSelection, selectBone, selectBones, moveBoneWorld, setBoneWorldRotation } from "./store";
import { beginTransaction, endTransaction } from "./history";
import type { Viewport } from "./viewport";
import type { Id } from "../core/model";
import { evalPose, accumulatedBoneRotationDeg } from "../core/eval";
import { bus, EV } from "./bus";
import { autoKeyRecord } from "./timeline";

export interface ToolContext {
  state: EditorState;
  viewport: Viewport;
}

interface TranslateDrag {
  /** World-space anchor at drag start. */
  startWorldX: number;
  startWorldY: number;
  /** Snapshot of every selected bone's *world* position at drag start. */
  startWorld: Map<Id, { x: number; y: number }>;
}

interface RotateDrag {
  /** Cursor angle (radians) relative to the active bone's head, at drag start. */
  startAngle: number;
  /** World-space head position the rotation pivots around. */
  pivotX: number;
  pivotY: number;
  /** Snapshot of every selected bone's *world* rotation at drag start. */
  startRot: Map<Id, number>;
  /** World heads at drag start, used to clamp rotation to the primary bone. */
  startHeads: Map<Id, { x: number; y: number }>;
}

interface ScaleDrag {
  /** World-space head position the scale pivots around (the primary
   *  bone's world head, not necessarily the cursor's anchor). */
  pivotX: number;
  pivotY: number;
  /** Cursor position at drag start. */
  startX: number;
  startY: number;
  /** Snapshot of every selected bone's *resting* scaleX / scaleY
   *  (bone.scaleX/Y, ignoring any parent scale). We don't compose
   *  parent scale here because editing rest values is the simpler,
   *  more predictable model — the gizmo preview uses bone scale
   *  directly while the user drags. */
  startScale: Map<Id, { sx: number; sy: number }>;
}

let activeDrag: TranslateDrag | null = null;
let activeRotate: RotateDrag | null = null;
let activeScale: ScaleDrag | null = null;

function rect(viewport: Viewport): DOMRect {
  return viewport.eventTarget.getBoundingClientRect();
}

function mouseWorld(ev: MouseEvent, viewport: Viewport): { x: number; y: number } {
  const r = rect(viewport);
  return viewport.screenToWorld(ev.clientX - r.left, ev.clientY - r.top);
}

/** Resolve which bone a rotate/scale gesture should pivot around. Used
 *  by both the rotate and scale tools — the rules are identical:
 *  prefer a hit on a currently-selected bone, else fall back to the
 *  first selection, else hit-test the unselected bone under the cursor
 *  (and select it). Returns null when no bone is under the cursor and
 *  none is selected. Side-effect: may mutate selection + emit
 *  `SELECTION_CHANGED`. */
function pickGesturePivot(
  state: EditorState,
  viewport: Viewport,
  worldX: number,
  worldY: number,
  tol: number,
): Id | null {
  let pivotId: Id | null = null;
  if (state.selection.boneIds.size > 0) {
    const hit = viewport.hitBone(worldX, worldY, tol);
    if (hit && state.selection.boneIds.has(hit.id)) pivotId = hit.id;
    else pivotId = state.selection.boneIds.values().next().value ?? null;
  }
  if (!pivotId) {
    const hit = viewport.hitBone(worldX, worldY, tol);
    if (hit) {
      pivotId = hit.id;
      clearSelection(state);
      selectBone(state, hit.id);
      bus.emit(EV.SELECTION_CHANGED);
    }
  }
  return pivotId;
}

export function attachToolHandlers(viewport: Viewport, state: EditorState): void {
  const target = viewport.eventTarget;
  target.addEventListener("mousedown", (e) => onMouseDown(e, state, viewport));
  target.addEventListener("contextmenu", (e) => e.preventDefault());

  // Middle-mouse pan.
  let panning: { startX: number; startY: number; startPanX: number; startPanY: number } | null = null;
  target.addEventListener("mousedown", (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    panning = {
      startX: e.clientX,
      startY: e.clientY,
      startPanX: state.viewport.panX,
      startPanY: state.viewport.panY,
    };
    const move = (ev: MouseEvent) => {
      if (!panning) return;
      state.viewport.panX = panning.startPanX + (ev.clientX - panning.startX);
      state.viewport.panY = panning.startPanY + (ev.clientY - panning.startY);
      bus.emit(EV.VIEWPORT_CHANGED);
    };
    const up = () => {
      panning = null;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });

  // Marquee-select (Select tool, click on empty area, drag).
  let marquee: { startSx: number; startSy: number; el: HTMLDivElement } | null = null;
  target.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (state.tool !== "select") return;
    const { x, y } = mouseWorld(e, viewport);
    if (viewport.hitBone(x, y, 6 / state.viewport.zoom)) return; // bone hit handled in onMouseDown
    if (viewport.hitAttachment(x, y)) return; // attachment hit also handled in onMouseDown
    e.preventDefault();
    const r = rect(viewport);
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const el: HTMLDivElement = document.createElement("div");
    el.className = "marquee";
    el.style.cssText = `position:absolute;left:${sx}px;top:${sy}px;width:0;height:0;`;
    target.appendChild(el);
    marquee = { startSx: sx, startSy: sy, el };
    const move = (ev: MouseEvent) => {
      if (!marquee) return;
      const cx = ev.clientX - r.left;
      const cy = ev.clientY - r.top;
      const x0 = Math.min(marquee.startSx, cx);
      const y0 = Math.min(marquee.startSy, cy);
      const w  = Math.abs(cx - marquee.startSx);
      const h  = Math.abs(cy - marquee.startSy);
      marquee.el.style.left = x0 + "px";
      marquee.el.style.top  = y0 + "px";
      marquee.el.style.width  = w + "px";
      marquee.el.style.height = h + "px";
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (!marquee) return;
      const cx = ev.clientX - r.left;
      const cy = ev.clientY - r.top;
      const x0 = Math.min(marquee.startSx, cx);
      const y0 = Math.min(marquee.startSy, cy);
      const w  = Math.abs(cx - marquee.startSx);
      const h  = Math.abs(cy - marquee.startSy);
      if (w > 3 && h > 3) {
        // World-space rect.
        const tl = viewport.screenToWorld(x0, y0);
        const br = viewport.screenToWorld(x0 + w, y0 + h);
        const pose = evalPose(state.project);
        const hits: Id[] = [];
        for (const id of state.project.boneOrder) {
          const wp = pose.get(id);
          if (!wp) continue;
          const hx = wp.m[4] ?? 0, hy = wp.m[5] ?? 0;
          if (hx >= tl.x && hx <= br.x && hy >= tl.y && hy <= br.y) hits.push(id);
        }
        if (hits.length) {
          if (ev.shiftKey) {
            for (const id of hits) state.selection.boneIds.add(id);
          } else {
            selectBones(state, hits);
          }
          bus.emit(EV.SELECTION_CHANGED);
        } else {
          clearSelection(state);
          bus.emit(EV.SELECTION_CHANGED);
        }
      }
      marquee.el.remove();
      marquee = null;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
}

function onMouseDown(e: MouseEvent, state: EditorState, viewport: Viewport): void {
  if (e.button === 1) return; // middle-mouse pan
  if (e.button === 0 && (e.target as HTMLElement).closest(".marquee")) return;
  const { x, y } = mouseWorld(e, viewport);
  const tol = 6 / state.viewport.zoom;

  if (state.tool === "bone") {
    if (e.button !== 0) return;
    // Click on a bone head -> select. Otherwise place a new root bone.
    const hit = viewport.hitBoneHead(x, y, tol);
    if (hit) {
      selectBone(state, hit.id, e.shiftKey);
      bus.emit(EV.SELECTION_CHANGED);
    } else {
      const id = addBone(state, null, x, y);
      clearSelection(state);
      selectBone(state, id);
      bus.emit(EV.PROJECT_CHANGED);
      bus.emit(EV.SELECTION_CHANGED);
    }
    return;
  }

  if (state.tool === "rotate") {
    if (e.button !== 0) return;
    // Pick a target bone under the cursor: first the selected bones
    // (so the user can rotate from anywhere on screen), else fall back
    // to a hit test so clicking an unselected bone starts rotating it.
    const pose = evalPose(state.project);
    const pivotId = pickGesturePivot(state, viewport, x, y, tol);
    if (!pivotId) return;

    const pivotWorld = pose.get(pivotId);
    if (!pivotWorld) return;
    const pivotX = pivotWorld.m[4] ?? 0;
    const pivotY = pivotWorld.m[5] ?? 0;
    const startAngle = Math.atan2(y - pivotY, x - pivotX);

    // Snapshot every selected bone's world rotation + world head so
    // multi-selection rotates each around its own head by the same
    // swept angle. We sum raw `bone.rotation` up the parent chain (the
    // same approximation the rest of the editor uses to talk about
    // "world rotation" — it ignores scale/inheritance subtleties, but
    // matches `setBoneWorldRotation`'s inverse formula exactly so the
    // round-trip stays stable).
    const startRot = new Map<Id, number>();
    const startHeads = new Map<Id, { x: number; y: number }>();
    for (const id of state.selection.boneIds) {
      const wp = pose.get(id);
      if (!wp) continue;
      startRot.set(id, accumulatedBoneRotationDeg(state.project, id));
      startHeads.set(id, { x: wp.m[4] ?? 0, y: wp.m[5] ?? 0 });
    }
    activeRotate = { startAngle, pivotX, pivotY, startRot, startHeads };
    state.dragging = true;
    beginTransaction(state);

    const move = (ev: MouseEvent) => {
      if (!activeRotate) return;
      const r2 = rect(viewport);
      const w = viewport.screenToWorld(ev.clientX - r2.left, ev.clientY - r2.top);
      const curAngle = Math.atan2(w.y - activeRotate.pivotY, w.x - activeRotate.pivotX);
      // Snap to 5° increments when Shift is held (Spine-style).
      let deltaDeg = ((curAngle - activeRotate.startAngle) * 180) / Math.PI;
      if (ev.shiftKey) deltaDeg = Math.round(deltaDeg / 5) * 5;
      for (const [id, startWorldRot] of activeRotate.startRot) {
        setBoneWorldRotation(state, id, startWorldRot + deltaDeg);
        autoKeyRecord(state, id, "rotation");
      }
      bus.emit(EV.PROJECT_CHANGED);
    };
    const up = () => {
      activeRotate = null;
      state.dragging = false;
      endTransaction(state);
      bus.emit(EV.PROJECT_CHANGED);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return;
  }

  if (state.tool === "scale") {
    if (e.button !== 0) return;
    // Pick a target bone under the cursor: prefer the current selection
    // (so the user can scale from anywhere on screen), else fall back
    // to a hit test so clicking an unselected bone starts scaling it.
    const pose = evalPose(state.project);
    const pivotId = pickGesturePivot(state, viewport, x, y, tol);
    if (!pivotId) return;

    const pivotWorld = pose.get(pivotId);
    if (!pivotWorld) return;
    const pivotX = pivotWorld.m[4] ?? 0;
    const pivotY = pivotWorld.m[5] ?? 0;
    const startX = x;
    const startY = y;

    // Snapshot every selected bone's resting scale (bone.scaleX / Y).
    // For multi-selection, each bone scales around its own head by the
    // same factor — matches the rotate tool's behaviour.
    const startScale = new Map<Id, { sx: number; sy: number }>();
    for (const id of state.selection.boneIds) {
      const b = state.project.bones[id];
      if (!b) continue;
      startScale.set(id, { sx: b.scaleX, sy: b.scaleY });
    }
    activeScale = { pivotX, pivotY, startX, startY, startScale };
    state.dragging = true;
    beginTransaction(state);

    const move = (ev: MouseEvent) => {
      if (!activeScale) return;
      const r2 = rect(viewport);
      const w = viewport.screenToWorld(ev.clientX - r2.left, ev.clientY - r2.top);
      // Compute per-axis scale factor from the cursor's displacement
      // along each axis relative to its initial position. This way,
      // dragging horizontally scales X, dragging vertically scales Y,
      // and dragging diagonally scales both. Shift = uniform.
      const dx0 = activeScale.startX - activeScale.pivotX;
      const dy0 = activeScale.startY - activeScale.pivotY;
      const dx1 = w.x - activeScale.pivotX;
      const dy1 = w.y - activeScale.pivotY;
      // Avoid divide-by-zero when the user starts the drag on top of
      // the head — fall back to a small default axis length.
      const safe = (v: number) => (Math.abs(v) < 1e-3 ? (v < 0 ? -1e-3 : 1e-3) : v);
      const fx = dx1 / safe(dx0);
      const fy = dy1 / safe(dy0);
      // Clamp to a reasonable range so a stray pixel can't blow the
      // bone to 1000× or 0.001×. The clamp is per-axis; Shift snaps
      // both axes to the geometric mean.
      const clamp = (v: number) => Math.max(0.05, Math.min(20, v));
      const cx = clamp(fx);
      const cy = clamp(fy);
      const ux = ev.shiftKey ? Math.sqrt(cx * cy) : cx;
      const uy = ev.shiftKey ? ux : cy;
      for (const [id, start] of activeScale.startScale) {
        const b = state.project.bones[id];
        if (!b) continue;
        b.scaleX = start.sx * ux;
        b.scaleY = start.sy * uy;
        autoKeyRecord(state, id, "scale");
      }
      bus.emit(EV.PROJECT_CHANGED);
    };
    const up = () => {
      activeScale = null;
      state.dragging = false;
      endTransaction(state);
      bus.emit(EV.PROJECT_CHANGED);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return;
  }

  // Select tool
  if (e.button !== 0) return;
  let hit = viewport.hitBone(x, y, tol);
  // P2 usability fix #4 — if no bone is under the cursor, also try
  // attachments. Selecting an attachment selects its bind bone, which
  // means the user can immediately drag to move the attached image
  // (because the image follows the bone). This was the missing
  // affordance — before, clicking on a sprite did nothing.
  if (!hit) {
    const att = viewport.hitAttachment(x, y);
    if (att) {
      const bb = state.project.bones[att.bindBone];
      if (bb) hit = bb;
    }
  }
  if (hit) {
    if (e.shiftKey) selectBone(state, hit.id, true);
    else if (!state.selection.boneIds.has(hit.id)) {
      clearSelection(state);
      selectBone(state, hit.id);
    }
    bus.emit(EV.SELECTION_CHANGED);

    // Begin a translate drag using *world* coords (so parented bones move
    // with their children correctly).
    const startWorld = new Map<Id, { x: number; y: number }>();
    const pose = evalPose(state.project);
    for (const id of state.selection.boneIds) {
      const wp = pose.get(id);
      if (wp) startWorld.set(id, { x: wp.m[4] ?? 0, y: wp.m[5] ?? 0 });
    }
    activeDrag = { startWorldX: x, startWorldY: y, startWorld };
    // Mark the project as "live-editing" so the viewport bypasses
    // animation sampling while a drag is in progress. This keeps the
    // dragged bone glued to the cursor instead of snapping to the
    // animation's currently-sampled keyframe value.
    state.dragging = true;
    // Open a history transaction window. All the per-frame mutations
    // below are suppressed; one capture is recorded once the user
    // releases the mouse — so a drag is one undo step, not 60.
    beginTransaction(state);

    const move = (ev: MouseEvent) => {
      if (!activeDrag) return;
      const r2 = rect(viewport);
      const w = viewport.screenToWorld(ev.clientX - r2.left, ev.clientY - r2.top);
      const dx = w.x - activeDrag.startWorldX;
      const dy = w.y - activeDrag.startWorldY;
      for (const [id, start] of activeDrag.startWorld) {
        moveBoneWorld(state, id, start.x + dx, start.y + dy);
      }
      bus.emit(EV.PROJECT_CHANGED);
    };
    const up = () => {
      // Record a translate keyframe for each dragged bone at the current
      // playhead time. Auto-key is gated inside autoKeyRecord, so this is
      // a no-op when the user has disabled it.
      for (const id of activeDrag ? activeDrag.startWorld.keys() : []) {
        autoKeyRecord(state, id, "translate");
      }
      activeDrag = null;
      // Resume animation sampling on the next frame.
      state.dragging = false;
      // Close the transaction. The PROJECT_CHANGED below will trigger one
      // history capture for the drag's final state.
      endTransaction(state);
      bus.emit(EV.PROJECT_CHANGED);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  } else {
    // No bone hit — marquee handler will run via the second mousedown listener
    // (we don't clear here so the marquee can take over).
  }
}

/* ---------- keyboard tool activation ---------- */

export function installToolShortcuts(state: EditorState): () => void {
  const offV = bus.on<undefined>("tool.select", () => { state.tool = "select"; bus.emit(EV.TOOL_CHANGED); });
  const offB = bus.on<undefined>("tool.bone",   () => { state.tool = "bone";   bus.emit(EV.TOOL_CHANGED); });
  const offR = bus.on<undefined>("tool.rotate", () => { state.tool = "rotate"; bus.emit(EV.TOOL_CHANGED); });
  const offS = bus.on<undefined>("tool.scale",  () => { state.tool = "scale";  bus.emit(EV.TOOL_CHANGED); });
  return () => { offV(); offB(); offR(); offS(); };
}
