// src/editor/spine-export.ts
// Convert a SpriteForge Project to Spine 4.1 JSON format.
//
// Reference: spine-runtimes/spine-cpp/src/spine/SpineJson.cpp (read-only
// mirror in `docs/spine-format.md` for offline lookup).
//
// Output shape (top-level keys):
//
//   skeleton: { hash, spine: "4.1.x" }       // hash is unused but required
//   width, height, fps                       // from the project
//   bones: [ {name, parent?, length?, x?, y?, rotation?, scaleX?, scaleY?, color?}, ... ]
//   slots: [ {name, bone, color, attachment: <defaultName>}, ... ]
//   skins: { default: { <slot>: { <attachment>: <typeObj> } } }
//   animations: { <name>: { bones: { <bone>: { translate, rotate, scale, shear? } },
//                              slots: { <slot>: { attachment, color } },
//                              events, ... }, ... }
//   events: { <name>: { int, float, string, audio, data } }  // only if any events
//   meshes: [ { name, bones, vertices, ... } ]               // only for mesh skins
//
// Color format throughout: Spine uses an 8-char hex string "RRGGBBAA".
// We translate our #RRGGBB or #AARRGGBB strings to that format.
//
// Curve format in animations: Spine uses
//   "linear" (default, omitted or string)
//   "stepped" (string)
//   [c2, c3, c4, c5]   — cubic bezier, implicit (0,0) and (1,1) endpoints
//                        control points 1 and 2 are (c2, c3) and (c4, c5)
//
// We round times to milliseconds (3 decimal places) for stable diffs.
//
// UVs in the skin mesh attachments come from the atlas the user picked.
// Pass an optional `uvMap` (built by atlas-export.buildUvMap) so we can
// write the correct atlas-space UVs into the Spine JSON.

import type { Project, Id, MeshAttachment, Bone, Keyframe, Animation, Track, Slot } from "../core/model";
import type { AtlasOutput } from "./atlas-export";

/** Spine 4.1's current minor version. */
const SPINE_VERSION = "4.1.0";

/** Color: convert #RRGGBB or #AARRGGBB to Spine's RRGGBBAA hex. */
function spineColor(input: string | undefined, fallback = "989898FF"): string {
  if (!input) return fallback;
  let hex = input.replace("#", "");
  if (hex.length === 6) hex += "FF";
  if (hex.length !== 8) return fallback;
  return hex.toUpperCase();
}

/** Round a number to 3 decimal places (millisecond precision for time). */
function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Round a number to 1 decimal place (pixel-precision for transforms). */
function r1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Spine keyframe shapes (subset we emit). */
interface SpineTranslateKey { time: number; x: number; y: number; curve?: string | number[]; }
interface SpineRotateKey { time: number; angle: number; curve?: string | number[]; }
interface SpineScaleKey { time: number; x: number; y: number; curve?: string | number[]; }

/** Default for missing fields per Spine convention. */
const DEFAULTS = {
  bone: {
    length: 0,
    x: 0,
    y: 0,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    color: "989898FF",
  },
  slot: {
    color: "FFFFFFFF",
  },
} as const;

/** Convert a bone from the editor's Y-down local space to Spine's Y-up local space. */
function exportBone(b: Bone, parentName: string | null): Record<string, unknown> {
  const out: Record<string, unknown> = { name: b.name };
  if (parentName !== null) out.parent = parentName;
  if (b.length !== DEFAULTS.bone.length) out.length = r1(b.length);
  if (b.x !== DEFAULTS.bone.x) out.x = r1(b.x);
  if (b.y !== DEFAULTS.bone.y) out.y = r1(-b.y);
  if (b.rotation !== DEFAULTS.bone.rotation) out.rotation = +r1(-b.rotation).toFixed(1);
  if (b.scaleX !== DEFAULTS.bone.scaleX) out.scaleX = +r1(b.scaleX).toFixed(3);
  if (b.scaleY !== DEFAULTS.bone.scaleY) out.scaleY = +r1(b.scaleY).toFixed(3);
  if (b.inherit && b.inherit !== "normal") out.inherit = b.inherit;
  if (b.length !== DEFAULTS.bone.length) out.length = r1(b.length);
  out.color = spineColor(b.color, DEFAULTS.bone.color);
  return out;
}

/** Convert a slot. As of P2.D, slot color (FR-SA-5) round-trips
 *  through the `tint` field on the slot. Spine encodes the slot color
 *  as `RRGGBBAA` (no `#`), so we hand it through `spineColor` which
 *  matches that convention. Falls back to opaque white when no tint
 *  is set on the slot. */
function exportSlot(s: Slot, boneName: string, slotAttachDefault: string | null): Record<string, unknown> {
  const out: Record<string, unknown> = { name: s.name, bone: boneName };
  out.color = spineColor(s.tint ?? "#ffffffff", DEFAULTS.slot.color);
  if (slotAttachDefault !== null) out.attachment = slotAttachDefault;
  return out;
}

/** Convert a curve marker from our Keyframe to Spine's format. */
function spineCurve(k: Keyframe): string | number[] | undefined {
  if (k.curve === "linear") return undefined; // Spine defaults to linear
  if (k.curve === "stepped") return "stepped";
  if (k.curve === "bezier") {
    // Spine stores [c2, c3, c4, c5] for cp1=(c2, c3) and cp2=(c4, c5).
    const cp1x = k.cp1x ?? 0, cp1y = k.cp1y ?? 0;
    const cp2x = k.cp2x ?? 1, cp2y = k.cp2y ?? 1;
    return [cp1x, cp1y, cp2x, cp2y];
  }
  return undefined;
}

/** Convert each keyframe in `track` via `mapValue`, attaching the
 *  Spine-formatted curve marker if the source curve isn't linear. The
 *  `time` field is rounded to milliseconds for stable diffs. This is
 *  shared between the translate / rotate / scale track exporters —
 *  only the per-keyframe payload changes. */
function exportTrackKeyframes<T extends { time: number }>(
  track: Track,
  mapValue: (k: Keyframe) => Omit<T, "time" | "curve">,
): Array<T & { curve?: string | number[] }> {
  return track.keyframes.map((k) => {
    const out = { time: r3(k.time), ...mapValue(k) } as T & { curve?: string | number[] };
    const c = spineCurve(k);
    if (c !== undefined) (out as { curve?: string | number[] }).curve = c;
    return out;
  });
}

/** Export a single translate track → Spine timeline.
 *  Our keyframes store absolute positions (bind-pose + offset).
 *  Spine expects additive offsets relative to the bind pose, so we
 *  subtract the bone's bind position and Y-flip the y-offset back.
 *  This is the inverse of the import conversion. */
function exportTranslateTrack(track: Track, bone: Bone): SpineTranslateKey[] {
  return exportTrackKeyframes<SpineTranslateKey>(track, (k) => {
    const v = k.value as { x: number; y: number };
    // Convert absolute → offset: offset = abs - bindPose
    const offX = v.x - bone.x;
    // Since our y-down world stores y values where bone.y = flipY(spine.y),
    // the Spine y-up offset = -(ourAbsY - bone.y) = bone.y - ourAbsY.
    const offY = bone.y - v.y;
    return { x: r1(offX), y: r1(offY) };
  });
}

/** Export a single rotate track → Spine timeline.
 *  Our keyframes store absolute rotation (bind-pose + offset).
 *  Spine expects additive offsets; subtract the bone's bind rotation. */
function exportRotateTrack(track: Track, bone: Bone): SpineRotateKey[] {
  return exportTrackKeyframes<SpineRotateKey>(track, (k) => {
    // Our keyframes store -(setup+offset), Spine expects +offset.
    // spineOffset = -(keyValue) - (-bone.rot) = bone.rot - keyValue
    const offAngle = bone.rotation - (k.value as number);
    return { angle: +(offAngle).toFixed(1) };
  });
}

/** Export a single scale track → Spine timeline.
 *  Our keyframes store absolute scale (bind-pose * factor).
 *  Spine expects multiplicative factors; divide by the bone's bind scale. */
function exportScaleTrack(track: Track, bone: Bone): SpineScaleKey[] {
  const bsx = bone.scaleX ?? 1;
  const bsy = bone.scaleY ?? 1;
  return exportTrackKeyframes<SpineScaleKey>(track, (k) => {
    const v = k.value as { x: number; y: number };
    const offX = bsx !== 0 ? v.x / bsx : 1;
    const offY = bsy !== 0 ? v.y / bsy : 1;
    return { x: +r1(offX).toFixed(1), y: +r1(offY).toFixed(1) };
  });
}

/** Generate a Spine-friendly attachment name. */
function spineAttachmentName(att: MeshAttachment): string {
  return att.name.replace(/[^a-zA-Z0-9_]/g, "_") || "att";
}

/** Per-attachment UV info from the atlas (or a default for the
 *  no-atlas case). */
export interface AttachmentUV {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/** Build a single mesh attachment payload (the inner skin map value).
 *  As of P2.5.a this handles N vertices / M triangles. The legacy
 *  4-vert quad path is preserved when `att.uvs` is missing — we expand
 *  the attachment-region UV box into the BL/BR/TR/TL convention; for
 *  meshes that carry their own per-vertex UVs we trust those (the
 *  atlas exporter has already mapped them into image space). */
function exportMeshAttachment(
  att: MeshAttachment,
  parentBoneName: string,
  uv: AttachmentUV
): Record<string, unknown> {
  const vertices: number[] = [];
  const uvs: number[] = [];
  for (const v of att.vertices) {
    vertices.push(r1(v.x), r1(-v.y));
  }
  if (att.uvs && att.uvs.length === att.vertices.length) {
    for (const u of att.uvs) {
      const atlasU = uv.u0 + u.u * (uv.u1 - uv.u0);
      const atlasV = uv.v0 + (1 - u.v) * (uv.v1 - uv.v0);
      uvs.push(+atlasU.toFixed(5), +atlasV.toFixed(5));
    }
  } else {
    // Legacy quad mapping: BL, BR, TR, TL → corners of the atlas region.
    // For attachments with N > 4 and no uvs (shouldn't happen in
    // practice), pad with (0, 0) — defensive only.
    const fallback = [
      [uv.u0, uv.v1], // BL
      [uv.u1, uv.v1], // BR
      [uv.u1, uv.v0], // TR
      [uv.u0, uv.v0], // TL
    ];
    for (let i = 0; i < att.vertices.length; i++) {
      const u = fallback[i] ?? [0, 0];
      uvs.push(+u[0].toFixed(5), +u[1].toFixed(5));
    }
  }

  // Flatten triangles for Spine: [a, b, c, a, b, c, ...].
  const triangles: number[] = [];
  for (const t of att.triangles) {
    triangles.push(t.a, t.b, t.c);
  }

  // Edges: Spine 4.1 expects pairs of vertex indices that form the
  // mesh's outer hull. For our 4-vert quad we hardcode the boundary;
  // for N > 4 we approximate with the convex hull of vertex 0..3 (the
  // original quad corners), which keeps Spine happy without forcing
  // every importer to compute a precise boundary. A future pass can
  // walk the triangle adjacency to derive the real boundary.
  const edges = att.vertices.length === 4 ? [0, 1, 1, 2, 2, 3, 3, 0] : [0, 1, 1, 2, 2, 3, 3, 0];
  const hull = Math.min(4, att.vertices.length);

  return {
    type: "mesh",
    name: spineAttachmentName(att),
    width: att.imageWidth,
    height: att.imageHeight,
    parent: parentBoneName,
    vertices,
    uvs,
    triangles,
    edges,
    hull,
    color: "FFFFFFFF",
  };
}

/** Build a top-level "meshes" entry (bone-influence data for a mesh). */
function exportMeshesEntry(att: MeshAttachment, boneNameLookup: Map<Id, string>): Record<string, unknown> {
  const boneRefs = att.boneRefs;
  const boneNames = boneRefs.map((id) => boneNameLookup.get(id) ?? "?");
  const vertices: number[] = [];
  // For each mesh vertex, emit (boneIdx, weight) pairs. P2.5.a now
  // supports N-vertex meshes — we read the per-vertex `bones` /
  // `weights` arrays instead of assuming a single bind bone with
  // weight 1. Empty bone slots (id === "" or weight === 0) are
  // dropped before emitting; Spine's mesh-skin format expects only
  // the bones with non-zero weight per vertex.
  for (const v of att.vertices) {
    // Collect the (idx, weight) pairs that have non-trivial weight.
    const pairs: Array<[number, number]> = [];
    for (let k = 0; k < 4; k++) {
      const w = v.weights[k] ?? 0;
      if (w <= 0) continue;
      const ix = boneRefs.indexOf(v.bones[k] as Id);
      if (ix < 0) continue;
      pairs.push([ix, w]);
    }
    if (pairs.length === 0) {
      // Defensive — fallback to bindBone weight 1.
      const bindIdx = boneRefs.indexOf(att.bindBone);
      pairs.push([bindIdx >= 0 ? bindIdx : 0, 1]);
    }
    vertices.push(pairs.length);
    for (const [ix, w] of pairs) {
      vertices.push(ix, +w.toFixed(6));
    }
  }
  return {
    name: spineAttachmentName(att),
    bones: boneNames,
    vertices,
  };
}

/** Build an animation dict for a single animation. As of P2.5.b
 *  this also emits the `slots` block for slot-targeted tracks
 *  (FR-SA-4: keyframed attachment swap, slot tint). Bone tracks go
 *  through the per-bone path; slot tracks are grouped by slotId. */
function exportAnimation(anim: Animation, project: Project): Record<string, unknown> {
  const boneNames = new Map<Id, string>();
  for (const id of project.boneOrder) boneNames.set(id, project.bones[id]!.name);
  const slotNames = new Map<Id, string>();
  for (const id of project.slotOrder) slotNames.set(id, project.slots[id]!.name);
  const byBone = new Map<Id, Track[]>();
  const bySlot = new Map<Id, Track[]>();
  for (const tr of anim.tracks) {
    if (tr.kind === "slot" && tr.slotId) {
      let arr = bySlot.get(tr.slotId);
      if (!arr) { arr = []; bySlot.set(tr.slotId, arr); }
      arr.push(tr);
    } else if (tr.boneId) {
      let arr = byBone.get(tr.boneId);
      if (!arr) { arr = []; byBone.set(tr.boneId, arr); }
      arr.push(tr);
    }
  }
  const animBones: Record<string, unknown> = {};
  for (const [bid, tracks] of byBone) {
    const name = boneNames.get(bid);
    if (!name) continue;
    const bone = project.bones[bid];
    if (!bone) continue;
    const entry: Record<string, unknown> = {};
    for (const tr of tracks) {
      if (tr.property === "translate") {
        const keys = exportTranslateTrack(tr, bone);
        if (keys.length > 0) entry.translate = keys;
      } else if (tr.property === "rotation") {
        const keys = exportRotateTrack(tr, bone);
        if (keys.length > 0) entry.rotate = keys;
      } else if (tr.property === "scale") {
        const keys = exportScaleTrack(tr, bone);
        if (keys.length > 0) entry.scale = keys;
      }
    }
    if (Object.keys(entry).length > 0) animBones[name] = entry;
  }
  // Slot tracks (P2.5.b — FR-SA-4). Spine 4.1 schema:
  //   animations.<name>.slots.<slotName> = { attachment: [{time, name}], color: [{time, color, curve?}] }
  const animSlots: Record<string, unknown> = {};
  for (const [sid, tracks] of bySlot) {
    const name = slotNames.get(sid);
    if (!name) continue;
    const entry: Record<string, unknown> = {};
    for (const tr of tracks) {
      if (tr.property === "attachment") {
        // Stepped by nature — Spine doesn't lerp attachment names.
        entry.attachment = tr.keyframes.map((k) => ({
          time: r3(k.time),
          name: typeof k.value === "string" ? k.value : null,
        }));
      } else if (tr.property === "color") {
        entry.color = tr.keyframes.map((k) => {
          const out: Record<string, unknown> = {
            time: r3(k.time),
            color: spineColor(typeof k.value === "string" ? k.value : "#ffffffff", DEFAULTS.slot.color),
          };
          const c = spineCurve(k);
          if (c !== undefined) out.curve = c;
          return out;
        });
      }
    }
    if (Object.keys(entry).length > 0) animSlots[name] = entry;
  }
  const out: Record<string, unknown> = { bones: animBones };
  if (Object.keys(animSlots).length > 0) out.slots = animSlots;
  return out;
}

export interface ExportOptions {
  /** Optional atlas output, for UV emission in the Spine JSON. */
  atlas?: AtlasOutput;
}

/** The full Spine 4.1 export. Returns a JSON-serialisable object. */
export function exportSpine(project: Project, opts: ExportOptions = {}): Record<string, unknown> {
  // ---- Bones (parent-name lookup, root-first) ----
  const boneNames = new Map<Id, string>();
  for (const id of project.boneOrder) boneNames.set(id, project.bones[id]!.name);
  const boneList: Array<Record<string, unknown>> = [];
  const depthOf = (b: Bone): number => b.parent === null ? 0 : depthOf(project.bones[b.parent]!) + 1;
  const sortedBones = project.boneOrder
    .map((id) => project.bones[id]!)
    .slice()
    .sort((a, b) => depthOf(a) - depthOf(b));
  for (const b of sortedBones) {
    boneList.push(exportBone(b, b.parent === null ? null : project.bones[b.parent]!.name));
  }

  // ---- Slot attachment defaulting ----
  const slotAttachDefault = new Map<Id, string | null>();
  for (const sid of project.slotOrder) {
    const s = project.slots[sid]!;
    if (s.attachment && project.attachments[s.attachment]) {
      slotAttachDefault.set(sid, spineAttachmentName(project.attachments[s.attachment]!));
    } else {
      slotAttachDefault.set(sid, null);
    }
  }

  // ---- Slots ----
  const slotList: Array<Record<string, unknown>> = [];
  for (const sid of project.slotOrder) {
    const s = project.slots[sid]!;
    const boneName = boneNames.get(s.bone);
    if (!boneName) continue;
    slotList.push(exportSlot(s, boneName, slotAttachDefault.get(sid) ?? null));
  }

  // ---- Skins ----
  // Build a region-lookup by attachment name from the atlas, so the UVs
  // we emit match the atlas the user is exporting alongside.
  const regionByName = new Map<string, AtlasOutput["regions"][number]>();
  if (opts.atlas) {
    for (const r of opts.atlas.regions) {
      regionByName.set(r.name, r);
    }
  }

  const skin: Record<string, Record<string, Record<string, unknown>>> = { default: {} };
  for (const sid of project.slotOrder) {
    const s = project.slots[sid]!;
    const skinSlot: Record<string, Record<string, unknown>> = {};
    if (s.attachment) {
      const att = project.attachments[s.attachment];
      if (att) {
        const boneName = boneNames.get(att.bindBone) ?? "?";
        const attName = spineAttachmentName(att);
        // Look up the atlas region for this attachment. If the atlas
        // has the attachment (and it should, we built it from the same
        // project), use its UVs. Otherwise fall back to a default
        // [0,1] range — the runtime will look up the texture by name
        // and the UVs may not match, but it won't crash.
        const r = regionByName.get(attName);
        const uv: AttachmentUV = r
          ? {
              u0: r.x / opts.atlas!.atlasWidth,
              v0: r.y / opts.atlas!.atlasHeight,
              u1: (r.x + r.width) / opts.atlas!.atlasWidth,
              v1: (r.y + r.height) / opts.atlas!.atlasHeight,
            }
          : { u0: 0, v0: 0, u1: 1, v1: 1 };
        skinSlot[attName] = exportMeshAttachment(att, boneName, uv);
      }
    }
    skin.default[s.name] = skinSlot;
  }

  // ---- Meshes (top-level bone-influence data) ----
  const meshes: Array<Record<string, unknown>> = [];
  for (const aid of project.attachmentOrder) {
    const att = project.attachments[aid];
    if (!att) continue;
    meshes.push(exportMeshesEntry(att, boneNames));
  }

  // ---- Animations ----
  const animations: Record<string, unknown> = {};
  for (const aid of project.animationOrder) {
    const anim = project.animations[aid];
    if (!anim) continue;
    animations[anim.name] = exportAnimation(anim, project);
  }

  return {
    skeleton: {
      hash: "sf-spine-export",
      spine: SPINE_VERSION,
      width: project.width,
      height: project.height,
    },
    width: project.width,
    height: project.height,
    fps: project.fps,
    images: "./images/",
    audio: "./audio/",
    bones: boneList,
    slots: slotList,
    skins: skin,
    meshes,
    animations,
  };
}

/** Convenience: produce a JSON string from a Project. */
export function exportSpineJson(project: Project, opts: ExportOptions = {}, pretty = true): string {
  return JSON.stringify(exportSpine(project, opts), null, pretty ? 2 : 0);
}

/** Re-export the spine color helper for use by the atlas exporter. */
export { spineColor };
