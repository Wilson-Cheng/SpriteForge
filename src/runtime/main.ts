// src/runtime/main.ts
// Standalone Spine 4.1 player. Renders the .json + .atlas + .png bundle
// produced by the editor's "Export" button. Self-contained: no
// dependencies, ~12 KB minified, runs in a single <canvas>.
//
// Usage:
//   - Open runtime.html in a browser.
//   - Drag-drop a .json + .atlas + .png triple onto the page (or click
//     the "Load" button to pick files).
//   - The animation auto-plays on loop. Space pauses/plays. Arrow
//     keys / animation dropdown switch animations.
//
// Renderer: WebGL2 with a single linear-blend-skinning shader. We
// re-evaluate the skeleton each frame, sample the active animation
// with bezier curves, upload the deformed mesh + bone matrices, and
// draw. Bones without an active animation draw in their bind pose.

import type { SpineJson, Atlas, SpineSlot, SpineAnimation, SpineAttachment } from "./spine-types";
import { solveBezierX, bezierY, interpolateCurve, composeWorldFromParentRaw, type CurveData, type InheritMode } from "../core/animation";

/** Render a fatal-error dialog that matches the editor's modal style.
 *  The runtime is a standalone artifact that ships to consumers, so
 *  this is inlined rather than imported from the editor's modal.ts. */
function showFatal(message: string): void {
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(10,12,18,0.65);display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;color:#e4e6eb;backdrop-filter:blur(2px);";
  const box = document.createElement("div");
  box.style.cssText = "background:#1a1d24;border:1px solid #3a4054;border-radius:8px;padding:18px 22px;min-width:280px;max-width:480px;box-shadow:0 10px 40px rgba(0,0,0,0.5);";
  const title = document.createElement("div");
  title.style.cssText = "font-size:13px;font-weight:600;margin-bottom:10px;";
  title.textContent = "Runtime error";
  const body = document.createElement("pre");
  body.style.cssText = "font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;background:#14171e;border:1px solid #2a2f3d;border-radius:4px;padding:8px 10px;margin:0 0 12px 0;";
  body.textContent = message;
  const btn = document.createElement("button");
  btn.textContent = "Close";
  btn.style.cssText = "background:#5b9cff;color:#fff;border:1px solid #7eb3ff;border-radius:4px;padding:6px 16px;cursor:pointer;font:inherit;float:right;";
  btn.addEventListener("click", () => overlay.remove());
  box.appendChild(title);
  box.appendChild(body);
  box.appendChild(btn);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

const ATELIER_LOGO = "SpriteForge Runtime";

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const canvas = $("canvas") as HTMLCanvasElement;
const glCtx = canvas.getContext("webgl2", {
  antialias: true,
  premultipliedAlpha: true,
  // Preserve the drawing buffer across the browser's frame presentation.
  // Without this, the back buffer is cleared to (0, 0, 0, 0) after the
  // compositor presents each frame, which makes `gl.readPixels` (and any
  // async screenshot tooling) return a transparent canvas even though
  // the runtime is drawing correctly. Standard for demo players.
  preserveDrawingBuffer: true,
});
if (!glCtx) {
  showFatal("Your browser does not support WebGL2. Runtime requires WebGL2.");
  throw new Error("WebGL2 not supported");
}
const gl: WebGL2RenderingContext = glCtx;

/* -------------------------------------------------------------------------- */
/*  GLSL                                                                      */
/* -------------------------------------------------------------------------- */

const VERT = `#version 300 es
precision highp float;
in vec2 a_pos;        // mesh-local (bone-local) vertex position
in vec2 a_uv;
in vec4 a_bones;      // up to 4 bone indices
in vec4 a_weights;
uniform mat3 u_bones[32];
uniform mat3 u_projection;
uniform vec2 u_pan;         // screen-space pan (pixels, Y-down)
uniform float u_zoom;       // world-to-screen scale
out vec2 v_uv;
void main() {
  // Deform: each bone weight contributes its transformed position.
  // Note: a_bones stores mat3 array *indices* (floats cast to indices).
  mat3 m0 = u_bones[int(a_bones.x)];
  mat3 m1 = u_bones[int(a_bones.y)];
  mat3 m2 = u_bones[int(a_bones.z)];
  mat3 m3 = u_bones[int(a_bones.w)];
  // m * (x, y, 1) — col-major with translation at .m[4], .m[5]
  vec3 p0 = m0 * vec3(a_pos, 1.0);
  vec3 p1 = m1 * vec3(a_pos, 1.0);
  vec3 p2 = m2 * vec3(a_pos, 1.0);
  vec3 p3 = m3 * vec3(a_pos, 1.0);
  vec3 p = p0 * a_weights.x + p1 * a_weights.y + p2 * a_weights.z + p3 * a_weights.w;
  // The skeleton lives in Spine's Y-up world (positive y = up). The
  // screen is Y-down, so we negate y when applying the view transform.
  // pan/zoom are pre-computed in JS (computeViewTransform) so the
  // skeleton's bounding box lands centred on the canvas.
  vec2 screen = vec2(p.x, -p.y) * u_zoom + u_pan;
  vec3 q = u_projection * vec3(screen, 1.0);
  gl_Position = vec4(q.xy, 0.0, 1.0);
  v_uv = a_uv;
}`;

const FRAG = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_atlas;
out vec4 fragColor;
void main() {
  vec4 c = texture(u_atlas, v_uv);
  if (c.a < 0.01) discard;
  fragColor = c;
}`;

/* -------------------------------------------------------------------------- */
/*  GL boilerplate                                                            */
/* -------------------------------------------------------------------------- */

function compileShader(src: string, type: number): WebGLShader {
  const s = gl!.createShader(type)!;
  gl!.shaderSource(s, src);
  gl!.compileShader(s);
  if (!gl!.getShaderParameter(s, gl!.COMPILE_STATUS)) {
    const log = gl!.getShaderInfoLog(s);
    throw new Error(`Shader compile failed: ${log}`);
  }
  return s;
}

const program = gl.createProgram()!;
gl.attachShader(program, compileShader(VERT, gl.VERTEX_SHADER));
gl.attachShader(program, compileShader(FRAG, gl.FRAGMENT_SHADER));
gl.linkProgram(program);
if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
  throw new Error(`Program link failed: ${gl.getProgramInfoLog(program)}`);
}
gl.useProgram(program);
gl.disable(gl.DEPTH_TEST);
gl.enable(gl.BLEND);
gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

const aPos     = gl.getAttribLocation(program, "a_pos");
const aUv      = gl.getAttribLocation(program, "a_uv");
const aBones   = gl.getAttribLocation(program, "a_bones");
const aWeights = gl.getAttribLocation(program, "a_weights");
const uBones    = gl.getUniformLocation(program, "u_bones[0]");
const uProjection = gl.getUniformLocation(program, "u_projection");
const uPan = gl.getUniformLocation(program, "u_pan");
const uZoom = gl.getUniformLocation(program, "u_zoom");
const uAtlas = gl.getUniformLocation(program, "u_atlas");

/* -------------------------------------------------------------------------- */
/*  WebGL utilities                                                           */
/* -------------------------------------------------------------------------- */

interface BufferRefs {
  vbo: WebGLBuffer;
  ibo: WebGLBuffer;
  indexCount: number;
  texture: WebGLTexture;
  // For each vertex: 2 floats pos, 2 floats uv, 4 floats bones, 4 floats weights.
  // Stride: 12 floats.
  vertices: Float32Array;
  indices: Uint16Array;
  boneMatrixBase: number; // first bone index (used for the bone matrix uniform)
}

function createBuffer(): WebGLBuffer {
  const b = gl.createBuffer()!;
  return b;
}

function createTexture(): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

/* -------------------------------------------------------------------------- */
/*  Math: Spine uses Y-down (the editor is Y-down too).                       */
/*  Mat3 is column-major with [m00, m01, m10, m11, tx, ty] (6 elements).      */
/* -------------------------------------------------------------------------- */

type Mat3 = Float32Array; // length 6

function mat3Identity(): Mat3 { return new Float32Array([1, 0, 0, 1, 0, 0]); }

function mat3Multiply(out: Mat3, a: Mat3, b: Mat3): void {
  // [a00 a01 a10 a11 tx ty] * [b00 b01 b10 b11 bx by]
  // result is column-major: [r00 r01 r10 r11 rtx rty]
  const a00 = a[0], a01 = a[2], a10 = a[1], a11 = a[3], atx = a[4], aty = a[5];
  const b00 = b[0], b01 = b[2], b10 = b[1], b11 = b[3], btx = b[4], bty = b[5];
  out[0] = a00 * b00 + a01 * b10;             // m00
  out[1] = a10 * b00 + a11 * b10;             // m10
  out[2] = a00 * b01 + a01 * b11;             // m01
  out[3] = a10 * b01 + a11 * b11;             // m11
  out[4] = a00 * btx + a01 * bty + atx;       // tx
  out[5] = a10 * btx + a11 * bty + aty;       // ty
}

function mat3FromPose(pose: { x: number; y: number; rotation: number; scaleX: number; scaleY: number }): Mat3 {
  const rad = pose.rotation * Math.PI / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  // T * R * S
  return new Float32Array([
    pose.scaleX * c,  pose.scaleX * s,
    pose.scaleY * -s, pose.scaleY * c,
    pose.x, pose.y,
  ]);
}

function composeWorldFromParent(out: Mat3, parent: Mat3, local: Mat3, inherit: InheritMode): void {
  composeWorldFromParentRaw(out, parent, local, inherit);
}

function flattenMat3(m: Mat3, out: Float32Array, offset: number): void {
  // GLSL mat3 expects 9 floats (col-major), with [0 0 1] as the third row
  // since our Mat3 is 6-elt col-major with implicit third row.
  out[offset + 0] = m[0];
  out[offset + 1] = m[1];
  out[offset + 2] = 0;
  out[offset + 3] = m[2];
  out[offset + 4] = m[3];
  out[offset + 5] = 0;
  out[offset + 6] = m[4];
  out[offset + 7] = m[5];
  out[offset + 8] = 1;
}

/* -------------------------------------------------------------------------- */
/*  Bezier curves (Spine format: [c2, c3, c4, c5] = cp1, cp2, implicit 0,1)   */
/* -------------------------------------------------------------------------- */

type Curve = CurveData;

interface BoneRuntime {
  name: string;
  parent: string | null;
  length: number;
  /** Local TRS rest pose. */
  rest: { x: number; y: number; rotation: number; scaleX: number; scaleY: number };
  /** Spine `inherit` mode. The default is "normal" — full inheritance
   *  from the parent. "noRotationOrReflection" and "onlyTranslation"
   *  strip the parent's rotation/scale from the world composition;
   *  the official Spine `hero` sample uses one of these for the foot
   *  bones so the feet stay pointing down regardless of leg
   *  rotation. */
  inherit: InheritMode;
  /** Cached world matrix from previous frame, used as the parent for
   *  this frame's local × parent composition. */
  world: Mat3;
}

interface Skeleton {
  spine: SpineJson;
  atlas: Atlas;
  atlasTexture: WebGLTexture;
  boneMap: Map<string, BoneRuntime>;
  slotOrder: SpineSlot[];
  attachments: Map<string, BufferRefs>;
  animations: Map<string, SpineAnimation>;
  boneMatrixBuf: Float32Array;
  globalBindPose: Map<string, Mat3>;
}

function buildBoneMap(skeleton: SpineJson): Map<string, BoneRuntime> {
  const map = new Map<string, BoneRuntime>();
  // First pass: insert all bones.
  for (const b of skeleton.bones) {
    map.set(b.name, {
      name: b.name,
      parent: b.parent ?? null,
      length: b.length ?? 0,
      rest: {
        x: b.x ?? 0,
        y: b.y ?? 0,
        rotation: b.rotation ?? 0,
        scaleX: b.scaleX ?? 1,
        scaleY: b.scaleY ?? 1,
      },
      inherit: b.inherit ?? "normal",
      world: mat3Identity(),
    });
  }
  // Second pass: build rest world matrices in root-first order.
  // We honour the `inherit` field per the Spine 4.x spec:
  //   - "normal" (default): world = parentWorld × localRest
  //   - "noRotationOrReflection" / "onlyTranslation":
  //       world = T(parentWorld.tx, parentWorld.ty) × localRest
  //       i.e. the parent's translation is inherited but not its
  //       rotation/scale. The official Spine `hero` sample uses this
  //       for the foot bones so the feet stay pointing straight down
  //       regardless of how the shins rotate.
  //   - "noScaleOrReflection":
  //       world = parentWorldTranslationOnly × R(parentWorldRot) × localRest
  //       — we approximate by composing the parent's rotation around
  //       its own head but stripping its scale. For the typical Spine
  //       project (uniform scale) this is identical to inheriting
  //       rotation only. (A more precise implementation would extract
  //       the rotation via polar decomposition; not needed for the
  //       sample data we ship.)
  for (const b of skeleton.bones) {
    const runtime = map.get(b.name)!;
    if (b.parent) {
      const parentRuntime = map.get(b.parent)!;
      const local = mat3FromPose(runtime.rest);
      composeWorldFromParent(runtime.world, parentRuntime.world, local, runtime.inherit);
    } else {
      runtime.world = mat3FromPose(runtime.rest);
    }
  }
  return map;
}

/* -------------------------------------------------------------------------- */
/*  Atlas parser (Spine 4.1 .atlas text format)                                */
/* -------------------------------------------------------------------------- */

function parseAtlas(text: string): Atlas {
  const lines = text.split(/\r?\n/);
  const atlas: Atlas = { pages: [], regions: [] };
  let i = 0;
  // First non-empty line is the page name.
  while (i < lines.length && !lines[i].trim()) i++;
  if (i >= lines.length) return atlas;
  const pageName = lines[i].trim();
  // We don't actually load the PNG by file path here — the user
  // dropped the .png separately and we got it from a File handle.
  // The page record is built when we get the image.
  atlas.pages.push({ name: pageName, size: { w: 0, h: 0 } });
  i++;
  // Spine atlases are whitespace-tolerant: the official Spine editor
  // emits TAB-indented header/region lines, while hand-rolled atlases
  // often use spaces. The original runtime's `startsWith(" ")` and
  // `/^(\w+):/` regexes silently dropped tab-indented lines — which
  // is what the `samples/hero.atlas` file uses — and produced an
  // empty atlas with no regions, so every attachment was skipped.
  // We now treat any leading whitespace as indentation.
  const isIndented = (s: string): boolean => /^\s/.test(s);
  // Parse page-level properties. Spine atlases can have a blank line
  // between the header and the first region (the editor-export
  // format) OR no blank line (the official Spine editor format — see
  // `samples/hero.atlas`). We stop as soon as we hit a line that
  // ISN'T a `key: value` pair, treating it as the first region name.
  while (i < lines.length) {
    const raw = lines[i]!;
    if (!raw.trim()) { i++; continue; } // blank → keep looking
    const m = raw.match(/^\s*(\w+):\s*(.+)$/);
    if (!m) break; // not a header line → it's a region name
    const [, k, v] = m;
    if (k === "size") {
      const [w, h] = v.split(",").map((s) => parseInt(s.trim(), 10));
      atlas.pages[0].size = { w, h };
    }
    i++;
  }
  // Parse region blocks. Each region is a non-indented name line
  // followed by zero or more indented `key: value` lines. The
  // official Spine atlas format has NO blank line between regions
  // (just a non-indented name starting a new block), while the
  // editor-export format separates regions with blank lines. The
  // parser below handles both: we treat a non-indented non-blank
  // line as the start of a new region.
  while (i < lines.length) {
    const raw = lines[i]!;
    if (!raw.trim()) { i++; continue; } // blank → skip
    if (isIndented(raw)) {
      // Stray indented line with no region name. Skip defensively.
      i++;
      continue;
    }
    const regionName = raw.trim();
    i++;
    const region: any = { name: regionName };
    while (i < lines.length && isIndented(lines[i])) {
      const m = lines[i].match(/^\s+(\w+):\s*(.+)$/);
      if (m) {
        const [, k, v] = m;
        if (k === "bounds") {
          const [x, y, w, h] = v.split(",").map((s) => parseInt(s.trim(), 10));
          Object.assign(region, { x, y, w, h });
        } else if (k === "rotate") {
          region.rotate = v.trim() === "true";
        } else if (k === "index") {
          region.index = parseInt(v.trim(), 10);
        } else if (k === "offsets") {
          // The official Spine atlas format emits `offsets: l,t,r,b`
          // for region attachments. We don't currently use it (the
          // runtime draws the full region) but we parse it so a
          // future pass can honour trimmed regions.
          const parts = v.split(",").map((s) => parseInt(s.trim(), 10));
          region.offsets = { l: parts[0], t: parts[1], r: parts[2], b: parts[3] };
        }
      }
      i++;
    }
    atlas.regions.push(region);
  }
  return atlas;
}

/* -------------------------------------------------------------------------- */
/*  Animation sampling                                                        */
/* -------------------------------------------------------------------------- */

interface AnimationPose {
  bones: Map<string, { x: number; y: number; rotation: number; scaleX: number; scaleY: number }>;
}

/** Find the surrounding keyframe pair `(a, b)` for time `t` in a
 *  monotonically increasing keyframe array, plus the eased local
 *  progress in [0, 1] from `a` toward `b`. Returns `null` when there
 *  are no keys. When `t` falls before / after the range, the local
 *  progress is 0 (or 1) so the caller's lerp returns the boundary key
 *  exactly — same semantics as the original three sample helpers. */
function keyTime(k: { time?: number }): number {
  return typeof k.time === "number" ? k.time : 0;
}

function findKeyframePair<K extends { time?: number; curve?: Curve }>(
  keys: K[],
  t: number,
): { a: K; b: K; local: number; stepped: boolean } | null {
  if (keys.length === 0) return null;
  if (t <= keyTime(keys[0]!)) return { a: keys[0]!, b: keys[0]!, local: 0, stepped: false };
  const last = keys[keys.length - 1]!;
  if (t >= keyTime(last)) return { a: last, b: last, local: 1, stepped: false };
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]!, b = keys[i + 1]!;
    const at = keyTime(a);
    const bt = keyTime(b);
    if (t >= at && t <= bt) {
      const dur = bt - at;
      const linear = dur > 0 ? (t - at) / dur : 0;
      if (a.curve === "stepped") return { a, b, local: 0, stepped: true };
      const isBezier = Array.isArray(a.curve)
        && a.curve.length === 4
        && Math.abs(a.curve[1] ?? 0) <= 2
        && Math.abs(a.curve[3] ?? 1) <= 2;
      const eased = isBezier
        ? interpolateCurve(linear, a.curve as Curve, (tt) => tt)
        : linear;
      return { a, b, local: eased, stepped: false };
    }
  }
  return { a: last, b: last, local: 1, stepped: false };
}

function sampleTranslate(
  keys: Array<{ time?: number; x?: number; y?: number; curve?: Curve }>,
  t: number
): { x: number; y: number } {
  const pair = findKeyframePair(keys, t);
  if (!pair) return { x: 0, y: 0 };
  const { a, b, local, stepped } = pair;
  const ax = a.x ?? 0, ay = a.y ?? 0;
  const bx = b.x ?? 0, by = b.y ?? 0;
  if (stepped) return { x: ax, y: ay };
  return { x: ax + (bx - ax) * local, y: ay + (by - ay) * local };
}

function rotateValue(k: { angle?: number; value?: number }): number {
  if (typeof k.angle === "number") return k.angle;
  if (typeof k.value === "number") return k.value;
  return 0;
}

function sampleRotate(
  keys: Array<{ time?: number; angle?: number; value?: number; curve?: Curve }>,
  t: number
): number {
  const pair = findKeyframePair(keys, t);
  if (!pair) return 0;
  const { a, b, local, stepped } = pair;
  const av = rotateValue(a);
  if (stepped) return av;
  return av + (rotateValue(b) - av) * local;
}

function sampleScale(
  keys: Array<{ time?: number; x?: number; y?: number; curve?: Curve }>,
  t: number
): { x: number; y: number } {
  const pair = findKeyframePair(keys, t);
  if (!pair) return { x: 1, y: 1 };
  const { a, b, local, stepped } = pair;
  const ax = a.x ?? 1, ay = a.y ?? 1;
  const bx = b.x ?? 1, by = b.y ?? 1;
  if (stepped) return { x: ax, y: ay };
  return { x: ax + (bx - ax) * local, y: ay + (by - ay) * local };
}

/* -------------------------------------------------------------------------- */
/*  Setup                                                                     */
/* -------------------------------------------------------------------------- */

let skeleton: Skeleton | null = null;
let activeAnimation: string | null = null;
let currentTime = 0;
let isPlaying = true;
let lastT = 0;

/** View transform that maps the Spine Y-up world to screen pixels.
 *  Set by computeViewTransform() and uploaded each frame as
 *  u_pan / u_zoom. The vertex shader applies `v = world * zoom + pan`
 *  (with the Y-flip baked into the pan/zoom math) before the
 *  screen-to-NDC projection. */
let viewPanX = 0;
let viewPanY = 0;
let viewZoom = 1;

/** Compute the skeleton's world-space bounding box by walking the
 *  bone hierarchy in bind pose. Returns the tight AABB of every bone
 *  head and tail. If there are no bones, falls back to a 100×100
 *  box at the origin so the view transform still produces a sane
 *  output. */
type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

function emptyBounds(): Bounds {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

function includePoint(bounds: Bounds, x: number, y: number): void {
  if (!isFinite(x) || !isFinite(y)) return;
  bounds.minX = Math.min(bounds.minX, x);
  bounds.maxX = Math.max(bounds.maxX, x);
  bounds.minY = Math.min(bounds.minY, y);
  bounds.maxY = Math.max(bounds.maxY, y);
}

function isValidBounds(bounds: Bounds): boolean {
  return isFinite(bounds.minX) && isFinite(bounds.minY) && isFinite(bounds.maxX) && isFinite(bounds.maxY);
}

function computeSkeletonBounds(): Bounds {
  if (!skeleton) return { minX: -50, minY: -50, maxX: 50, maxY: 50 };
  const bounds = emptyBounds();
  for (const [name, bone] of skeleton.boneMap) {
    const w = skeleton.globalBindPose.get(name) ?? bone.world;
    const hx = w[4]!, hy = w[5]!;
    includePoint(bounds, hx, hy);
    const len = bone.length;
    if (len > 0) {
      includePoint(bounds, hx + len * w[0]!, hy + len * w[1]!);
    }
  }
  return isValidBounds(bounds) ? bounds : { minX: -50, minY: -50, maxX: 50, maxY: 50 };
}

function transformPointByMat(m: Mat3, x: number, y: number): { x: number; y: number } {
  return {
    x: m[0]! * x + m[2]! * y + m[4]!,
    y: m[1]! * x + m[3]! * y + m[5]!,
  };
}

function computeAttachmentBounds(): Bounds | null {
  if (!skeleton) return null;
  const boneMats = Array.from(skeleton.boneMap.keys()).map((name) => skeleton!.globalBindPose.get(name) ?? skeleton!.boneMap.get(name)!.world);
  const bounds = emptyBounds();
  for (const ref of skeleton.attachments.values()) {
    const data = ref.vertices;
    const vCount = Math.floor(data.length / 12);
    for (let i = 0; i < vCount; i++) {
      const base = i * 12;
      const x = data[base + 0]!;
      const y = data[base + 1]!;
      let wx = 0;
      let wy = 0;
      let totalWeight = 0;
      for (let k = 0; k < 4; k++) {
        const weight = data[base + 8 + k] ?? 0;
        if (weight <= 0) continue;
        const mat = boneMats[Math.max(0, Math.floor(data[base + 4 + k] ?? 0))];
        if (!mat) continue;
        const p = transformPointByMat(mat, x, y);
        wx += p.x * weight;
        wy += p.y * weight;
        totalWeight += weight;
      }
      if (totalWeight > 0) includePoint(bounds, wx, wy);
    }
  }
  return isValidBounds(bounds) ? bounds : null;
}

function computeRenderBounds(): Bounds {
  const skeletonBounds = computeSkeletonBounds();
  const attachmentBounds = computeAttachmentBounds();
  if (!attachmentBounds) return skeletonBounds;
  return {
    minX: Math.min(skeletonBounds.minX, attachmentBounds.minX),
    minY: Math.min(skeletonBounds.minY, attachmentBounds.minY),
    maxX: Math.max(skeletonBounds.maxX, attachmentBounds.maxX),
    maxY: Math.max(skeletonBounds.maxY, attachmentBounds.maxY),
  };
}

function resizeCanvasToRenderBounds(projectW: number, projectH: number): void {
  const pad = 80;
  const bounds = computeRenderBounds();
  const visualW = Math.ceil(Math.max(1, bounds.maxX - bounds.minX) + pad);
  const visualH = Math.ceil(Math.max(1, bounds.maxY - bounds.minY) + pad);
  canvas.width = Math.max(Math.ceil(projectW), visualW);
  canvas.height = Math.max(Math.ceil(projectH), visualH);
}

/** Recompute the view transform to fit the rendered attachment bounds
 *  into the canvas with padding. This uses bind-pose attachment bounds
 *  instead of current animation bounds so playback does not zoom in/out. */
function computeViewTransform(): void {
  if (!skeleton) return;
  const cw = canvas.width || 512;
  const ch = canvas.height || 512;
  const pad = 40;
  const { minX, minY, maxX, maxY } = computeRenderBounds();
  const bw = Math.max(1, maxX - minX);
  const bh = Math.max(1, maxY - minY);
  const sx = (cw - pad * 2) / bw;
  const sy = (ch - pad * 2) / bh;
  viewZoom = Math.min(sx, sy, 8);
  const cxW = (minX + maxX) / 2;
  const cyW = (minY + maxY) / 2;
  viewPanX = cw / 2 - cxW * viewZoom;
  viewPanY = ch / 2 + cyW * viewZoom;
}

/** Animation crossfade state (FR-TA-7 — P2.G).
 *  When `setAnimation(name, { mix: 0.2 })` is called, we keep the old
 *  animation's name in `fromAnim` for `mixDuration` seconds, lerping
 *  the deltas at each evaluatePose. Once mix is done, `fromAnim` clears
 *  and we sample only `activeAnimation`. */
let fromAnim: string | null = null;
let mixDuration = 0;
let mixElapsed = 0;

/** Public API: switch to a different animation, optionally crossfading.
 *
 *   `mix` is the duration in seconds to interpolate from the current
 *   animation to the target. Default 0 = snap-switch. `time` lets the
 *   caller jump to a specific point in the new animation; default 0.
 *   `loop` controls whether playback wraps at duration; default true.
 *
 *   This is the editor's recommended path for game integrators: the
 *   exported runtime is a self-contained `runtime.html` that loads
 *   3 files and exposes this function on `window.spriteforge`. Games
 *   chain multiple calls (`setAnimation('walk', {mix: 0.2})` →
 *   `setAnimation('attack', {mix: 0.1})`) to blend transitions. */
function setAnimation(
  name: string,
  opts: { mix?: number; time?: number; loop?: boolean } = {},
): boolean {
  if (!skeleton || !skeleton.animations.has(name)) {
    console.warn(`[runtime] setAnimation: unknown animation "${name}"`);
    return false;
  }
  if (activeAnimation === name && (opts.mix ?? 0) === 0) {
    // Same animation, no mix — just respect the time/loop overrides.
    if (typeof opts.time === "number") currentTime = opts.time;
    return true;
  }
  fromAnim = activeAnimation;
  mixDuration = Math.max(0, opts.mix ?? 0);
  mixElapsed = 0;
  activeAnimation = name;
  if (typeof opts.time === "number") currentTime = opts.time;
  return true;
}

/** Resolve the project width/height from a Spine JSON. Spine 4.1 puts
 *  them at the top level; Spine 4.x sometimes only puts them inside
 *  `skeleton`. Default to 512 if both are missing. */
function resolveProjectSize(spine: SpineJson): { w: number; h: number } {
  const w = (typeof spine.width === "number" && spine.width > 0)
    ? spine.width
    : (typeof spine.skeleton?.width === "number" && spine.skeleton.width > 0
        ? spine.skeleton.width
        : 512);
  const h = (typeof spine.height === "number" && spine.height > 0)
    ? spine.height
    : (typeof spine.skeleton?.height === "number" && spine.skeleton.height > 0
        ? spine.skeleton.height
        : 512);
  return { w, h };
}

/** Normalise `spine.skins` to the object form
 *  `{ [skinName]: { [slotName]: { [attName]: att } } }`. The Spine 4.1
 *  editor export uses the object form directly; the official Spine
 *  editor (and the `samples/hero.json` file) emits an array of
 *  `{ name, attachments }` records instead. */
function normaliseSkins(spine: SpineJson): Record<string, Record<string, Record<string, SpineAttachment>>> {
  if (Array.isArray(spine.skins)) {
    const out: Record<string, Record<string, Record<string, SpineAttachment>>> = {};
    for (const sk of spine.skins) {
      if (!sk || typeof sk.name !== "string") continue;
      out[sk.name] = sk.attachments ?? {};
    }
    return out;
  }
  return spine.skins as Record<string, Record<string, Record<string, SpineAttachment>>>;
}

/** Detect the editor's own export format so we can Y-flip it on load.
 *  The editor writes `width` / `height` at the TOP level of the JSON
 *  (not inside `skeleton`) and uses `"spine": "4.1.0"`. Standard
 *  Spine 4.x files (e.g. the `samples/hero.json` from the official
 *  Spine editor) put width/height inside `skeleton` and use a
 *  different version string. The runtime uses Spine's standard
 *  Y-up convention; the editor's export is in its internal Y-down
 *  convention and needs to be flipped to render correctly. */
function isEditorExport(spine: SpineJson): boolean {
  // The editor writes top-level width/height. The standard Spine
  // editor puts them inside `skeleton`. Either-or is allowed in the
  // type but in practice the editor always sets the top-level form.
  const hasTopLevelSize = typeof spine.width === "number" || typeof spine.height === "number";
  const hasSkeletonSize = typeof spine.skeleton?.width === "number" || typeof spine.skeleton?.height === "number";
  return hasTopLevelSize && !hasSkeletonSize;
}

/** Y-flip the editor's Y-down export to Spine's Y-up convention and
 *  re-centre the origin. The editor's project stores bones in
 *  Y-down pixel coordinates with the origin at the top-left of the
 *  canvas (x in [0, w], y in [0, h]). Spine's convention is
 *  Y-up with the origin at the centre of the project area
 *  (x in [-w/2, w/2], y in [-h/2, h/2]). This helper:
 *    1. Y-flips every bone y, rotation, keyframe translate y,
 *       keyframe rotation, mesh vertex y, and region offset y.
 *    2. Shifts only root bones by (-w/2, +h/2) so the editor's
 *       top-left origin lands at Spine's centre. Child bones remain
 *       parent-local, so only their Y offsets are flipped.
 *  Mutates the SpineJson in place. UVs and scaleY are left alone
 *  (the texture is uploaded with UNPACK_FLIP_Y_WEBGL=true so the UV
 *  convention matches, and a negative scaleY still means the same
 *  vertical reflection). */
function yFlipEditorExport(spine: SpineJson, projectW: number, projectH: number): void {
  // Convert from the editor's Y-down pixel coords (origin top-left,
  // y in [0, projectH]) to Spine's Y-up centred coords (origin at
  // the centre of the project, y in [-projectH/2, +projectH/2]):
  //   spineX = editorX - projectW / 2
  //   spineY = projectH / 2 - editorY
  const halfW = projectW / 2;
  const halfH = projectH / 2;
  for (const b of spine.bones) {
    if (b.parent) {
      b.y = -(b.y ?? 0);
    } else {
      b.x = (b.x ?? 0) - halfW;
      b.y = halfH - (b.y ?? 0);
    }
    b.rotation = -(b.rotation ?? 0);
  }
  if (spine.animations) {
    for (const anim of Object.values(spine.animations)) {
      if (!anim.bones) continue;
      for (const tracks of Object.values(anim.bones)) {
        if (tracks.translate) {
          for (const k of tracks.translate) {
            k.x = k.x;
            k.y = -k.y;
          }
        }
        if (tracks.rotate) {
          for (const k of tracks.rotate as Array<{ angle?: number; value?: number }>) {
            if (typeof k.angle === "number") k.angle = -k.angle;
            if (typeof k.value === "number") k.value = -k.value;
          }
        }
      }
    }
  }
  for (const slotAtt of Object.values(spine.skins as Record<string, Record<string, Record<string, any>>>)) {
    for (const att of Object.values(slotAtt)) {
      // Region attachment offsets are in Spine Y-up relative to the
      // bone head. No centre shift — just the Y-flip.
      if (att && (att.type === "region" || att.type === undefined)) {
        if (typeof att.y === "number") att.y = -att.y;
        if (typeof att.rotation === "number") att.rotation = -att.rotation;
      }
      // Mesh attachment vertices are in bone-local space.
      if (att && att.type === "mesh") {
        if (Array.isArray(att.vertices) && att.vertices.length % 2 === 0) {
          for (let i = 1; i < att.vertices.length; i += 2) {
            att.vertices[i] = -(att.vertices[i] as number);
          }
        }
      }
    }
  }
  // The halfW/halfH variables are intentionally unused after the
  // bone-loop above; the x-axis is already aligned (both Spine and
  // the editor use +X to the right), and the keyframe/mesh/region
  // transforms only need the Y-flip.
  void halfW; void halfH;
}

async function loadFromFiles(jsonFile: File, atlasFile: File, pngFile: File): Promise<void> {
  const [jsonText, atlasText, pngBuf] = await Promise.all([
    jsonFile.text(),
    atlasFile.text(),
    pngFile.arrayBuffer(),
  ]);
  const spine = JSON.parse(jsonText) as SpineJson;
  // The editor's export uses its internal Y-down convention for bone
  // positions, rotations, keyframe Y values, mesh vertices, and region
  // offsets. The runtime renders in Spine's standard Y-up convention,
  // so we Y-flip on load. We use the JSON shape to detect the editor's
  // own export (top-level width/height, no skeleton.width/height).
  if (isEditorExport(spine)) {
    const { w: pw, h: ph } = resolveProjectSize(spine);
    yFlipEditorExport(spine, pw, ph);
  }
  const atlas = parseAtlas(atlasText);
  const pngBlob = new Blob([pngBuf]);
  const bitmap = await createImageBitmap(pngBlob);
  // Upload the atlas PNG. Flip Y so UV (0,0) = top-left of the image
  // (PNG convention) instead of WebGL's default bottom-left. The
  // editor's UVs use the top-left convention.
  const tex = createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.generateMipmap(gl.TEXTURE_2D);
  atlas.pages[0].size = { w: bitmap.width, h: bitmap.height };
  atlas.texture = tex;

  // Build bone map.
  const boneMap = buildBoneMap(spine);
  // Normalise the skins structure (object form vs array form).
  const skins = normaliseSkins(spine);

  // Build attachment buffers. We support both mesh and region
  // attachments. Region attachments are converted on the fly to a
  // 4-vertex quad bound to the slot's bone, with the region's
  // offset/rotation/scale baked into the local vertex positions. The
  // standard skinning path then handles the bone's animation.
  const attachments = new Map<string, BufferRefs>();
  let meshCount = 0;
  let regionCount = 0;
  let skippedCount = 0;
  const atlasW = bitmap.width;
  const atlasH = bitmap.height;
  // Bone name → its index in the global bone array, so we can stamp
  // region attachments with the correct influence in one place.
  const globalBoneIndex = new Map<string, number>();
  for (let i = 0; i < spine.bones.length; i++) {
    globalBoneIndex.set(spine.bones[i]!.name, i);
  }
  for (const slot of spine.slots) {
    const slotAtt = skins.default?.[slot.name] ?? {};
    for (const attName of Object.keys(slotAtt)) {
      const att: any = slotAtt[attName];
      const attType: string = att.type ?? "region";
      // The atlas region is looked up by the attachment's `path` if
      // set (Spine convention), otherwise by the attachment name.
      const lookupName: string = att.path ?? attName;
      const region = atlas.regions.find((r) => r.name === lookupName);
      if (!region) {
        // No atlas region — skip silently. Region-typed attachments
        // that point at missing regions are common when the user
        // exports a subset; the mesh path requires a region for UVs.
        skippedCount++;
        continue;
      }
      const key = `${slot.name}:${attName}`;
      if (attType === "mesh") {
        const ref = buildMeshBuffer(att, region, spine, tex, atlasW, atlasH, globalBoneIndex);
        attachments.set(key, ref);
        meshCount++;
      } else if (attType === "region" || attType === undefined) {
        const ref = buildRegionBuffer(att, region, slot, tex, atlasW, atlasH, globalBoneIndex);
        if (ref) {
          attachments.set(key, ref);
          regionCount++;
        } else {
          skippedCount++;
        }
      } else {
        // boundingbox, path, point, clipping, linkedmesh — not drawn.
        skippedCount++;
      }
    }
  }
  // Build the global bind pose (per-bone rest world).
  const globalBindPose = new Map<string, Mat3>();
  for (const [name, b] of boneMap) {
    globalBindPose.set(name, new Float32Array(b.world));
  }
  // Allocate the bone matrix buffer.
  const boneMatrixBuf = new Float32Array(boneMap.size * 9);

  skeleton = {
    spine,
    atlas,
    atlasTexture: tex,
    boneMap,
    slotOrder: spine.slots,
    attachments,
    animations: new Map<string, SpineAnimation>(
      Object.entries(spine.animations ?? {}) as [string, SpineAnimation][]
    ),
    boneMatrixBuf,
    globalBindPose,
  };
  // Resize the canvas to the project size, then fit. Spine 4.x
  // sometimes only puts width/height inside `skeleton`; resolveProjectSize
  // accepts both shapes and defaults to 512×512 if neither is present.
  const { w: projectW, h: projectH } = resolveProjectSize(spine);
  resizeCanvasToRenderBounds(projectW, projectH);
  fitToScreen();
  // Pick the first animation.
  const first = spine.animations ? Object.keys(spine.animations)[0] : null;
  activeAnimation = first;
  if (first) {
    const anim = (spine.animations as any)[first];
    // If the animation has no tracks, just keep the bind pose. Otherwise
    // set up the playhead.
    currentTime = 0;
    isPlaying = true;
    log(`Loaded ${jsonFile.name} (${first}, ${meshCount} mesh + ${regionCount} region attachments, ${skippedCount} skipped, ${anim.bones ? Object.keys(anim.bones).length : 0} bone tracks)`);
  } else {
    log(`Loaded ${jsonFile.name} (no animations — bind pose, ${meshCount} mesh + ${regionCount} region)`);
  }
  // Successful load — the drop hint is no longer relevant, hide it so
  // the user has a clean stage.
  if (hintEl) hintEl.style.display = "none";
  refreshAnimList();
}

function buildMeshBuffer(att: any, region: any, spine: SpineJson, atlasTexture: WebGLTexture, atlasW: number, atlasH: number, globalBoneIndex: Map<string, number>): BufferRefs {
  // Vertices from Spine: flattened [x, y, x, y, ...]
  // We need 12 floats per vertex: pos.xy, uv.xy, bones.xxxx, weights.xyzw
  const vCount = att.vertices.length / 2;
  // The JSON's `att.uvs` are already the atlas UVs (the editor computes
  // them via buildUvMap). We use them directly. The atlasW/H params
  // are accepted for API symmetry / future V-flip logic but currently
  // unused here.
  void atlasW; void atlasH;
  // Bone influence: for mono-bone meshes, all 4 verts bind to bone 0 with weight 1.
  // For multi-bone, look up the meshes entry.
  const meshEntry = (spine.meshes ?? []).find((m: any) => m.name === att.name);
  const boneNames = meshEntry ? meshEntry.bones : [att.parent];
  // Per-vertex bone+weight arrays — up to 4 influences per vertex,
  // matching the editor's skin-renderer layout. The vertex shader
  // sums `a_weights[i] * u_bones[a_bones[i]]` for i = 0..3, so any
  // unfilled slot must have weight 0. Bone indices in unused slots
  // are 0 (the shader will read bone 0's matrix, but it gets
  // multiplied by 0 so the contribution is irrelevant).
  const perVertBones: number[][] = Array.from({ length: vCount }, () => [0, 0, 0, 0]);
  const perVertWeights: number[][] = Array.from({ length: vCount }, () => [0, 0, 0, 0]);
  if (meshEntry) {
    // meshEntry.vertices is laid out as: for each vertex, a count N of
    // influences (1..4), then N pairs of (localBoneIdx, weight). We
    // remap each local index to its global `spine.bones` index and
    // store up to 4 pairs per vertex.
    const arr = meshEntry.vertices;
    const vtxCount = vCount;
    let cursor = 0;
    for (let i = 0; i < vtxCount; i++) {
      const influenceCount = Math.min(4, arr[cursor] ?? 0);
      cursor += 1;
      const bones = perVertBones[i]!;
      const weights = perVertWeights[i]!;
      for (let k = 0; k < influenceCount; k++) {
        const localBi = arr[cursor] ?? 0;
        const w = arr[cursor + 1] ?? 0;
        const boneName = meshEntry.bones[localBi] ?? meshEntry.parent ?? att.parent;
        bones[k] = globalBoneIndex.get(boneName) ?? 0;
        weights[k] = w;
        cursor += 2;
      }
    }
  } else if (boneNames.length === 1 && att.parent) {
    // Look up the global bone index by name; bind every vertex to it
    // with weight 1 in slot 0.
    const idx = globalBoneIndex.get(boneNames[0] ?? att.parent) ?? 0;
    for (let i = 0; i < vCount; i++) {
      perVertBones[i]![0] = idx;
      perVertWeights[i]![0] = 1;
    }
  }

  // Build the interleaved VBO data.
  const data = new Float32Array(vCount * 12);
  let p = 0;
  for (let i = 0; i < vCount; i++) {
    const lx = att.vertices[i * 2 + 0];
    const ly = att.vertices[i * 2 + 1];
    // Use the atlas UVs directly. The editor already baked region.x/y
    // and the atlas dimensions into these (via buildUvMap in
    // spine-export). The runtime flips the texture Y on upload so UV
    // (0,0) = top-left of the image (PNG convention).
    const atlasU = att.uvs[i * 2 + 0];
    const atlasV = att.uvs[i * 2 + 1];
    const bones = perVertBones[i]!;
    const weights = perVertWeights[i]!;
    data[p++] = lx;
    data[p++] = ly;
    data[p++] = atlasU;
    data[p++] = atlasV;
    data[p++] = bones[0]!;
    data[p++] = bones[1]!;
    data[p++] = bones[2]!;
    data[p++] = bones[3]!;
    data[p++] = weights[0]!;
    data[p++] = weights[1]!;
    data[p++] = weights[2]!;
    data[p++] = weights[3]!;
  }
  // Indices: Spine stores triangles as flat [a, b, c, ...]. We emit them
  // directly. They're 1-indexed in some old versions but Spine 4.1 uses
  // 0-indexed.
  const indices = new Uint16Array(att.triangles);

  const vbo = createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  const ibo = createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

  return {
    vbo,
    ibo,
    indexCount: indices.length,
    texture: atlasTexture,
    vertices: data,
    indices,
    boneMatrixBase: 0,
  };
}

/** Build a 4-vertex quad buffer for a Spine region attachment. Region
 *  attachments are the most common attachment type in Spine rigs that
 *  aren't weighted meshes (the official `hero` sample is region-only).
 *  Each region has:
 *    - local offset (x, y) from the bone
 *    - local rotation (around the bone)
 *    - local scale (scaleX, scaleY) — usually 1
 *    - width / height (the atlas region's pixel size)
 *  We bake the offset/rotation/scale into the local vertex positions
 *  (4 corners: BL, BR, TR, TL), bind the slot's bone as the sole
 *  influence, and let the existing skinning shader handle the bone's
 *  animation. This is exactly what spine-cpp / spine-ts do internally
 *  for region attachments.
 *
 *  Returns null if the slot's bone isn't in the bone map (e.g. a
 *  malformed bundle) so the caller can skip it cleanly. */
function buildRegionBuffer(
  att: any,
  region: { x: number; y: number; w: number; h: number; rotate?: boolean },
  slot: SpineSlot,
  atlasTexture: WebGLTexture,
  atlasW: number,
  atlasH: number,
  globalBoneIndex: Map<string, number>,
): BufferRefs | null {
  // The slot's `bone` field is the bone this attachment is parented to.
  // If absent, fall back to the attachment's `parent` (Spine 4.x).
  const parentBoneName: string = slot.bone ?? att.parent;
  const parentBoneIdx = globalBoneIndex.get(parentBoneName);
  if (parentBoneIdx === undefined) {
    // No matching bone — drop this attachment. The editor's import
    // path warns about the same condition.
    return null;
  }
  const w = typeof att.width === "number" ? att.width : region.w;
  const h = typeof att.height === "number" ? att.height : region.h;
  // Region attachments default to 0,0,1,1 in the absence of these
  // fields. The Spine spec puts rotation in degrees, scale as 1.
  // Both the editor's export (Y-flipped on load) and the standard
  // Spine 4.x files use Y-up at this point, so `offY` is positive
  // when the region should sit above the bone in the Y-up world.
  const offX = typeof att.x === "number" ? att.x : 0;
  const offY = typeof att.y === "number" ? att.y : 0;
  const rot = typeof att.rotation === "number" ? att.rotation : 0;
  const sx = typeof att.scaleX === "number" ? att.scaleX : 1;
  const sy = typeof att.scaleY === "number" ? att.scaleY : 1;
  // Pre-bake the offset/rotation/scale into 4 corner positions in
  // the bone's local space. The standard skinning shader will then
  // multiply each corner by the bone's animated world matrix.
  const rad = rot * Math.PI / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  // Half-extents in the region's local frame.
  const hw = (w * sx) / 2;
  const hh = (h * sy) / 2;
  // 4 corners in region-local space, in the Y-up world the runtime
  // uses. Positive y is UP, so the top of the image sits at y=+hh.
  // The corners are listed TL, TR, BR, BL so the triangle indices
  // (0,1,2 = TL→TR→BR; 0,2,3 = TL→BR→BL) form a CCW winding in
  // Y-up screen space, which is what WebGL's default front-face
  // expects.
  type Corner = { x: number; y: number };
  const corners: Corner[] = [
    { x: -hw, y:  hh }, // TL
    { x:  hw, y:  hh }, // TR
    { x:  hw, y: -hh }, // BR
    { x: -hw, y: -hh }, // BL
  ];
  // Compose: cornerBoneLocal = T(offX, localOffY) * R(rot) * S(sx,sy) * corner
  // The VBO layout is 12 floats per vertex:
  //   [pos.x, pos.y, uv.x, uv.y, bones.x, bones.y, bones.z, bones.w,
  //    weights.x, weights.y, weights.z, weights.w]
  // We fill bones and weights explicitly here; the UV slots are
  // skipped (p += 2) and back-filled by the UV loop below.
  const data = new Float32Array(4 * 12);
  let p = 0;
  for (const corner of corners) {
    // Region-local to bone-local: rotate by `rot`, then add offset.
    const rx = corner.x * c - corner.y * s;
    const ry = corner.x * s + corner.y * c;
    const bx = rx + offX;
    const by = ry + offY;
    data[p++] = bx;           // pos.x
    data[p++] = by;           // pos.y
    p += 2;                   // skip uv.x, uv.y (back-filled below)
    data[p++] = parentBoneIdx; // bones.x
    data[p++] = 0;             // bones.y (unused)
    data[p++] = 0;             // bones.z (unused)
    data[p++] = 0;             // bones.w (unused)
    data[p++] = 1;             // weights.x = 1
    data[p++] = 0;             // weights.y (unused)
    data[p++] = 0;             // weights.z (unused)
    data[p++] = 0;             // weights.w (unused)
  }
  // UVs. The atlas is uploaded with UNPACK_FLIP_Y_WEBGL=true so UV
  // (0, 0) is the top-left of the source image — exactly what the
  // editor's buildUvMap / spine-export emits. In Y-up the TL vertex
  // samples the top-left of the source region, BR samples the
  // bottom-right, and the flip maps cleanly.
  const u0 = region.x / atlasW;
  const v0 = region.y / atlasH;
  const u1 = (region.x + region.w) / atlasW;
  const v1 = (region.y + region.h) / atlasH;
  const uvQuad = [
    [u0, v0], // TL → top-left of region
    [u1, v0], // TR → top-right
    [u1, v1], // BR → bottom-right
    [u0, v1], // BL → bottom-left
  ];
  for (let i = 0; i < 4; i++) {
    const base = i * 12;
    data[base + 2] = uvQuad[i]![0]!;
    data[base + 3] = uvQuad[i]![1]!;
  }
  // Two triangles: TL→TR→BR, TL→BR→BL. CCW in Y-up screen space.
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const vbo = createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  const ibo = createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
  // Same atlas texture for every region — every region lives on the
  // same page in this minimal runtime.
  return {
    vbo,
    ibo,
    indexCount: 6,
    texture: atlasTexture,
    vertices: data,
    indices,
    boneMatrixBase: 0,
  };
}

/* -------------------------------------------------------------------------- */
/*  Render loop                                                               */
/* -------------------------------------------------------------------------- */

function fitToScreen(): void {
  // The runtime renders Spine's Y-up world into the canvas using a
  // view transform (pan/zoom) that fits the skeleton's bounding box
  // (see computeViewTransform). The canvas's CSS size is just the
  // intrinsic pixel size — the browser will scale it to fit the
  // stage. We only need to make sure the canvas drawing buffer
  // matches the project size (set by loadFromFiles).
  canvas.style.width = `${canvas.width}px`;
  canvas.style.height = `${canvas.height}px`;
  canvas.style.maxWidth = "100%";
  canvas.style.maxHeight = "100%";
  canvas.style.objectFit = "contain";
}

function buildProjection(w: number, h: number): Float32Array {
  // Map screen pixels (canvas convention, Y-down) to NDC (Y-up):
  //   x' = (x / w) * 2 - 1           (0 → -1, w → +1)
  //   y' = 1 - (y / h) * 2          (0 → +1 top, h → -1 bottom)
  // The vertex shader first applies the view transform
  // (zoom + pan + Y-flip from Spine's Y-up world to screen
  // Y-down pixels), then this projection maps to NDC.
  return new Float32Array([
    2 / w,  0,     0,
    0,      -2/h,  0,
   -1,      1,     1,
  ]);
}

function evaluatePose(animName: string, t: number): void {
  if (!skeleton) return;
  // Build the deltas for the active animation. If mixDuration > 0 and
  // we still have a fromAnim, lerp toward those deltas from the
  // outgoing animation's deltas — Spine 4.1's "linear" mix.
  const deltas = sampleDeltas(animName, t);
  if (fromAnim && mixDuration > 0 && mixElapsed < mixDuration) {
    const u = mixElapsed / mixDuration; // 0 → 1 over mixDuration
    const from = sampleDeltas(fromAnim, t);
    for (const [name, fromD] of from) {
      const toD = deltas.get(name) ?? { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };
      deltas.set(name, {
        x: fromD.x + (toD.x - fromD.x) * u,
        y: fromD.y + (toD.y - fromD.y) * u,
        rotation: fromD.rotation + (toD.rotation - fromD.rotation) * u,
        scaleX: fromD.scaleX + (toD.scaleX - fromD.scaleX) * u,
        scaleY: fromD.scaleY + (toD.scaleY - fromD.scaleY) * u,
      });
    }
  }
  // Update each bone's world transform in hierarchy order. This mirrors
  // the editor's evalPoseWithSamples: missing animation tracks keep
  // the bone's local bind pose, but the world matrix is still recomposed
  // under the CURRENT animated parent. Do not copy globalBindPose here;
  // that freezes untracked child bones (eg. hero weapon) in setup pose.
  for (const [, bone] of skeleton.boneMap) {
    const d = deltas.get(bone.name);
    const local = mat3FromPose({
      x: bone.rest.x + (d?.x ?? 0),
      y: bone.rest.y + (d?.y ?? 0),
      rotation: bone.rest.rotation + (d?.rotation ?? 0),
      scaleX: bone.rest.scaleX * (d?.scaleX ?? 1),
      scaleY: bone.rest.scaleY * (d?.scaleY ?? 1),
    });
    if (bone.parent) {
      const parentWorld = skeleton.boneMap.get(bone.parent)!.world;
      composeWorldFromParent(bone.world, parentWorld, local, bone.inherit);
    } else {
      bone.world.set(local);
    }
  }
}

/** Sample one animation's deltas (relative to rest pose) at time `t`.
 *  Returns a Map keyed by bone name. Bones with no track are absent
 *  from the map; callers should treat absent entries as zero deltas. */
function sampleDeltas(animName: string, t: number): Map<string, { x: number; y: number; rotation: number; scaleX: number; scaleY: number }> {
  const out = new Map<string, { x: number; y: number; rotation: number; scaleX: number; scaleY: number }>();
  if (!skeleton) return out;
  const anim = skeleton.animations.get(animName);
  if (!anim || !anim.bones) return out;
  for (const boneName of Object.keys(anim.bones)) {
    const tracks = anim.bones[boneName];
    const dx = tracks.translate ? sampleTranslate(tracks.translate, t).x : 0;
    const dy = tracks.translate ? sampleTranslate(tracks.translate, t).y : 0;
    const dr = tracks.rotate ? sampleRotate(tracks.rotate, t) : 0;
    const dsx = tracks.scale ? sampleScale(tracks.scale, t).x : 1;
    const dsy = tracks.scale ? sampleScale(tracks.scale, t).y : 1;
    out.set(boneName, { x: dx, y: dy, rotation: dr, scaleX: dsx, scaleY: dsy });
  }
  return out;
}

function uploadBonesToGPU(): void {
  if (!skeleton) return;
  let i = 0;
  for (const [, bone] of skeleton.boneMap) {
    flattenMat3(bone.world, skeleton.boneMatrixBuf, i * 9);
    i++;
  }
  gl.uniformMatrix3fv(uBones, false, skeleton.boneMatrixBuf);
}

function renderFrame(): void {
  if (!skeleton) return;
  // Background — clear to the canvas bg.
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0.165, 0.180, 0.227, 1.0); // matches the editor's #2a2f3a
  gl.clear(gl.COLOR_BUFFER_BIT);
  // Projection from the canvas size.
  const proj = buildProjection(canvas.width, canvas.height);
  gl.uniformMatrix3fv(uProjection, false, proj);
  // View transform (pan/zoom) — recomputed each frame in case the
  // canvas was resized since the last draw.
  computeViewTransform();
  gl.uniform2f(uPan, viewPanX, viewPanY);
  gl.uniform1f(uZoom, viewZoom);
  // Bind atlas texture.
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, skeleton.atlasTexture);
  gl.uniform1i(uAtlas, 0);
  // Update and upload bones.
  evaluatePose(activeAnimation ?? "", currentTime);
  uploadBonesToGPU();
  // Draw each attachment.
  for (const ref of skeleton.attachments.values()) {
    gl.bindBuffer(gl.ARRAY_BUFFER, ref.vbo);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ref.ibo);
    // Layout: pos (2) + uv (2) + bones (4) + weights (4) = 12 floats.
    const STRIDE = 12 * 4;
    gl.vertexAttribPointer(aPos,     2, gl.FLOAT, false, STRIDE, 0);
    gl.vertexAttribPointer(aUv,      2, gl.FLOAT, false, STRIDE, 8);
    gl.vertexAttribPointer(aBones,   4, gl.FLOAT, false, STRIDE, 16);
    gl.vertexAttribPointer(aWeights, 4, gl.FLOAT, false, STRIDE, 32);
    gl.enableVertexAttribArray(aPos);
    gl.enableVertexAttribArray(aUv);
    gl.enableVertexAttribArray(aBones);
    gl.enableVertexAttribArray(aWeights);
    gl.drawElements(gl.TRIANGLES, ref.indexCount, gl.UNSIGNED_SHORT, 0);
    gl.disableVertexAttribArray(aPos);
    gl.disableVertexAttribArray(aUv);
    gl.disableVertexAttribArray(aBones);
    gl.disableVertexAttribArray(aWeights);
  }
}

function tick(now: number): void {
  if (skeleton && isPlaying && activeAnimation) {
    const anim = skeleton.animations.get(activeAnimation);
    if (anim) {
      const dt = (now - lastT) / 1000;
      currentTime = (currentTime + dt) % Math.max(0.1, getAnimDuration(anim));
      // Advance the mix counter so the FROM animation fades out.
      if (fromAnim && mixDuration > 0) {
        mixElapsed += dt;
        if (mixElapsed >= mixDuration) {
          fromAnim = null;
          mixElapsed = 0;
          mixDuration = 0;
        }
      }
    }
  }
  lastT = now;
  renderFrame();
  requestAnimationFrame(tick);
}

function getAnimDuration(anim: any): number {
  let max = 0;
  if (anim.bones) {
    for (const tracks of Object.values(anim.bones) as Array<any>) {
      for (const k of ["translate", "rotate", "scale"]) {
        const arr = tracks[k];
        if (arr && arr.length > 0) max = Math.max(max, keyTime(arr[arr.length - 1]));
      }
    }
  }
  return max || 1.0;
}

/* -------------------------------------------------------------------------- */
/*  UI                                                                        */
/* -------------------------------------------------------------------------- */

const logEl = $(".sf-status") as HTMLElement;
const hintEl = $(".drop-hint") as HTMLElement | null;

function log(msg: string): void {
  if (logEl) logEl.textContent = msg;
}

function refreshAnimList(): void {
  const sel = $("#anim-list") as HTMLSelectElement;
  if (!sel) return;
  sel.innerHTML = "";
  if (!skeleton) {
    sel.innerHTML = `<option>—</option>`;
    return;
  }
  for (const name of skeleton.animations.keys()) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    if (name === activeAnimation) opt.selected = true;
    sel.appendChild(opt);
  }
}

/** Recursively collect every file inside a dropped folder using the
 *  FileSystem API. Older browsers without `webkitGetAsEntry` fall
 *  back to `dataTransfer.files` which already exposes the folder's
 *  contents. */
function collectEntryFiles(entry: FileSystemEntry, out: File[]): Promise<void> {
  return new Promise((resolve) => {
    if (entry.isFile) {
      (entry as FileSystemFileEntry).file(
        (f) => { out.push(f); resolve(); },
        () => resolve(),
      );
      return;
    }
    if (entry.isDirectory) {
      const dir = entry as FileSystemDirectoryEntry;
      const reader = dir.createReader();
      const readBatch = (): void => {
        reader.readEntries(async (entries) => {
          if (entries.length === 0) { resolve(); return; }
          for (const e of entries) await collectEntryFiles(e, out);
          readBatch();
        }, () => resolve());
      };
      readBatch();
      return;
    }
    resolve();
  });
}

function setupUI(): void {
  // File picker.
  $("#pick-json")?.addEventListener("click", () => pickAndLoad());
  $("#pick-bundle")?.addEventListener("click", () => pickBundle());
  // Drop a folder or three files onto the page. The runtime accepts the
// three files produced by the editor's "Export Spine bundle" command
// (`export.spine`): a .json (Spine 4.1), a .atlas, and a .png. We
// also accept a .sfproj (the editor's own save format) by handing it
// off to the same loadFromFiles path — but a .sfproj is JSON, not
// Spine, so a future refactor would need a separate parser. For now
// the hint and the error path make it clear what is expected.
//
// We log every drop, even partial / mismatched ones, so the user can
// see why nothing happened. Previously a partial drop was a silent
// no-op which made the page look broken.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", async (e) => {
    e.preventDefault();
    if (!e.dataTransfer) return;
    // dataTransfer.items is the source of truth for folder drops —
    // modern browsers expose folder contents through webkitGetAsEntry().
    const files: File[] = [];
    if (e.dataTransfer.items && e.dataTransfer.items.length) {
      for (let i = 0; i < e.dataTransfer.items.length; i++) {
        const item = e.dataTransfer.items[i];
        if (item.kind !== "file") continue;
        const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.();
        if (entry) {
          await collectEntryFiles(entry, files);
        } else if (item.getAsFile) {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
    } else {
      files.push(...Array.from(e.dataTransfer.files));
    }
    if (files.length === 0) {
      log("No files in drop. Expected a .json + .atlas + .png Spine bundle.");
      return;
    }
    const json  = files.find((f) => /\.json$/i.test(f.name));
    const atlas = files.find((f) => /\.atlas$/i.test(f.name));
    const png   = files.find((f) => /\.png$/i.test(f.name));
    if (json && atlas && png) {
      try {
        await loadFromFiles(json, atlas, png);
      } catch (err) {
        console.error(err);
        log(`Load failed: ${(err as Error).message}`);
      }
      return;
    }
    // Partial / mismatched drop — be specific about what's missing so
    // the user can fix it without guessing.
    const missing: string[] = [];
    if (!json)  missing.push(".json");
    if (!atlas) missing.push(".atlas");
    if (!png)   missing.push(".png");
    const have = files.map((f) => f.name).slice(0, 4).join(", ");
    const more = files.length > 4 ? ` (+${files.length - 4} more)` : "";
    if (files.length === 1) {
      const only = files[0]!;
      if (/\.sfproj$/i.test(only.name)) {
        log("That looks like an editor .sfproj file, not a Spine bundle. Use the editor to open it, or export a Spine bundle first.");
        return;
      }
      log(`Dropped 1 file (${only.name}); need a .json + .atlas + .png Spine bundle. Missing: ${missing.join(", ")}.`);
      return;
    }
    log(`Dropped ${files.length} files (${have}${more}); missing: ${missing.join(", ")}. Expected a .json + .atlas + .png bundle.`);
  });
  // Space to play/pause.
  window.addEventListener("keydown", (e) => {
    if (e.key === " ") {
      e.preventDefault();
      isPlaying = !isPlaying;
      log(isPlaying ? "Playing" : "Paused");
    }
  });
  // Animation dropdown.
  $("#anim-list")?.addEventListener("change", (e) => {
    activeAnimation = (e.target as HTMLSelectElement).value;
    currentTime = 0;
  });
  // Window resize.
  window.addEventListener("resize", () => fitToScreen());
}

async function pickAndLoad(): Promise<void> {
  const json = await pick(".json,application/json");
  const atlas = await pick(".atlas,text/plain");
  const png = await pick(".png,image/png");
  if (json && atlas && png) await loadFromFiles(json, atlas, png);
}

async function pickBundle(): Promise<void> {
  // Allow picking three files at once via [webkitdirectory] or [multiple].
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = ".json,.atlas,.png";
  input.style.display = "none";
  document.body.appendChild(input);
  await new Promise<void>((resolve) => {
    input.addEventListener("change", async () => {
      const files = Array.from(input.files ?? []);
      const json = files.find((f) => f.name.endsWith(".json"));
      const atlas = files.find((f) => f.name.endsWith(".atlas"));
      const png = files.find((f) => f.name.endsWith(".png"));
      input.remove();
      if (json && atlas && png) {
        try {
          await loadFromFiles(json, atlas, png);
        } catch (err) {
          console.error(err);
          log(`Load failed: ${(err as Error).message}`);
        }
      } else {
        log("Need a .json, .atlas and .png file in the selection");
      }
      resolve();
    });
    input.click();
  });
}

function pick(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("change", () => {
      const file = input.files && input.files[0] ? input.files[0] : null;
      input.remove();
      resolve(file);
    });
    input.click();
  });
}

document.title = `${ATELIER_LOGO} — Runtime Player`;
// Expose the load function on window so the test harness can drive
// the player with File objects directly (file pickers don't work in
// headless). Also expose the canvas + skeleton for inspection.
(window as any).loadFromFiles = loadFromFiles;
// Public runtime API (P2.G — FR-TA-7). Game code does:
//   spriteforge.setAnimation('walk', { mix: 0.2 })
// after the runtime has loaded a 3-file bundle. The shape mirrors the
// minimum of Spine-runtime's AnimationState.setAnimation, scoped to
// what the editor actually exports.
(window as any).spriteforge = {
  setAnimation,
  getActiveAnimation: () => activeAnimation,
  getCurrentTime: () => currentTime,
  setCurrentTime: (t: number) => { currentTime = t; },
  pause: () => { isPlaying = false; },
  resume: () => { isPlaying = true; },
};
(window as any).__skeleton = () => skeleton;
setupUI();
log(`${ATELIER_LOGO} ready. Drop a .json + .atlas + .png to play.`);
lastT = performance.now();
requestAnimationFrame(tick);
