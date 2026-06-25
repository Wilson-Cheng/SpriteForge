// src/core/math.ts
// 2D affine transform helpers + a tiny Mat3 type. Spine uses 3x3 matrices
// (with the third row implicitly [0 0 1]) for transform composition, so we
// do the same. The structure is friendly to future GPU upload (we can dump
// the floats straight to a UBO).

export interface Mat3 {
  // Stored in column-major order to match WebGL conventions.
  // [ m00 m10 m20 ]   where m20/m21 are translation.
  // [ m01 m11 m21 ]
  // [  0   0   1  ]
  m: Float32Array; // length 6: [m00, m01, m10, m11, m20, m21]
}

export function mat3Identity(): Mat3 {
  return { m: new Float32Array([1, 0, 0, 1, 0, 0]) };
}

/** Compose `a` then `b` and return the result. Allocations are cheap but we
 *  reuse the output matrix when the caller can guarantee exclusive use. */
export function mat3Mul(a: Mat3, b: Mat3, out?: Mat3): Mat3 {
  const r = out ?? mat3Identity();
  const A = a.m, B = b.m, M = r.m;
  const a00 = A[0], a01 = A[1];
  const a10 = A[2], a11 = A[3];
  const a20 = A[4], a21 = A[5];
  const b00 = B[0], b01 = B[1];
  const b10 = B[2], b11 = B[3];
  const b20 = B[4], b21 = B[5];
  M[0] = a00 * b00 + a10 * b01;
  M[1] = a01 * b00 + a11 * b01;
  M[2] = a00 * b10 + a10 * b11;
  M[3] = a01 * b10 + a11 * b11;
  M[4] = a00 * b20 + a10 * b21 + a20;
  M[5] = a01 * b20 + a11 * b21 + a21;
  return r;
}

/** Build a transform from translation + rotation (degrees) + uniform scale. */
export function mat3FromTRS(tx: number, ty: number, rotDeg: number, scale: number = 1): Mat3 {
  const r = (rotDeg * Math.PI) / 180;
  const c = Math.cos(r) * scale;
  const s = Math.sin(r) * scale;
  return { m: new Float32Array([c, s, -s, c, tx, ty]) };
}

/** Build a transform from translation + rotation (degrees) + non-uniform
 *  scale (sx, sy). Used for bone pose composition where Spine-style
 *  scale tracks record separate X/Y values. Matrix layout matches
 *  mat3FromTRS: [a, b, c, d, tx, ty] = [cos*sx, sin*sx, -sin*sy, cos*sy, tx, ty]. */
export function mat3FromTRSS(tx: number, ty: number, rotDeg: number, sx: number, sy: number): Mat3 {
  const r = (rotDeg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { m: new Float32Array([c * sx, s * sx, -s * sy, c * sy, tx, ty]) };
}

export function mat3Copy(src: Mat3, dst?: Mat3): Mat3 {
  const r = dst ?? mat3Identity();
  r.m.set(src.m);
  return r;
}

export function mat3Invert(m: Mat3, out?: Mat3): Mat3 {
  const r = out ?? mat3Identity();
  const a = m.m[0], b = m.m[1];
  const c = m.m[2], d = m.m[3];
  const tx = m.m[4], ty = m.m[5];
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) {
    r.m.set([1, 0, 0, 1, -tx, -ty]);
    return r;
  }
  const inv = 1 / det;
  r.m[0] = d * inv;
  r.m[1] = -b * inv;
  r.m[2] = -c * inv;
  r.m[3] = a * inv;
  r.m[4] = (c * ty - d * tx) * inv;
  r.m[5] = (b * tx - a * ty) * inv;
  return r;
}

/** Distance from point (px, py) to segment (ax, ay) -> (bx, by). Used by the
 *  bone-hit testing in the viewport. */
export function distPointSegment(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) {
    const ex = px - ax, ey = py - ay;
    return Math.sqrt(ex * ex + ey * ey);
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx, qy = ay + t * dy;
  const ex = px - qx, ey = py - qy;
  return Math.sqrt(ex * ex + ey * ey);
}

/** Apply a Mat3 to a 2D point and return `(out_x, out_y)`. Equivalent to
 *  the inline expression `[m[0]*x + m[2]*y + m[4], m[1]*x + m[3]*y + m[5]]`
 *  used throughout the editor / runtime. The `m[i] ?? 0` fallbacks the
 *  callers historically used are unnecessary here — `Mat3.m` is always a
 *  length-6 Float32Array, so every index is defined. */
export function transformPoint(mat: Mat3, x: number, y: number): { x: number; y: number } {
  const m = mat.m;
  return {
    x: m[0]! * x + m[2]! * y + m[4]!,
    y: m[1]! * x + m[3]! * y + m[5]!,
  };
}

/** Return the (x, y) translation column of a Mat3 — i.e. the world
 *  position the matrix maps the local origin to. */
export function originOf(mat: Mat3): { x: number; y: number } {
  const m = mat.m;
  return { x: m[4]!, y: m[5]! };
}

/** Clamp `v` to [lo, hi]. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Convert radians to degrees. */
export function radToDeg(r: number): number { return (r * 180) / Math.PI; }

/** Convert degrees to radians. */
export function degToRad(d: number): number { return (d * Math.PI) / 180; }

/** Decompose a 2D affine matrix into translation, rotation (degrees),
 *  and non-uniform scale. This is the inverse of `mat3FromTRSS`.
 *  Scale is taken as positive magnitudes; rotation is derived from the
 *  first column. Used when reparenting a bone while preserving its
 *  world-space transform. */
export function mat3DecomposeTRSS(mat: Mat3): { x: number; y: number; rotation: number; scaleX: number; scaleY: number } {
  const m = mat.m;
  const a = m[0]!, b = m[1]!, c = m[2]!, d = m[3]!;
  const x = m[4]!, y = m[5]!;
  const scaleX = Math.sqrt(a * a + b * b);
  const scaleY = Math.sqrt(c * c + d * d);
  const rotation = scaleX > 1e-12 ? radToDeg(Math.atan2(b, a)) : 0;
  return { x, y, rotation, scaleX, scaleY };
}
