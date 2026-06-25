// src/core/animation.ts
// Shared animation engine - used by both the editor and standalone runtime.
// Provides bezier easing, keyframe sampling, and FK transform composition.
// Uses raw Float32Array for matrices to be compatible with both editor and runtime
// (editor wraps in { m: Float32Array }, runtime uses Float32Array directly).

/* -------------------------------------------------------------------------- */
/*  Bezier curve math                                                          */
/* -------------------------------------------------------------------------- */

/** Solve for the t parameter of a cubic bezier given an x coordinate in [0, 1].
 *  Uses Newton-Raphson with bisection fallback. Converges in ~5 iterations for
 *  typical animation curves. The bezier has implicit anchors at (0,0) and (1,1).
 *  This is the Spine 4.x format where curve data is stored as [c2, c3, c4, c5]
 *  corresponding to (cp1.x, cp1.y, cp2.x, cp2.y). */
export function solveBezierX(x: number, c2: number, c3: number, c4: number, c5: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let t = x;
  for (let i = 0; i < 8; i++) {
    const u = 1 - t;
    const fx = 3 * u * u * t * c2 + 3 * u * t * t * c4 + t * t * t - x;
    if (Math.abs(fx) < 1e-6) return t;
    const dfx = 3 * u * u * c2 + 6 * u * t * (c4 - c2) + 3 * t * t * (1 - c4);
    if (Math.abs(dfx) < 1e-9) break;
    const t2 = t - fx / dfx;
    if (Math.abs(t2 - t) < 1e-6) { t = t2; break; }
    t = Math.max(0, Math.min(1, t2));
  }
  // Bisection fallback (8 iterations → 1/256 precision).
  let lo = 0, hi = 1;
  for (let i = 0; i < 30; i++) {
    t = (lo + hi) / 2;
    const u = 1 - t;
    const fx = 3 * u * u * t * c2 + 3 * u * t * t * c4 + t * t * t - x;
    if (Math.abs(fx) < 1e-6) return t;
    if (fx < 0) lo = t; else hi = t;
  }
  return t;
}

/** Evaluate the y coordinate of a cubic bezier at parameter `t` in [0, 1].
 *  Uses the Spine 4.x 2-control-point format (c3 = cp1.y, c5 = cp2.y). */
export function bezierY(t: number, c3: number, c5: number): number {
  const u = 1 - t;
  return 3 * u * u * t * c3 + 3 * u * t * t * c5 + t * t * t;
}

/** CSS-style cubic-bezier easing (four control points). Maps linear progress `x`
 *  to an eased `y` for keyframe interpolation. Equivalent to CSS `cubic-bezier()`. */
export function easeWithBezier(x: number, cp1x: number, cp1y: number, cp2x: number, cp2y: number): number {
  const t = solveBezierX(x, cp1x, cp1y, cp2x, cp2y);
  return bezierY(t, cp1y, cp2y);
}

/** Curve type - matches both editor `Keyframe.curve` and Spine format.
 *  Spine uses a 4-element array for bezier curves; editor uses string enum. */
export type EasingCurve = "linear" | "stepped" | "bezier";
export type CurveData = EasingCurve | readonly number[];

/** Given a linear interpolation factor `t` in [0,1] and a curve definition,
 *  return the eased interpolation factor. The `linearValue` callback provides
 *  the result for linear curves (just `t` for most cases). */
export function interpolateCurve(
  t: number,
  curve: CurveData | undefined,
  linearValue: (t: number) => number
): number {
  if (curve === "stepped") return 0; // caller uses first keyframe
  if (curve === "linear" || typeof curve === "undefined") {
    return linearValue(t);
  }
  // Bezier array format: [c2, c3, c4, c5] = [cp1.x, cp1.y, cp2.x, cp2.y]
  if (Array.isArray(curve) && curve.length >= 4) {
    const [c2, c3, c4, c5] = curve as [number, number, number, number];
    const tb = solveBezierX(t, c2, c3, c4, c5);
    return bezierY(tb, c3, c5);
  }
  // Fallback for unrecognized formats
  return linearValue(t);
}

/* -------------------------------------------------------------------------- */
/*  Keyframe samplers (generic - works with any keyframe shape that has a time) */
/* -------------------------------------------------------------------------- */

/** Minimum interface a keyframe must implement to use the shared samplers. */
export interface GenericKeyframe {
  time: number;
  curve?: CurveData;
}

/** Find the pair of keyframes that bracket time `t`. Returns null if there
 *  are no keyframes. If `t` falls outside the keyframe range, returns the
 *  nearest keyframe for both a and b (clamped behavior). */
export function findKeyframePair<K extends GenericKeyframe>(
  keyframes: K[],
  t: number
): { a: K; b: K; t: number; stepped: boolean } | null {
  const n = keyframes.length;
  if (n === 0) return null;
  if (n === 1) return { a: keyframes[0]!, b: keyframes[0]!, t: 1, stepped: false };
  // Clamp to range
  if (t <= keyframes[0]!.time) return { a: keyframes[0]!, b: keyframes[0]!, t: 1, stepped: false };
  if (t >= keyframes[n - 1]!.time) return { a: keyframes[n - 1]!, b: keyframes[n - 1]!, t: 1, stepped: false };
  // Find surrounding pair
  for (let i = 0; i < n - 1; i++) {
    const a = keyframes[i]!;
    const b = keyframes[i + 1]!;
    if (a.time <= t && t < b.time) {
      const span = b.time - a.time;
      const local = span <= 0 ? 0 : (t - a.time) / span;
      const stepped = a.curve === "stepped";
      return { a, b, t: local, stepped };
    }
  }
  return { a: keyframes[n - 1]!, b: keyframes[n - 1]!, t: 1, stepped: false };
}

/** Sample a translate track (x, y values at each keyframe). */
export function sampleTranslate<K extends GenericKeyframe & { x?: number; y?: number }>(
  keyframes: K[],
  t: number
): { x: number; y: number } {
  const pair = findKeyframePair(keyframes, t);
  if (!pair) return { x: 0, y: 0 };
  const { a, b, t: local, stepped } = pair;
  const ax = a.x ?? 0, ay = a.y ?? 0;
  const bx = b.x ?? 0, by = b.y ?? 0;
  if (stepped) return { x: ax, y: ay };
  const eased = interpolateCurve(local, a.curve ?? "linear", (lt) => lt);
  return {
    x: ax + (bx - ax) * eased,
    y: ay + (by - ay) * eased,
  };
}

/** Sample a rotation track (angle in degrees). */
export function sampleRotate<K extends GenericKeyframe & { angle?: number; value?: number }>(
  keyframes: K[],
  t: number
): number {
  const pair = findKeyframePair(keyframes, t);
  if (!pair) return 0;
  const { a, b, t: local, stepped } = pair;
  const av = typeof a.angle === "number" ? a.angle : typeof a.value === "number" ? a.value : 0;
  const bv = typeof b.angle === "number" ? b.angle : typeof b.value === "number" ? b.value : 0;
  if (stepped) return av;
  const eased = interpolateCurve(local, a.curve ?? "linear", (lt) => lt);
  return av + (bv - av) * eased;
}

/** Sample a scale track (x, y scale factors). */
export function sampleScale<K extends GenericKeyframe & { x?: number; y?: number }>(
  keyframes: K[],
  t: number
): { x: number; y: number } {
  const pair = findKeyframePair(keyframes, t);
  if (!pair) return { x: 1, y: 1 };
  const { a, b, t: local, stepped } = pair;
  const ax = a.x ?? 1, ay = a.y ?? 1;
  const bx = b.x ?? 1, by = b.y ?? 1;
  if (stepped) return { x: ax, y: ay };
  const eased = interpolateCurve(local, a.curve ?? "linear", (lt) => lt);
  return {
    x: ax + (bx - ax) * eased,
    y: ay + (by - ay) * eased,
  };
}

/* -------------------------------------------------------------------------- */
/*  FK transform composition (Spine-compatible inheritance modes)             */
/* -------------------------------------------------------------------------- */

/** Bone inheritance modes - matches both editor and Spine format. */
export type InheritMode = "normal" | "noRotationOrReflection" | "noScaleOrReflection" | "onlyTranslation";

/** Compose a child bone's world transform from its parent's world transform
 *  and the child's local TRS matrix, respecting the bone's inheritance mode.
 *
 *  Modes (Spine 4.1 spec):
 *  - normal: full parent × local composition
 *  - noRotationOrReflection: inherits position (transformed by parent basis)
 *    but not rotation/scale; child's local TRS becomes world TRS for R/S
 *  - onlyTranslation: parent translation only, plus full local TRS
 *  - noScaleOrReflection: parent translation + rotation, child scale only
 *
 *  Uses raw Float32Array matrices (col-major: [a, b, c, d, tx, ty]). */
export function composeWorldFromParentRaw(
  out: Float32Array,
  parent: Float32Array,
  local: Float32Array,
  inherit: InheritMode
): void {
  const P = parent, L = local, M = out;
  if (inherit === "noRotationOrReflection") {
    // Spine 4.x's noRotationOrReflection mode: the bone inherits
    // its position offset (in the parent's *untransformed* local
    // frame) but not rotation / scale / reflection. We synthesize
    // an "R + T only" parent matrix by zeroing the rotation columns
    // and re-applying just tx/ty, but we transform the child's
    // position through the parent's full world basis.
    M[0] = L[0]!; M[1] = L[1]!;
    M[2] = L[2]!; M[3] = L[3]!;
    // Position: rotate child's local pos by parent's world matrix,
    // then add parent's translation:
    //   child_world_x = parent.a * local.tx + parent.c * local.ty + parent.tx
    //   child_world_y = parent.b * local.tx + parent.d * local.ty + parent.ty
    M[4] = P[0]! * L[4]! + P[2]! * L[5]! + P[4]!;
    M[5] = P[1]! * L[4]! + P[3]! * L[5]! + P[5]!;
    return;
  }
  if (inherit === "onlyTranslation") {
    // OnlyTranslation: no parent rotation or scale affects the child,
    // but the child's position is offset by the parent's world position.
    M[0] = L[0]!; M[1] = L[1]!;
    M[2] = L[2]!; M[3] = L[3]!;
    M[4] = P[4]! + L[4]!;
    M[5] = P[5]! + L[5]!;
    return;
  }
  if (inherit === "noScaleOrReflection") {
    // Inherit parent translation + rotation, but not scale.
    // We approximate by normalizing the parent's rotation basis vectors.
    const sx = Math.sqrt(P[0]! * P[0]! + P[1]! * P[1]!);
    const sy = Math.sqrt(P[2]! * P[2]! + P[3]! * P[3]!);
    if (sx > 1e-6 && sy > 1e-6) {
      const rs0 = P[0]! / sx, rs1 = P[1]! / sx;
      const rs2 = P[2]! / sy, rs3 = P[3]! / sy;
      M[0] = rs0 * L[0]! + rs2 * L[1]!;
      M[1] = rs1 * L[0]! + rs3 * L[1]!;
      M[2] = rs0 * L[2]! + rs2 * L[3]!;
      M[3] = rs1 * L[2]! + rs3 * L[3]!;
      M[4] = P[0]! * L[4]! + P[2]! * L[5]! + P[4]!;
      M[5] = P[1]! * L[4]! + P[3]! * L[5]! + P[5]!;
    } else {
      // Parent has zero scale - fall back to translation only.
      M.set(L);
      M[4] += P[4]!;
      M[5] += P[5]!;
    }
    return;
  }
  // Normal mode - full 3×2 matrix multiply: parent × local.
  const p00 = P[0]!, p01 = P[1]!, p10 = P[2]!, p11 = P[3]!, p20 = P[4]!, p21 = P[5]!;
  M[0] = p00 * L[0]! + p10 * L[1]!;
  M[1] = p01 * L[0]! + p11 * L[1]!;
  M[2] = p00 * L[2]! + p10 * L[3]!;
  M[3] = p01 * L[2]! + p11 * L[3]!;
  M[4] = p00 * L[4]! + p10 * L[5]! + p20;
  M[5] = p01 * L[4]! + p11 * L[5]! + p21;
}

