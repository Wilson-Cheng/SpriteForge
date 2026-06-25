// src/core/eval.ts
// "Eval" the bone hierarchy at the current pose and produce a flat map of
// world-space transforms. This is the FK (forward kinematics) pass. It's
// what the viewport uses to draw bones and what the mesh skinner uses to
// deform vertices.
//
// We build a list of bones in root-first DFS order, then walk it once,
// composing each bone's parent transform with its local TRS.
//
// P1: FK only. IK / constraints come later.

import type { Project, Bone, Id } from "./model";
import { mat3FromTRS, mat3FromTRSS, mat3Identity, type Mat3, mat3Copy } from "./math";
import { composeWorldFromParentRaw, type InheritMode } from "./animation";

export interface BonePose {
  bone: Bone;
  /** World-space transform. */
  world: Mat3;
}

/** Returns bones in DFS order (root first, children after parent). Safe
 *  against cycles by detecting visited nodes.
 *
 *  As of 2026-06-18 (post-P2.A), this iterates `project.boneOrder`
 *  rather than `project.rootIds` to find roots. The reason: removeBone
 *  used to leave orphaned children with `parent === null` but no entry
 *  in `rootIds`, which made them invisible to orderBones — and any
 *  attachment bound to such an orphan rendered with a zero world
 *  transform (off-screen). Treating "any bone with parent === null" as
 *  a root is the source of truth and survives bookkeeping bugs in
 *  rootIds. The `rootIds` field is still maintained for the hierarchy
 *  panel's display order, but pose evaluation no longer trusts it. */
export function orderBones(project: Project): Bone[] {
  const out: Bone[] = [];
  const visited = new Set<Id>();
  // Recursive but projects are small (10s of bones in P1, ~hundreds in P2).
  const visit = (id: Id) => {
    if (visited.has(id)) return;
    visited.add(id);
    const b = project.bones[id];
    if (!b) return;
    out.push(b);
    // Find children — we don't store a back-pointer, so iterate.
    for (const cid of project.boneOrder) {
      const c = project.bones[cid];
      if (c && c.parent === id) visit(cid);
    }
  };
  // Walk every bone-with-no-parent in boneOrder. boneOrder gives us
  // insertion order, which matches the user's mental "first bone added
  // first" expectation. rootIds is intentionally NOT consulted here.
  for (const id of project.boneOrder) {
    const b = project.bones[id];
    if (b && b.parent === null) visit(id);
  }
  return out;
}

/** Compose a child's world transform from its parent's world matrix and
 *  its own local matrix, honoring the bone's `inherit` mode. Delegates
 *  to the shared core animation engine to keep editor and runtime in sync. */
function composeWorldFromParent(parent: Mat3, local: Mat3, inherit: Bone["inherit"]): Mat3 {
  const result = mat3FromTRS(0, 0, 0, 1);
  composeWorldFromParentRaw(result.m, parent.m, local.m, inherit as InheritMode);
  return result;
}

/** Walk every bone in DFS order and write its world matrix into `world`.
 *  `localFor` returns the bone's local TRS matrix; this is the only
 *  difference between `evalPose` (resting pose) and `evalPoseWithSamples`
 *  (animation overrides). */
function evalPoseInto(project: Project, world: Map<Id, Mat3>, localFor: (b: Bone) => Mat3): Map<Id, Mat3> {
  for (const bone of orderBones(project)) {
    const local = localFor(bone);
    if (bone.parent === null) {
      world.set(bone.id, local);
      continue;
    }
    const parent = world.get(bone.parent);
    if (!parent) {
      world.set(bone.id, local);
      continue;
    }
    world.set(bone.id, composeWorldFromParent(parent, local, bone.inherit));
  }
  return world;
}

/** Compute the world transform for every bone in the project.
 *  Result is returned as a map bone.id -> Mat3. */
export function evalPose(project: Project): Map<Id, Mat3> {
  return evalPoseInto(project, new Map(), (bone) =>
    mat3FromTRSS(bone.x, bone.y, bone.rotation, bone.scaleX ?? 1, bone.scaleY ?? 1),
  );
}

/** Compute the world transform for a single bone (helper used by the
 *  inspector when displaying live values). */
export function evalBoneWorld(project: Project, boneId: Id): Mat3 | null {
  const map = evalPose(project);
  return map.get(boneId) ?? null;
}

/** Like `evalPose`, but applies animation samples (if provided) to the
 *  bone's local x/y/rotation before composing. Used during playback
 *  and scrubbing. Pass `null` for `samples` to behave like `evalPose`. */
export function evalPoseWithSamples(
  project: Project,
  samples: Map<Id, BoneSample> | null,
): Map<Id, Mat3> {
  return evalPoseInto(project, new Map(), (bone) => {
    const s = samples?.get(bone.id);
    const x = s?.x ?? bone.x;
    const y = s?.y ?? bone.y;
    const r = s?.rotation ?? bone.rotation;
    const sx = s?.scaleX ?? bone.scaleX ?? 1;
    const sy = s?.scaleY ?? bone.scaleY ?? 1;
    return mat3FromTRSS(x, y, r, sx, sy);
  });
}

// Re-export so call sites can `import { mat3Identity } from "./eval"` if
// they want a single import path.
export { mat3Identity, mat3FromTRS, mat3FromTRSS, mat3Copy };
export type { Mat3 };

/* ---------- Pose helpers (P2) ---------- */

/** World position of a bone's "head" (its origin), given its world
 *  matrix. Pure convenience — equivalent to `(w.m[4], w.m[5])`. */
export function boneHeadWorld(world: Mat3): { x: number; y: number } {
  return { x: world.m[4]!, y: world.m[5]! };
}

/** World position of a bone's "tail" — the point at distance `length`
 *  along the bone's local +X axis, transformed by the bone's world
 *  matrix. The matrix layout from `mat3FromTRS(S)` is
 *  `[a, b, c, d, tx, ty] = [cos*sx, sin*sx, -sin*sy, cos*sy, tx, ty]`,
 *  so a local `(length, 0)` lands at world `(a*length, b*length)`
 *  relative to the head — i.e. `(m[4] + m[0]*length, m[5] + m[1]*length)`.
 *  This is the formula used in viewport gizmo drawing, frame-all/frame-
 *  selection bounds, and bone-shaft hit testing. */
export function boneTailWorld(world: Mat3, length: number): { x: number; y: number } {
  const m = world.m;
  return { x: m[4]! + m[0]! * length, y: m[5]! + m[1]! * length };
}

/** Sum a bone's rotation with all its ancestors' rotations (in degrees).
 *  Useful when callers need the *static* world rotation derived from
 *  raw `bone.rotation` fields (vs. the cosine-derived rotation extracted
 *  from a sampled world matrix, which incorporates animation overrides
 *  and inheritance modes). The walk is bounded by both the parent chain
 *  length and a `seen` set so a corrupted hierarchy can't loop. */
export function accumulatedBoneRotationDeg(project: Project, boneId: Id): number {
  let acc = 0;
  let cur: Id | null = boneId;
  const seen = new Set<Id>();
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur);
    const b: Bone | undefined = project.bones[cur];
    if (!b) break;
    acc += b.rotation;
    cur = b.parent;
  }
  return acc;
}

/* ---------- Animation sampling (P1.D) ---------- */

/** Per-bone override produced by sampling a track at time `t`. The FK
 *  pass uses these to *replace* (not stack on top of) bone.x/y/rotation
 *  while playing back. When no track is active, all values are null. */
export interface BoneSample {
  /** Override of bone.x at time t. null = use the bone's local value. */
  x: number | null;
  /** Override of bone.y at time t. null = use the bone's local value. */
  y: number | null;
  /** Override of bone.rotation at time t (additive to the local rotation
   *  is *not* the right model — animation replaces, see FSD §7.1.1). */
  rotation: number | null;
  /** Override of bone.scaleX at time t. null = use the bone's local value. */
  scaleX: number | null;
  /** Override of bone.scaleY at time t. null = use the bone's local value. */
  scaleY: number | null;
}

/** Linearly interpolate `a` and `b` by `t` in [0, 1]. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Solve the x parameter of a cubic bezier whose x runs from 0 to 1.
 *  Newton's method with a bisection fallback — converges in 4-6
 *  iterations for typical CSS-style curves. Returns the *t* parameter
 *  of the bezier (in [0, 1]) that corresponds to the input x. */
function solveBezierX(x: number, x1: number, x2: number): number {
  // Quick paths.
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (x1 === x2) {
    // Degenerate (e.g. ease-in-out with both CPs at the same x) — bisect.
    x1 = x2 = 0.5;
  }
  // Newton: f(t) = bezierX(t) - x, f'(t) = 3(1-t)^2(x1) + 6(1-t)t(x2-x1) + 3t^2(1-x2)
  let t = x;
  for (let i = 0; i < 8; i++) {
    const u = 1 - t;
    const fx = 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t - x;
    if (Math.abs(fx) < 1e-6) return t;
    const dfx = 3 * u * u * x1 + 6 * u * t * (x2 - x1) + 3 * t * t * (1 - x2);
    if (Math.abs(dfx) < 1e-9) break;
    t -= fx / dfx;
    if (t < 0) t = 0; if (t > 1) t = 1;
  }
  // Bisection fallback (8 iterations → 1/256 precision).
  let lo = 0, hi = 1;
  for (let i = 0; i < 30; i++) {
    t = (lo + hi) / 2;
    const u = 1 - t;
    const fx = 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t - x;
    if (Math.abs(fx) < 1e-6) return t;
    if (fx < 0) lo = t; else hi = t;
  }
  return t;
}

/** Sample the y axis of a cubic bezier with the given control points
 *  at parameter `t` in [0, 1]. Endpoints are (0,0) and (1,1). */
function bezierY(t: number, y1: number, y2: number): number {
  const u = 1 - t;
  return 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t;
}

/** Map an x in [0, 1] to a y in [0, 1] via a cubic bezier whose
 *  x endpoints are (0,0) and (1,1) and whose control points are the
 *  given `(cp1x, cp1y, cp2x, cp2y)`. */
function easeWithBezier(x: number, cp1x: number, cp1y: number, cp2x: number, cp2y: number): number {
  const t = solveBezierX(x, cp1x, cp2x);
  return bezierY(t, cp1y, cp2y);
}

/** Shared shape of an animation keyframe as seen by the sampler. We
 *  define this locally instead of importing `Keyframe` from `./model`
 *  to keep `eval.ts` decoupled from the storage shape — both editor
 *  and runtime can call `sampleTrack` with their own keyframe types
 *  as long as the field names match. */
type SampledKeyframe = {
  time: number;
  value: number | { x: number; y: number } | string;
  curve: "linear" | "stepped" | "bezier";
  cp1x?: number;
  cp1y?: number;
  cp2x?: number;
  cp2y?: number;
};

/** Shared shape of a track as seen by the sampler. Field set is the
 *  superset used by both bone and slot tracks. */
type SampledTrack = {
  boneId?: Id;
  slotId?: Id;
  kind?: "bone" | "slot";
  property: "translate" | "rotation" | "scale" | "attachment" | "color" | "deform";
  layer?: number;
  additive?: boolean;
  keyframes: SampledKeyframe[];
};

/** Sample a single track at time `t`. Returns null if there are no
 *  keyframes. The animation may be shorter than the keyframes we hold
 *  (keyframe insertion over the end is allowed) — in that case we
 *  clamp t to the last keyframe's time. For `stepped` curves we always
 *  pick the left keyframe. For `bezier` curves we map the linear
 *  progress through the segment through the keyframe's `(cp1x, cp1y,
 *  cp2x, cp2y)` control points to get a non-linear progression. */
export function sampleTrack(
  track: { keyframes: SampledKeyframe[] },
  t: number,
): number | { x: number; y: number } | string | null {
  const ks = track.keyframes;
  if (ks.length === 0) return null;
  // Clamp to the first / last keyframe when outside the range.
  if (t <= ks[0]!.time) return ks[0]!.value;
  if (t >= ks[ks.length - 1]!.time) return ks[ks.length - 1]!.value;
  // Find the surrounding pair (ks[i].time <= t < ks[i+1].time).
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i]!, b = ks[i + 1]!;
    if (a.time <= t && t < b.time) {
      if (a.curve === "stepped") return a.value;
      const span = b.time - a.time;
      const kRaw = span <= 0 ? 0 : (t - a.time) / span;
      // Apply easing. For bezier, map the linear progress through the
      // cubic-bezier curve. For linear (or missing control points), k=kRaw.
      const k = a.curve === "bezier"
        ? easeWithBezier(kRaw, a.cp1x ?? 0, a.cp1y ?? 0, a.cp2x ?? 1, a.cp2y ?? 1)
        : kRaw;
      if (typeof a.value === "number" && typeof b.value === "number") {
        return lerp(a.value, b.value, k);
      }
      if (typeof a.value === "object" && typeof b.value === "object" && a.value && b.value) {
        const av = a.value as { x: number; y: number };
        const bv = b.value as { x: number; y: number };
        return { x: lerp(av.x, bv.x, k), y: lerp(av.y, bv.y, k) };
      }
      return a.value;
    }
  }
  return ks[ks.length - 1]!.value;
}

/** Allocate-or-fetch a BoneSample entry in `out` for `boneId`. */
function getOrCreateBoneSample(out: Map<Id, BoneSample>, boneId: Id): BoneSample {
  let s = out.get(boneId);
  if (!s) {
    s = { x: null, y: null, rotation: null, scaleX: null, scaleY: null };
    out.set(boneId, s);
  }
  return s;
}

/** Sample all tracks in an animation at time `t`. Returns a Map
 *  boneId → BoneSample with non-null values where the animation has a
 *  track. Missing properties stay null. Slot tracks (kind === "slot",
 *  introduced in P2.5.b) are skipped here — they're sampled by a
 *  separate path in the runtime / spine-export. */
export function sampleAnimation(
  anim: { tracks: SampledTrack[] },
  t: number,
): Map<Id, BoneSample> {
  const out = new Map<Id, BoneSample>();
  for (const tr of anim.tracks) {
    // Only bone tracks contribute to the FK pose. Slot tracks are
    // handled elsewhere (they affect attachment selection / tint, not
    // bone transforms).
    if (tr.kind === "slot") continue;
    if (!tr.boneId) continue;
    const v = sampleTrack(tr, t);
    if (v === null) continue;
    const s = getOrCreateBoneSample(out, tr.boneId);
    if (tr.property === "translate" && typeof v === "object" && v) {
      const vv = v as { x: number; y: number };
      if (tr.additive) {
        s.x = (s.x ?? 0) + vv.x;
        s.y = (s.y ?? 0) + vv.y;
      } else {
        s.x = vv.x;
        s.y = vv.y;
      }
    } else if (tr.property === "rotation" && typeof v === "number") {
      s.rotation = tr.additive ? (s.rotation ?? 0) + v : v;
    } else if (tr.property === "scale" && typeof v === "object" && v) {
      const vv = v as { x: number; y: number };
      // Spine scale tracks are multiplicative on top of the bone's
      // resting scale, so additive here means "multiply by (1 + vv)".
      // In practice users record absolute scale values and leave
      // `additive` false.
      if (tr.additive) {
        s.scaleX = (s.scaleX ?? 1) * (1 + vv.x);
        s.scaleY = (s.scaleY ?? 1) * (1 + vv.y);
      } else {
        s.scaleX = vv.x;
        s.scaleY = vv.y;
      }
    }
  }
  return out;
}

/** Sample slot-targeted tracks at time `t` (FR-SA-4 — P2.5.b). Returns
 *  a Map slotId → SlotSample with the active attachment id and / or
 *  color override at that time. Bone tracks are skipped. */
export interface SlotSample {
  /** Active attachment id at time t. `null` means hide the slot.
   *  `undefined` means the track didn't override (use slot.attachment). */
  attachment?: Id | null;
  /** Tint at time t (RRGGBBAA hex with leading `#`). undefined means
   *  the track didn't override. */
  color?: string;
}
export function sampleSlotAnimation(
  anim: { tracks: SampledTrack[] },
  t: number,
): Map<Id, SlotSample> {
  const out = new Map<Id, SlotSample>();
  for (const tr of anim.tracks) {
    if (tr.kind !== "slot") continue;
    if (!tr.slotId) continue;
    const v = sampleTrack(tr, t);
    if (v === null) continue;
    let s = out.get(tr.slotId);
    if (!s) { s = {}; out.set(tr.slotId, s); }
    if (tr.property === "attachment") {
      // For attachment tracks Spine semantics are "stepped" by nature
      // (you can't lerp between attachments). Coerce: take the value
      // verbatim. Empty string / null both mean "hide."
      if (typeof v === "string") s.attachment = v.length === 0 ? null : v;
      else s.attachment = null;
    } else if (tr.property === "color") {
      if (typeof v === "string") s.color = v;
    }
  }
  return out;
}
