// src/editor/skin-renderer.ts
// WebGL2 GPU skinning for the mesh attachments. One shader program, one
// textured-quad draw call per slot.
//
// Linear blend skinning in the vertex shader:
//   worldPos = sum_i(w_i * M_bone_i * bindPos)
//
// where M_bone is the 3x3 world transform of the i-th bone influence.
//
// The CPU side:
//   1. Uploads the per-vertex bind positions + bone indices + weights once
//      per attachment (rare — only when the mesh is edited).
//   2. Uploads the per-frame bone transforms as a single 4x3 matrix array
//      (one mat3 per project bone).
//   3. Draws a triangle list using the GL state.

import type { Project, MeshAttachment, Id, Animation } from "../core/model";
import { evalPose, evalPoseWithSamples, sampleAnimation } from "../core/eval";
import type { Mat3 } from "../core/math";
import { parseHexRGBA } from "../core/color";

const VS = /* glsl */ `#version 300 es
  // Per-vertex attributes.
  layout(location=0) in vec2 a_pos;        // bind position (world)
  layout(location=1) in vec2 a_uv;         // texture UV
  layout(location=2) in vec4 a_bones;      // bone indices (0..BONE_COUNT-1)
  layout(location=3) in vec4 a_weights;   // bone weights, sum to 1.0

  // Per-frame uniforms.
  uniform mat3 u_bones[64];   // up to 64 bones
  uniform vec2 u_pan;         // screen pan in world units
  uniform float u_zoom;       // pixels per world unit

  // Projection: ortho, with y-down to match canvas coordinates.
  uniform vec2 u_viewport;    // viewport size in CSS pixels
  uniform vec2 u_stage;       // project width/height

  out vec2 v_uv;

  void main() {
    // Sum weighted bone transforms. We support up to 4 influences; weights
    // sum to 1.0 so no further normalization needed.
    mat3 m = mat3(0.0);
    m += a_weights.x * u_bones[int(a_bones.x)];
    m += a_weights.y * u_bones[int(a_bones.y)];
    m += a_weights.z * u_bones[int(a_bones.z)];
    m += a_weights.w * u_bones[int(a_bones.w)];

    vec3 p = m * vec3(a_pos, 1.0);
    // Project to screen: world → css → clip.
    vec2 css = p.xy * u_zoom + u_pan;
    vec2 ndc = vec2(
      (css.x / u_viewport.x) * 2.0 - 1.0,
      1.0 - (css.y / u_viewport.y) * 2.0
    );
    gl_Position = vec4(ndc, 0.0, 1.0);
    v_uv = a_uv;
  }
`;

const FS = /* glsl */ `#version 300 es
  precision mediump float;
  in vec2 v_uv;
  uniform sampler2D u_tex;
  /** Per-slot tint (FR-SA-5 — P2.D). Multiplied into the sampled
   *  texel; default is opaque white so older projects render the same. */
  uniform vec4 u_tint;
  out vec4 fragColor;
  void main() {
    fragColor = texture(u_tex, v_uv) * u_tint;
  }
`;

interface CompiledProgram {
  prog: WebGLProgram;
  attribs: { pos: number; uv: number; bones: number; weights: number };
  uniforms: { bones: WebGLUniformLocation | null; pan: WebGLUniformLocation | null; zoom: WebGLUniformLocation | null; viewport: WebGLUniformLocation | null; stage: WebGLUniformLocation | null; tex: WebGLUniformLocation | null; tint: WebGLUniformLocation | null };
}

/** Per-attachment GL state, cached to avoid re-uploading on every frame. */
interface AttachmentGL {
  vbo: WebGLBuffer;
  ibo: WebGLBuffer;
  texture: WebGLTexture;
  indexCount: number;
  boneCount: number;
}

/** Promise that resolves once the image has been decoded and is safe to
 *  upload to a GL texture. Decoding separately from the synchronous render
 *  path avoids the "first frame shows empty quad" failure mode. */
interface DecodedImage {
  promise: Promise<HTMLImageElement>;
  image?: HTMLImageElement;
}

/** Maximum number of bones the skin shader can address. Mirrors the
 *  `uniform mat3 u_bones[64]` declaration in VS. Vertex bone-index
 *  attributes must be < this value or the lookup wraps to garbage. */
const SHADER_BONE_LIMIT = 64;

/** Build a map `boneId → shader uniform slot` for a project. The map's
 *  iteration order matches `project.boneOrder` truncated to the shader
 *  limit, so every place that uploads to `u_bones[]` agrees on which
 *  bone occupies which slot. Exported for the viewport's debug helper
 *  which needs to mirror the same mapping for hit tests. */
export function buildShaderBoneIndex(project: Project): Map<Id, number> {
  const idx = new Map<Id, number>();
  const bones = project.boneOrder.slice(0, SHADER_BONE_LIMIT);
  for (let i = 0; i < bones.length; i++) idx.set(bones[i]!, i);
  return idx;
}

export class SkinRenderer {
  private program: CompiledProgram | null = null;
  private cache = new Map<Id, AttachmentGL>();
  private inflight = new Map<Id, Promise<AttachmentGL | null>>();
  private texCache = new Map<string, DecodedImage>();

  /** Pre-decode a set of image data URLs so they're immediately
   *  available for texture upload on the first render frame. Call
   *  this after importing a project, before the next animation
   *  frame, to avoid "corrupted first frame" texture glitches. */
  async prewarmImages(urls: string[]): Promise<void> {
    const jobs = urls.map(async (url) => {
      let dec = this.texCache.get(url);
      if (dec?.image) return; // already fully decoded — nothing to do
      if (dec) {
        // promise cached but image not stored yet — await & store
        const img = await dec.promise;
        dec.image = img;
        return;
      }
      const img = new Image();
      img.src = url;
      dec = { promise: img.decode().then(() => img) };
      this.texCache.set(url, dec);
      const ready = await dec.promise;
      dec.image = ready;
    });
    await Promise.all(jobs);
  }

  constructor(private gl: WebGL2RenderingContext) {
    this.program = this.compile();
    if (this.program) {
      this.gl.useProgram(this.program.prog);
      // The vertex shader emits positions in CSS-pixel screen space, and the
      // triangle winding is BL→BR→TR / BL→TR→TL which is CCW in world (y-up)
      // but becomes CW on screen because the shader flips y. Disable back-
      // face culling so triangles still rasterize instead of being culled.
      this.gl.disable(this.gl.CULL_FACE);
      // Stage size: doesn't change during a session, set once.
      this.gl.uniform2f(this.program.uniforms.stage, 512, 512);
    }
  }

  private compile(): CompiledProgram | null {
    const g = this.gl;
    const vs = this.shader(g.VERTEX_SHADER, VS);
    const fs = this.shader(g.FRAGMENT_SHADER, FS);
    if (!vs || !fs) return null;
    const prog = g.createProgram();
    if (!prog) return null;
    g.attachShader(prog, vs);
    g.attachShader(prog, fs);
    g.linkProgram(prog);
    if (!g.getProgramParameter(prog, g.LINK_STATUS)) {
      console.error("[skin] link failed:", g.getProgramInfoLog(prog));
      return null;
    }
    return {
      prog,
      attribs: {
        pos: g.getAttribLocation(prog, "a_pos"),
        uv: g.getAttribLocation(prog, "a_uv"),
        bones: g.getAttribLocation(prog, "a_bones"),
        weights: g.getAttribLocation(prog, "a_weights"),
      },
      uniforms: {
        bones: g.getUniformLocation(prog, "u_bones"),
        pan: g.getUniformLocation(prog, "u_pan"),
        zoom: g.getUniformLocation(prog, "u_zoom"),
        viewport: g.getUniformLocation(prog, "u_viewport"),
        stage: g.getUniformLocation(prog, "u_stage"),
        tex: g.getUniformLocation(prog, "u_tex"),
        tint: g.getUniformLocation(prog, "u_tint"),
      },
    };
  }

  private shader(type: number, src: string): WebGLShader | null {
    const g = this.gl;
    const s = g.createShader(type);
    if (!s) return null;
    g.shaderSource(s, src);
    g.compileShader(s);
    if (!g.getShaderParameter(s, g.COMPILE_STATUS)) {
      console.error("[skin] shader compile failed:", g.getShaderInfoLog(s), "\n", src);
      g.deleteShader(s);
      return null;
    }
    return s;
  }

  /** Render all visible slots in the project. The optional `pose` is
   *  the precomputed world-transform map (used by the viewport to keep
   *  the bones and the skin in sync). If omitted, we compute it here
   *  from the project + active animation + current time. */
  render(project: Project, panX: number, panY: number, zoom: number, viewportW: number, viewportH: number, currentTime?: number, pose?: Map<Id, Mat3>, activeAnimation?: Animation | null): void {
    const g = this.gl;
    if (!this.program) return;
    g.useProgram(this.program.prog);
    g.viewport(0, 0, g.drawingBufferWidth, g.drawingBufferHeight);
    // The screen is drawn underneath the 2D overlay. We clear in clearGL()
    // which is called separately. The skin renderer just draws.
    g.enable(g.BLEND);
    g.blendFunc(g.SRC_ALPHA, g.ONE_MINUS_SRC_ALPHA);

    // Pack bone transforms. Up to 64 bones (matches the GLSL array size).
    const bones = project.boneOrder.slice(0, SHADER_BONE_LIMIT);
    // Map project bone id → shader uniform index. Vertex buffers must
    // upload indices into THIS array, not into att.boneRefs. A previous
    // bug used attachment-local indices, so any single-bone attachment
    // uploaded index 0 and therefore followed the first project bone
    // even when att.bindBone was the second bone.
    const boneIndex = buildShaderBoneIndex(project);
    // Use the passed-in pose when given (keeps the bone gizmo and the
    // skin in lockstep). Otherwise sample the active animation so the
    // mesh follows the timeline scrub.
    const effPose = pose ?? (
      (() => {
        const anim = activeAnimation ?? project.animations[project.activeAnimationId] ?? null;
        const samples = anim ? sampleAnimation(anim, currentTime ?? 0) : null;
        return evalPoseWithSamples(project, samples);
      })()
    );
    const matArr = new Float32Array(SHADER_BONE_LIMIT * 9);
    for (let i = 0; i < bones.length; i++) {
      const m = effPose.get(bones[i]!);
      if (!m) continue;
      // Convert our 6-element column-major Mat3 (with implicit [0 0 1] row)
      // to a 9-element column-major mat3 suitable for GLSL. Layouts:
      //   our m.m   = [ m00 m10 m01 m11 m20 m21 ]  (col-major, 2x2 + tx)
      //   GLSL mat3 = col0[m00,m10, 0]
      //               col1[m01,m11, 0]
      //               col2[m20,m21, 1]
      matArr[i * 9 + 0] = m.m[0] ?? 0;   // col 0, row 0: m00
      matArr[i * 9 + 1] = m.m[1] ?? 0;   // col 0, row 1: m10
      matArr[i * 9 + 2] = 0;             // col 0, row 2: 0
      matArr[i * 9 + 3] = m.m[2] ?? 0;   // col 1, row 0: m01
      matArr[i * 9 + 4] = m.m[3] ?? 0;   // col 1, row 1: m11
      matArr[i * 9 + 5] = 0;             // col 1, row 2: 0
      matArr[i * 9 + 6] = m.m[4] ?? 0;   // col 2, row 0: tx (m20)
      matArr[i * 9 + 7] = m.m[5] ?? 0;   // col 2, row 1: ty (m21)
      matArr[i * 9 + 8] = 1;             // col 2, row 2: 1
    }
    g.uniformMatrix3fv(this.program.uniforms.bones, false, matArr);
    g.uniform2f(this.program.uniforms.pan, panX, panY);
    g.uniform1f(this.program.uniforms.zoom, zoom);
    g.uniform2f(this.program.uniforms.viewport, viewportW, viewportH);

    // Draw each slot's attachment. We skip attachments whose bind bone
    // is hidden (FR-RB-6 — P2.B): a hidden bone means "don't render
    // this part of the rig." The skin's deform bones can still drive
    // visible attachments through the same shared world transforms, so
    // hiding only affects the per-attachment draw call here.
    for (const sid of project.slotOrder) {
      const slot = project.slots[sid];
      if (!slot || !slot.attachment) continue;
      const att = project.attachments[slot.attachment];
      if (!att) continue;
      const bindBone = project.bones[att.bindBone];
      if (bindBone && bindBone.visible === false) continue;
      // FR-SA-5 — set per-slot tint. Default opaque white means the
      // multiply is a no-op for slots that didn't opt in.
      const tint = parseHexRGBA(slot.tint);
      g.uniform4f(this.program.uniforms.tint, tint[0], tint[1], tint[2], tint[3]);
      void this.drawAttachment(att, boneIndex);
    }
  }

  private async drawAttachment(att: MeshAttachment, boneIndex: Map<Id, number>): Promise<void> {
    const g = this.gl;
    if (!this.program) return;
    let entry: AttachmentGL | null = this.cache.get(att.id) ?? null;
    if (!entry) {
      // If another frame is already uploading this attachment, just wait
      // for it to finish — we don't issue a duplicate GL upload.
      const inflight = this.inflight.get(att.id);
      if (inflight) { await inflight; entry = this.cache.get(att.id) ?? null; }
      if (!entry) {
        const p = this.upload(att, boneIndex);
        this.inflight.set(att.id, p);
        entry = await p;
        this.inflight.delete(att.id);
        if (!entry) return;
        this.cache.set(att.id, entry);
      }
    }
    const gl = entry;
    g.bindBuffer(g.ARRAY_BUFFER, gl.vbo);
    g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, gl.ibo);
    g.bindTexture(g.TEXTURE_2D, gl.texture);
    g.uniform1i(this.program.uniforms.tex, 0);
    // Vertex layout: pos.xy uv.xy bones.iiii weights.ffff
    const stride = (2 + 2 + 4 + 4) * 4;
    g.enableVertexAttribArray(this.program.attribs.pos);
    g.vertexAttribPointer(this.program.attribs.pos, 2, g.FLOAT, false, stride, 0);
    g.enableVertexAttribArray(this.program.attribs.uv);
    g.vertexAttribPointer(this.program.attribs.uv, 2, g.FLOAT, false, stride, 2 * 4);
    g.enableVertexAttribArray(this.program.attribs.bones);
    g.vertexAttribPointer(this.program.attribs.bones, 4, g.FLOAT, false, stride, 4 * 4);
    g.enableVertexAttribArray(this.program.attribs.weights);
    g.vertexAttribPointer(this.program.attribs.weights, 4, g.FLOAT, false, stride, 8 * 4);
    g.drawElements(g.TRIANGLES, gl.indexCount, g.UNSIGNED_SHORT, 0);
  }

  private async upload(att: MeshAttachment, boneIndex: Map<Id, number>): Promise<AttachmentGL | null> {
    const g = this.gl;
    // Vertex data: N verts × 12 floats. Pre-P2.5.a was hardcoded to 4×12;
    // we now read `att.vertices.length` so subdivided meshes / Spine
    // imports with arbitrary vertex counts upload correctly.
    const N = att.vertices.length;
    const data = new Float32Array(N * 12);
    // Default UV mapping for the legacy 4-vert quad (BL, BR, TR, TL).
    // For attachments that carry their own `uvs`, we trust those —
    // subdivided meshes' interior vertices need precise per-vertex UVs.
    const legacyQuadUvs = [
      [0, 1], [1, 1], [1, 0], [0, 0],
    ];
    // Vertex bone indices must point into the shader's `u_bones[]`
    // array, which is packed in project.boneOrder order by render().
    // Do NOT use attachment-local att.boneRefs indexes here.
    for (let i = 0; i < N; i++) {
      const v = att.vertices[i]!;
      const o = i * 12;
      data[o + 0] = v.x;             // pos.x
      data[o + 1] = v.y;             // pos.y
      // UV: prefer the per-vertex `uvs` if the attachment supplied
      // them; otherwise (legacy 4-vert quads) fall back to the
      // hardcoded BL/BR/TR/TL mapping. For meshes with N > 4 and no
      // `uvs`, we'd be undefined-prone, so default any out-of-range
      // index to (0, 0) which is harmless ("transparent corner of the
      // image" for typical PNGs).
      let u = 0, vUv = 0;
      if (att.uvs && att.uvs[i]) {
        u = att.uvs[i]!.u; vUv = att.uvs[i]!.v;
      } else if (i < 4) {
        u = legacyQuadUvs[i]![0]; vUv = legacyQuadUvs[i]![1];
      }
      data[o + 2] = u;
      data[o + 3] = vUv;
      for (let k = 0; k < 4; k++) {
        const bid = v.bones[k] as Id;
        data[o + 4 + k] = boneIndex.get(bid) ?? 0;
      }
      for (let k = 0; k < 4; k++) data[o + 8 + k] = v.weights[k] ?? 0;
    }
    const vbo = g.createBuffer();
    if (!vbo) return null;
    g.bindBuffer(g.ARRAY_BUFFER, vbo);
    g.bufferData(g.ARRAY_BUFFER, data, g.STATIC_DRAW);

    // Index data: M triangles × 3 indices.
    const M = att.triangles.length;
    const indices = new Uint16Array(M * 3);
    for (let i = 0; i < M; i++) {
      indices[i * 3 + 0] = att.triangles[i]!.a;
      indices[i * 3 + 1] = att.triangles[i]!.b;
      indices[i * 3 + 2] = att.triangles[i]!.c;
    }
    const ibo = g.createBuffer();
    if (!ibo) return null;
    g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, ibo);
    g.bufferData(g.ELEMENT_ARRAY_BUFFER, indices, g.STATIC_DRAW);

    // Texture: decode the image *before* uploading, so we don't end up with
    // an empty texture for the first few frames (texImage2D on a not-yet-
    // decoded image silently fails on some browsers).
    const tex = g.createTexture();
    if (!tex) return null;
    g.bindTexture(g.TEXTURE_2D, tex);
    let dec = this.texCache.get(att.imageDataUrl);
    if (!dec) {
      const img = new Image();
      img.src = att.imageDataUrl;
      dec = { promise: img.decode().then(() => img) };
      this.texCache.set(att.imageDataUrl, dec);
    }
    const ready = dec.image ?? await dec.promise;
    dec.image = ready;
    // Match the runtime's texture orientation: PNG y-down → WebGL y-up.
    // Without this, the editor's UV (0,0) lands on the bottom of the
    // texture (the PNG's bottom) instead of the top, flipping every
    // image vertically in the viewport.
    g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, true);
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, ready);
    g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, false);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);

    return { vbo, ibo, texture: tex, indexCount: att.triangles.length * 3, boneCount: att.boneRefs.length };
  }

  /** Drop the GL cache for an attachment (e.g. after vertex edit). */
  invalidate(attachmentId: Id): void {
    const g = this.cache.get(attachmentId);
    if (!g) return;
    const gl = this.gl;
    gl.deleteBuffer(g.vbo);
    gl.deleteBuffer(g.ibo);
    gl.deleteTexture(g.texture);
    this.cache.delete(attachmentId);
  }

  /** Eagerly upload all attachment buffers and textures before the
   *  first render frame. Must be called after prewarmImages. This
   *  ensures drawAttachment finds entries in this.cache immediately
   *  and never needs to await inside the render loop. */
  async eagerUploadAll(project: Project): Promise<void> {
    const boneIndex = buildShaderBoneIndex(project);
    for (const id of project.attachmentOrder) {
      const att = project.attachments[id];
      if (!att) continue;
      if (this.cache.has(att.id)) continue;
      const entry = await this.upload(att, boneIndex);
      if (entry) this.cache.set(att.id, entry);
    }
  }
}

/** Parse a `#RRGGBB` or `#RRGGBBAA` string into a 4-channel float tuple
 *  in [0, 1]. See ../core/color.ts — re-exported here so older imports
 *  that referenced the local copy keep working. */
export { parseHexRGBA };
