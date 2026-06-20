// src/editor/viewport.ts
// The viewport is two stacked canvases:
//   1. WebGL2 underlay — renders the deformed mesh (P1.C onwards, empty in 1.A)
//   2. Canvas 2D overlay — renders the gizmos: grid, bones, selection handles
//
// We do this split because:
//   - The editor UI (grid, bones, handles) redraws on every mouse-move and
//     needs crisp 2D vector lines — perfect for Canvas 2D.
//   - The mesh preview is GPU-skinned and we want it cheap — WebGL2.
//
// Both canvases share the same pixel size and CSS transform. We resize them
// together on window resize and on devicePixelRatio changes.

import type { EditorState, ViewportState } from "./store";
import { evalPose, evalPoseWithSamples, sampleAnimation, orderBones, boneTailWorld, accumulatedBoneRotationDeg } from "../core/eval";
import { distPointSegment, degToRad } from "../core/math";
import type { Bone, Id, Project } from "../core/model";
import { SkinRenderer, buildShaderBoneIndex } from "./skin-renderer";
import { bus, EV } from "./bus";
import { getActiveAnimation } from "./store";
import type { Mat3 } from "../core/math";
import { parseHexRGB } from "../core/color";

const OVERLAY_BG = "#2a2f3a";
const GRID_MAJOR = "#3a4150";
const GRID_MINOR = "#323845";
const BONE_DEFAULT = "#9aa3b2";
const BONE_SELECTED = "#ffd166";
const BONE_HEAD = "#e0e6ef";
const STAGE_BORDER = "#1a1d24";
const PARENT_LINK = "#5b9cff";

export class Viewport {
  readonly overlay: HTMLCanvasElement;
  readonly gl: HTMLCanvasElement;
  private glCtx: WebGL2RenderingContext | null = null;
  private overlayCtx: CanvasRenderingContext2D;
  private state: EditorState;
  private cssWidth = 0;
  private cssHeight = 0;
  private rafHandle: number | null = null;
  private dirty = true;
  /** GPU skinning for mesh attachments. Null if WebGL2 unavailable. */
  private skin: SkinRenderer | null = null;
  /** Element to read mouse events from. We use the overlay's parent (#stage)
   *  so the WebGL canvas underneath doesn't block events. */
  readonly eventTarget: HTMLElement;  /** Cached sampled world transforms. Recomputed when the project
   *  changes or the playhead moves. All render code reads from this
   *  cache to keep the bone + skin draws in sync. */
  private poseCache: Map<Id, Mat3> | null = null;

  constructor(parent: HTMLElement, state: EditorState) {
    this.state = state;
    this.eventTarget = parent;

    // Stacking order (bottom → top):
    //   1. WebGL canvas (the face mesh, skinned by the rig)
    //   2. 2D overlay (the bone gizmo, grid, selection handles)
    //
    // The bone gizmo is on top of the face so the rig is always visible
    // and clickable. This is the default Spine / animation-tool layout:
    // artists need to see the rig they're working on, not the character
    // that will appear in the exported runtime. The WebGL canvas is
    // `pointer-events: none` so events still reach the overlay below.
    this.overlay = document.createElement("canvas");
    this.overlay.className = "viewport-overlay";
    this.overlay.style.cssText = "position:absolute;inset:0;width:100%;height:100%;z-index:2;";
    parent.appendChild(this.overlay);

    this.gl = document.createElement("canvas");
    this.gl.className = "viewport-gl";
    this.gl.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1;";
    parent.appendChild(this.gl);
    this.glCtx = this.gl.getContext("webgl2", { antialias: true, alpha: false, preserveDrawingBuffer: true });
    if (!this.glCtx) {
      console.warn("[viewport] WebGL2 not available — mesh preview will be blank");
    } else {
      this.skin = new SkinRenderer(this.glCtx);
    }
    const ctx = this.overlay.getContext("2d");
    if (!ctx) throw new Error("Could not get 2D context for viewport overlay");
    this.overlayCtx = ctx;

    const ro = new ResizeObserver(() => this.handleResize());
    ro.observe(parent);
    this.handleResize();

    const tick = () => {
      if (this.dirty) {
        this.dirty = false;
        this.draw();
      }
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);

    bus.on(EV.PROJECT_CHANGED, () => this.markDirty());
    bus.on(EV.SELECTION_CHANGED, () => this.markDirty());
    bus.on(EV.TOOL_CHANGED, () => this.markDirty());
    bus.on(EV.VIEWPORT_CHANGED, () => this.markDirty());

    this.eventTarget.addEventListener("wheel", this.onWheel, { passive: false });
  }

  destroy(): void {
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.eventTarget.removeEventListener("wheel", this.onWheel);
  }

  /** Invalidate the skin renderer's cache for a single attachment.
   *  Used by mesh-edit operations (subdivide, future split/merge) so
   *  the next frame uploads fresh buffers. */
  invalidateAttachment(id: Id): void {
    this.skin?.invalidate(id);
  }

  /** Debug/testing helper: return the shader-uniform bone indices that
   *  would be uploaded for each vertex of an attachment. This mirrors
   *  skin-renderer.ts's fixed mapping: vertex bone ids index into
   *  project.boneOrder, not att.boneRefs. */
  debugAttachmentBoneIndices(attachmentId: Id): number[][] {
    const att = this.state.project.attachments[attachmentId];
    if (!att) return [];
    const boneIndex = buildShaderBoneIndex(this.state.project);
    return att.vertices.map((v) =>
      Array.from(v.bones).map((bid) => boneIndex.get(bid as Id) ?? 0)
    );
  }

  markDirty(): void { this.dirty = true; }

  /* ---------- coordinate transforms ---------- */

  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    const { panX, panY, zoom } = this.state.viewport;
    return { x: wx * zoom + panX, y: wy * zoom + panY };
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    const { panX, panY, zoom } = this.state.viewport;
    return { x: (sx - panX) / zoom, y: (sy - panY) / zoom };
  }

  /* ---------- resize ---------- */

  private handleResize(): void {
    const rect = this.eventTarget.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.cssWidth = rect.width;
    this.cssHeight = rect.height;
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    for (const c of [this.gl, this.overlay]) {
      c.width = w;
      c.height = h;
    }
    this.markDirty();
  }

  /* ---------- zoom (mouse wheel) ---------- */

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const rect = this.eventTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const before = this.screenToWorld(sx, sy);
    const factor = Math.exp(-e.deltaY * 0.001);
    const next = Math.max(0.1, Math.min(8, this.state.viewport.zoom * factor));
    this.state.viewport.zoom = next;
    const after = this.screenToWorld(sx, sy);
    this.state.viewport.panX += (after.x - before.x) * next;
    this.state.viewport.panY += (after.y - before.y) * next;
    bus.emit(EV.VIEWPORT_CHANGED);
  };

  /** Center & frame all bone content on screen (instead of just the
   *  project rectangle). Computes the bounding box of bone heads +
   *  tails in the setup pose, then centers that box. */
  frameAll(): void {
    const { project, viewport } = this.state;
    const pose = evalPose(project);
    const bbox = boneBoundingBox(orderBones(project), pose);
    let { minX, minY, maxX, maxY } = bbox;
    // If no bones exist, fall back to the project rect
    if (!isFinite(minX)) { minX = 0; minY = 0; maxX = project.width; maxY = project.height; }
    const bw = maxX - minX || 1;
    const bh = maxY - minY || 1;
    const pad = 40;
    const sx = this.cssWidth - pad * 2;
    const sy = this.cssHeight - pad * 2;
    const zoom = Math.min(sx / bw, sy / bh);
    viewport.zoom = Math.max(0.1, Math.min(8, zoom * 0.5));
    viewport.panX = (this.cssWidth  - bw * viewport.zoom) / 2 - minX * viewport.zoom;
    viewport.panY = (this.cssHeight - bh * viewport.zoom) / 2 - minY * viewport.zoom;
    bus.emit(EV.VIEWPORT_CHANGED);
  }

  /** Frame the current selection (FR-VP-4 — P2.B). Computes the
   *  bounding box of the selected bones' world-space heads + tails,
   *  pads it, and centers it. Falls back to frameAll if nothing is
   *  selected. */
  frameSelection(): void {
    const { selection, viewport, project } = this.state;
    if (selection.boneIds.size === 0) { this.frameAll(); return; }
    this.computePose();
    const pose = this.poseCache!;
    const selectedBones: Bone[] = [];
    for (const id of selection.boneIds) {
      const b = project.bones[id];
      if (b) selectedBones.push(b);
    }
    const { minX, minY, maxX, maxY } = boneBoundingBox(selectedBones, pose);
    if (!isFinite(minX)) { this.frameAll(); return; }
    const w = Math.max(20, maxX - minX);
    const h = Math.max(20, maxY - minY);
    const pad = 40;
    const sx = this.cssWidth - pad * 2;
    const sy = this.cssHeight - pad * 2;
    const zoom = Math.min(sx / w, sy / h, 4); // cap — single-bone selection shouldn't zoom to 100×
    viewport.zoom = Math.max(0.1, Math.min(8, zoom));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    viewport.panX = this.cssWidth  / 2 - cx * viewport.zoom;
    viewport.panY = this.cssHeight / 2 - cy * viewport.zoom;
    bus.emit(EV.VIEWPORT_CHANGED);
  }

  /** Returns the topmost bone whose head is within `tol` world units of (x,y). */
  hitBoneHead(worldX: number, worldY: number, tol: number): Bone | null {
    // Recompute the pose on demand (no cache yet at click time).
    this.computePose();
    const pose = this.poseCache!;
    let best: { bone: Bone; d: number } | null = null;
    for (const b of orderBones(this.state.project)) {
      const w = pose.get(b.id);
      if (!w) continue;
      const hx = w.m[4] ?? 0;
      const hy = w.m[5] ?? 0;
      const d = Math.hypot(worldX - hx, worldY - hy);
      if (d < tol && (!best || d < best.d)) best = { bone: b, d };
    }
    return best?.bone ?? null;
  }

  /** Returns the topmost bone whose shaft or head is within `tol` world units.
   *  Children take priority over parents when both are within `tol`: a child
   *  bone whose head sits exactly on its parent's shaft (e.g. a child placed
   *  along the parent's bone direction) should be picked, not the parent.
   *  Without this, a click on the child's head selects the parent, and any
   *  drag then moves the parent — the cursor visibly "leaves" the bone. */
  hitBone(worldX: number, worldY: number, tol: number): Bone | null {
    this.computePose();
    const pose = this.poseCache!;
    type Hit = { bone: Bone; d: number; depth: number };
    const hits: Hit[] = [];
    for (const b of orderBones(this.state.project)) {
      const w = pose.get(b.id);
      if (!w) continue;
      const hx = w.m[4] ?? 0;
      const hy = w.m[5] ?? 0;
      // The shaft direction here is computed from raw `bone.rotation`
      // accumulated up the parent chain — NOT from the world matrix's
      // first column. The two values normally agree, but this hit-test
      // path historically used the parent-walk version even when the
      // pose came from a sampled animation. Keep the formula identical
      // to avoid changing pick semantics during playback.
      let depth = 0;
      let p: Bone | undefined = b;
      while (p) { depth++; p = p.parent ? this.state.project.bones[p.parent] : undefined; }
      const tr = degToRad(accumulatedBoneRotationDeg(this.state.project, b.id));
      const tx = hx + Math.cos(tr) * b.length;
      const ty = hy + Math.sin(tr) * b.length;
      const d = distPointSegment(worldX, worldY, hx, hy, tx, ty);
      if (d < tol) hits.push({ bone: b, d, depth });
    }
    if (hits.length === 0) return null;
    // Deeper (child) wins over shallower (parent). On tie, smaller distance.
    hits.sort((a, b) => b.depth - a.depth || a.d - b.d);
    return hits[0]?.bone ?? null;
  }

  /** Hit-test attachments at a given world point (P2 usability fix #4).
   *  Returns the topmost attachment whose deformed quad contains the
   *  point, or null. Topmost = drawn last in `slotOrder`, which matches
   *  the user's z-order expectation. We compute each vertex's world
   *  position by applying the bind bone's world transform — this is a
   *  rough hit test (it doesn't honor multi-bone skinning), but for the
   *  common case of a single-bone-bound attachment it matches what's
   *  drawn pixel-perfect. */
  hitAttachment(worldX: number, worldY: number): { attachmentId: Id; bindBone: Id } | null {
    this.computePose();
    const pose = this.poseCache!;
    const project = this.state.project;
    // Walk slotOrder in reverse so later-drawn slots win z-order ties.
    for (let i = project.slotOrder.length - 1; i >= 0; i--) {
      const slot = project.slots[project.slotOrder[i]!];
      if (!slot || !slot.attachment) continue;
      const att = project.attachments[slot.attachment];
      if (!att) continue;
      const bindBone = project.bones[att.bindBone];
      if (!bindBone || bindBone.visible === false) continue;
      const w = pose.get(att.bindBone);
      if (!w) continue;
      // Transform each vertex's local-bind position into world space and
      // build a polygon. att.vertices is BL, BR, TR, TL by construction.
      const poly: Array<{ x: number; y: number }> = [];
      for (const v of att.vertices) {
        poly.push({
          x: w.m[0] * v.x + w.m[2] * v.y + w.m[4],
          y: w.m[1] * v.x + w.m[3] * v.y + w.m[5],
        });
      }
      if (pointInPolygon(worldX, worldY, poly)) {
        return { attachmentId: att.id, bindBone: att.bindBone };
      }
    }
    return null;
  }

  /** Pre-decode attachment images before first render to avoid
   *  "corrupted first frame" texture glitches. */
  async prewarmTextures(urls: string[]): Promise<void> {
    if (this.skin) await this.skin.prewarmImages(urls);
  }

  /** Eagerly upload all attachment GL buffers before first render. */
  async eagerUploadAll(project: Project): Promise<void> {
    if (this.skin) await this.skin.eagerUploadAll(project);
  }

  /* ---------- drawing ---------- */

  private draw(): void {
    const ctx = this.overlayCtx;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);

    // Recompute the world transforms. If the active animation has any
    // tracks, sample it and apply to the bones' local transforms first.
    //
    // EXCEPTION: while the user is actively dragging a bone (live edit
    // mode), bypass the animation sampling. The drag mutates the static
    // bone.x/y directly, and we want the bone to follow the cursor
    // visually as it moves. If we sampled the animation here, the
    // sampled keyframe value would override the static value and the
    // bone would appear "stuck" at the keyframe's recorded position
    // until mouseup, when autoKeyRecord commits the new keyframe and
    // the bone snaps to the cursor.
    const anim = getActiveAnimation(this.state);
    const samples =
      anim && !this.state.dragging
        ? sampleAnimation(anim, this.state.playback.currentTime)
        : null;
    this.poseCache = evalPoseWithSamples(this.state.project, samples);

    this.drawStage(ctx);
    if (this.state.viewport.showGrid) this.drawGrid(ctx);
    // FR-TA-6 — onion skin (P2.G). Draw ghost bones at t±frame at
    // reduced alpha BEFORE the live pose, so the live pose's strokes
    // sit on top. Disabled while dragging (the live drag is the only
    // pose worth showing) and when alpha === 0.
    const onion = this.state.playback.onionSkinAlpha;
    if (this.state.viewport.showBones && onion > 0 && anim && !this.state.dragging) {
      const fps = this.state.project.fps || 30;
      const dt = 1 / fps;
      const t = this.state.playback.currentTime;
      ctx.save();
      ctx.globalAlpha = onion;
      // Past frame — slight cool tint by reusing bone colors as-is is
      // good enough; the alpha makes them read as ghosts.
      const past = sampleAnimation(anim, Math.max(0, t - dt));
      const pastPose = evalPoseWithSamples(this.state.project, past);
      this.drawBonesFrom(ctx, pastPose);
      // Future frame.
      const future = sampleAnimation(anim, Math.min(anim.duration, t + dt));
      const futurePose = evalPoseWithSamples(this.state.project, future);
      this.drawBonesFrom(ctx, futurePose);
      ctx.restore();
    }
    if (this.state.viewport.showBones) {
      this.drawParentLinks(ctx);
      this.drawBones(ctx);
    }

    this.clearGL();
    if (this.state.viewport.showImages) this.drawSkin();
  }

  /** Render bones using a *given* pose (rather than the cached one).
   *  Used by the onion-skin path so the live cache isn't disturbed.
   *  Body is a slimmed copy of `drawBones` — no head dots, just the
   *  shaft strokes, since the dots add noise at low alpha. */
  private drawBonesFrom(ctx: CanvasRenderingContext2D, pose: Map<Id, Mat3>): void {
    const order = orderBones(this.state.project);
    for (const b of order) {
      if (b.visible === false) continue;
      const w = pose.get(b.id);
      if (!w) continue;
      const head = this.worldToScreen(w.m[4] ?? 0, w.m[5] ?? 0);
      // Same matrix layout as `drawBones` below: m[0] = cos*sx, m[1] = sin*sx,
      // so the bone's local +X (length direction) lands at world
      // (cos*length, sin*length). The previous code used m[2] (= -sin)
      // for the Y, which mirrored the gizmo vertically — fixed in P2.5.
      const t = boneTailWorld(w, b.length);
      const tail = this.worldToScreen(t.x, t.y);
      ctx.lineCap = "round";
      ctx.strokeStyle = b.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(head.x, head.y);
      ctx.lineTo(tail.x, tail.y);
      ctx.stroke();
    }
  }

  /** Get the current world transform for a bone, or null if the bone
   *  is missing. Uses the cached pose so the answer matches what the
   *  viewport just drew. */
  getBoneWorld(id: Id): Mat3 | null {
    if (!this.poseCache) {
      // Lazy: force a redraw by marking dirty. Caller should retry.
      this.markDirty();
      return null;
    }
    return this.poseCache.get(id) ?? null;
  }

  /** Recompute and return the pose synchronously (skips caching). */
  computePose(): Map<Id, Mat3> {
    const anim = getActiveAnimation(this.state);
    // Same gate as draw() — during a live drag, the static bone.x/y is
    // authoritative; the animation's sampled value would freeze the
    // hit-test against the old keyframe position and miss the cursor.
    const samples =
      anim && !this.state.dragging
        ? sampleAnimation(anim, this.state.playback.currentTime)
        : null;
    const pose = evalPoseWithSamples(this.state.project, samples);
    this.poseCache = pose;
    return pose;
  }

  private drawSkin(): void {
    if (!this.skin) return;
    const { panX, panY, zoom } = this.state.viewport;
    const anim = getActiveAnimation(this.state);
    this.skin.render(
      this.state.project,
      panX, panY, zoom,
      this.cssWidth, this.cssHeight,
      this.state.playback.currentTime,
      this.poseCache ?? undefined,
      anim,
    );
  }

  private clearGL(): void {
    const g = this.glCtx;
    if (!g) return;
    const [r, gg, b] = parseHexRGB(this.state.project.background);
    g.viewport(0, 0, this.gl.width, this.gl.height);
    g.clearColor(r, gg, b, 1);
    g.clear(g.COLOR_BUFFER_BIT);
  }

  private drawStage(ctx: CanvasRenderingContext2D): void {
    // Background fill is drawn into the WebGL canvas by clearGL(), not here.
    // Painting an opaque rect on the overlay would hide the mesh underneath.
    // We only draw the stage border so the user still sees the stage bounds.
    const { project } = this.state;
    const a = this.worldToScreen(0, 0);
    const b = this.worldToScreen(project.width, project.height);
    ctx.strokeStyle = STAGE_BORDER;
    ctx.lineWidth = 1;
    ctx.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x, b.y - a.y);
  }

  private drawGrid(ctx: CanvasRenderingContext2D): void {
    const { viewport } = this.state;
    const step = 32 * viewport.zoom;
    if (step < 6) return;
    ctx.save();
    ctx.lineWidth = 1;
    const startX = ((viewport.panX % step) + step) % step;
    for (let x = startX; x < this.cssWidth; x += step) {
      const phase = (x - viewport.panX) / step;
      const onMajor = Math.abs(phase - Math.round(phase)) < 0.01;
      ctx.strokeStyle = onMajor ? GRID_MAJOR : GRID_MINOR;
      ctx.beginPath();
      ctx.moveTo(Math.floor(x) + 0.5, 0);
      ctx.lineTo(Math.floor(x) + 0.5, this.cssHeight);
      ctx.stroke();
    }
    const startY = ((viewport.panY % step) + step) % step;
    for (let y = startY; y < this.cssHeight; y += step) {
      ctx.strokeStyle = GRID_MAJOR;
      ctx.beginPath();
      ctx.moveTo(0, Math.floor(y) + 0.5);
      ctx.lineTo(this.cssWidth, Math.floor(y) + 0.5);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Thin line from each child's head to its parent's head, drawn behind
   *  the bone shafts. */
  private drawParentLinks(ctx: CanvasRenderingContext2D): void {
    const pose = this.poseCache;
    if (!pose) return;
    const zoom = this.state.viewport.zoom;
    ctx.save();
    ctx.strokeStyle = PARENT_LINK;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.55;
    for (const id of this.state.project.boneOrder) {
      const b = this.state.project.bones[id];
      if (!b || b.parent === null) continue;
      const w = pose.get(b.id);
      const wp = pose.get(b.parent);
      if (!w || !wp) continue;
      const a = this.worldToScreen(w.m[4] ?? 0, w.m[5] ?? 0);
      const p = this.worldToScreen(wp.m[4] ?? 0, wp.m[5] ?? 0);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawBones(ctx: CanvasRenderingContext2D): void {
    const pose = this.poseCache;
    if (!pose) return;
    const zoom = this.state.viewport.zoom;
    const order = orderBones(this.state.project);

    for (const b of order) {
      if (b.visible === false) continue;
      const w = pose.get(b.id);
      if (!w) continue;
      const head = this.worldToScreen(w.m[4] ?? 0, w.m[5] ?? 0);
      // Use the cached world transform to derive the tail (no need to
      // re-walk the parent chain — eval already composed rotations).
      // The matrix layout in mat3FromTRS is [cos, sin, -sin, cos, tx, ty],
      // so a point at local (length, 0) lands at world (cos*length,
      // sin*length) — use m[0] for X and m[1] for Y. The WebGL shader
      // projects this 1:1 then flips Y on output, so a positive rotation
      // appears as a CW turn on screen. Using the same world tail here
      // keeps the bone gizmo aligned with the skinned image.
      const t = boneTailWorld(w, b.length);
      const tail = this.worldToScreen(t.x, t.y);
      const selected = this.state.selection.boneIds.has(b.id);
      ctx.lineCap = "round";
      ctx.strokeStyle = selected ? BONE_SELECTED : b.color;
      ctx.lineWidth = selected ? 4 : 3;
      ctx.beginPath();
      ctx.moveTo(head.x, head.y);
      ctx.lineTo(tail.x, tail.y);
      ctx.stroke();
    }
    for (const b of order) {
      if (b.visible === false) continue;
      const w = pose.get(b.id);
      if (!w) continue;
      const head = this.worldToScreen(w.m[4] ?? 0, w.m[5] ?? 0);
      const r = 5 * Math.max(0.5, zoom * 0.5);
      ctx.fillStyle = this.state.selection.boneIds.has(b.id) ? BONE_SELECTED : BONE_HEAD;
      ctx.strokeStyle = "#1a1d24";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(head.x, head.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
}

/** Compute the bounding box of `bones`' world-space heads + tails. */
function boneBoundingBox(bones: Iterable<Bone>, pose: Map<Id, Mat3>): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of bones) {
    const w = pose.get(b.id);
    if (!w) continue;
    const hx = w.m[4] ?? 0, hy = w.m[5] ?? 0;
    const tx = hx + (w.m[0] ?? 0) * b.length;
    const ty = hy + (w.m[1] ?? 0) * b.length;
    minX = Math.min(minX, hx, tx);
    minY = Math.min(minY, hy, ty);
    maxX = Math.max(maxX, hx, tx);
    maxY = Math.max(maxY, hy, ty);
  }
  return { minX, minY, maxX, maxY };
}

/** Standard ray-casting point-in-polygon test. Works for any simple
 *  polygon (convex or concave) in any vertex order. */
function pointInPolygon(x: number, y: number, poly: Array<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    const intersect = ((a.y > y) !== (b.y > y)) &&
      (x < ((b.x - a.x) * (y - a.y)) / ((b.y - a.y) || 1e-9) + a.x);
    if (intersect) inside = !inside;
  }
  return inside;
}
