// src/editor/spine-import.ts
// Partial Spine 4.x JSON import (FSD §14.3 — P2.5.c).
//
// Goal: take a 3-file Spine 4.1 bundle (`.json` + `.atlas` + page PNG)
// and produce a Project the editor can open. Reverses the export
// pipeline in [spine-export.ts](src/editor/spine-export.ts).
//
// What we support:
//   - Skeleton: width / height / fps from `skeleton`
//   - Bones: full FK transform (parent / x / y / rotation / scaleX /
//     scaleY / length / color)
//   - Slots: bone binding, default attachment, slot color (→ tint)
//   - Default skin only: region & mesh attachments
//   - Animations: bones.{translate, rotate, scale}, slots.{attachment, color}
//
// What we explicitly drop, with a warning log entry per occurrence:
//   - IK / transform / path constraints
//   - Multi-skin (only "default" is imported; others are dropped)
//   - FFD / deform tracks
//   - Events
//   - Draw-order tracks
//   - Linked meshes (we drop and log; the user can re-bind manually)
//   - Weighted mesh vertices (we coerce to single-bone, weight 1, on
//     the slot's bind bone)
//   - Multi-page atlases (the second + page is dropped — the editor
//     does its own packing on export anyway)
//
// All of this is per the user's choice in the P2.A questionnaire:
// "partial import — drop unsupported features with a warning, don't
// fail the import."
//
// Relation to atlas: every region a slot's attachment refers to is
// looked up in the atlas, the corresponding rectangle is sliced from
// the page PNG into a per-attachment data URL. After import every
// attachment is self-contained — the original .atlas / page PNG can
// be discarded; export will rebuild them.

import type {
  Project, Bone, Slot, MeshAttachment, Animation, Track, Keyframe, Vertex, Triangle, Id,
} from "../core/model";
import { newId, createDefaultProject, BONE_PALETTE } from "../core/model";

/* ---------- Atlas parser ---------- */

export interface AtlasRegion {
  name: string;
  /** Top-left corner in image pixels. */
  x: number;
  y: number;
  /** Region size in image pixels. */
  w: number;
  h: number;
  /** Was the region rotated 90° during packing? Almost always false
   *  for editor-level files; we don't currently handle rotated
   *  regions, but we record the flag and warn on import. */
  rotated: boolean;
}

export interface ParsedAtlas {
  page: { filename: string; width: number; height: number };
  regions: Map<string, AtlasRegion>;
}

/** Convert Spine 4.x data to the editor's y-down world. Spine 4.x
 *  bones are stored in a y-up convention (Y axis points "screen up"
 *  in the Spine-viewer); the editor is y-down. We Y-flip *positions*
 *  so the rig lands in the right vertical region of the project.
 *  Rotations are also *negated*: in y-up a positive rotation is CCW
 *  from +X toward +Y (up), but in y-down it must be CW (toward +Y=down)
 *  to point the same visual direction. Negating the angle converts
 *  CCW-y-up → CW-y-down while keeping cos (x-axis) unchanged and
 *  flipping the sign of sin (y-axis). */
const flipY = (v: number): number => -v;
const spriteForgeHash = (doc: Record<string, unknown>): string => {
  const skel = (doc.skeleton ?? {}) as Record<string, unknown>;
  return typeof skel.hash === "string" ? skel.hash : "";
};
const isLegacySpriteForgeExport = (doc: Record<string, unknown>): boolean => spriteForgeHash(doc) === "sf-project";
const usesSpriteForgeAtlasUvs = (doc: Record<string, unknown>): boolean => ["sf-project", "sf-spine-export"].includes(spriteForgeHash(doc));

/** Parse a Spine 4.x text atlas. Returns the FIRST page's regions —
 *  multi-page atlases are not supported (we log a warning). */
export function parseAtlas(text: string): { atlas: ParsedAtlas; warnings: string[] } {
  const warnings: string[] = [];
  const lines = text.split(/\r?\n/);
  let i = 0;
  // Skip leading blank lines.
  while (i < lines.length && lines[i]!.trim() === "") i++;
  if (i >= lines.length) throw new Error("Atlas is empty");
  const filename = lines[i++]!.trim();
  let pageW = 0, pageH = 0;
  // Header lines like "size: w, h", "filter: Linear,Linear" — stop as
  // soon as a non-blank line doesn't look like a header key/value, or
  // we hit a blank line. The Spine atlases produced by the official
  // Spine editor use TAB indentation on header / region lines, and the
  // // header can be followed directly by a region name (no blank line),
  // so we can't rely on a blank-line delimiter alone.
  while (i < lines.length && lines[i]!.trim() !== "") {
    const m = lines[i]!.trim().match(/^([a-z]+):\s*(.+)$/i);
    if (!m) break;  // Not a key:value pair → it's a region name. Stop.
    if (m[1] === "size") {
      const [w, h] = m[2]!.split(",").map((s) => parseInt(s.trim(), 10));
      if (Number.isFinite(w)) pageW = w!;
      if (Number.isFinite(h)) pageH = h!;
    }
    i++;
  }
  // Detect a second page — Spine supports multi-page atlases, separated
  // by a blank line + a new filename. We log and abort the import for
  // pages 2+; the editor's exporter packs everything onto one page anyway.
  const regions = new Map<string, AtlasRegion>();
  while (i < lines.length) {
    while (i < lines.length && lines[i]!.trim() === "") i++;
    if (i >= lines.length) break;
    const next = lines[i]!.trim();
    if (next.match(/\.(png|jpe?g|webp)$/i)) {
      warnings.push(`Atlas page "${next}" was dropped — only the first page (${filename}) is imported.`);
      break;
    }
    // Region block. The first line is the region name.
    const name = next;
    i++;
    let x = 0, y = 0, w = 0, h = 0, rotated = false;
    while (i < lines.length && lines[i]!.trim() !== "") {
      const m = lines[i]!.trim().match(/^([a-z]+):\s*(.+)$/i);
      // A non-blank, non-key:value line means we've hit the next
      // region name. Leave `i` pointing at it so the outer loop
      // picks it up.
      if (!m) break;
      const k = m[1]!.toLowerCase();
      const v = m[2]!.trim();
      if (k === "xy" || k === "bounds") {
        const parts = v.split(",").map((s) => parseInt(s.trim(), 10));
        x = parts[0] ?? 0; y = parts[1] ?? 0;
        if (k === "bounds") { w = parts[2] ?? 0; h = parts[3] ?? 0; }
      } else if (k === "size") {
        const parts = v.split(",").map((s) => parseInt(s.trim(), 10));
        w = parts[0] ?? 0; h = parts[1] ?? 0;
      } else if (k === "rotate") {
        rotated = v.toLowerCase() === "true" || v === "90";
      }
      i++;
    }
    if (rotated) {
      warnings.push(`Atlas region "${name}" is rotated — vertices will not be re-oriented; the imported sprite may render rotated 90°.`);
    }
    regions.set(name, { name, x, y, w, h, rotated });
  }
  return {
    atlas: { page: { filename, width: pageW, height: pageH }, regions },
    warnings,
  };
}

/* ---------- Spine JSON → Project ---------- */

export interface SpineImportResult {
  project: Project;
  warnings: string[];
}

/** Parse a Spine 4.x JSON document and produce a Project, accompanied
 *  by an atlas and the page image (for slicing per-attachment data
 *  URLs). All three inputs are required — we don't do JSON-only
 *  imports because attachments without UVs are degenerate. */
export async function importSpineProject(
  spineJsonText: string,
  atlasText: string,
  pageImage: HTMLImageElement,
): Promise<SpineImportResult> {
  const warnings: string[] = [];
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(spineJsonText) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Spine JSON parse failed: ${(err as Error).message}`);
  }
  const skel = (doc.skeleton ?? {}) as Record<string, unknown>;
  const legacySpriteForgeExport = isLegacySpriteForgeExport(doc);
  const spriteForgeAtlasUvs = usesSpriteForgeAtlasUvs(doc);
  const toEditorY = (v: number): number => legacySpriteForgeExport ? v : flipY(v);
  const toEditorRot = (v: number): number => legacySpriteForgeExport ? v : -v;
  const spineVer = typeof skel.spine === "string" ? skel.spine : null;
  if (spineVer && !spineVer.startsWith("4.")) {
    warnings.push(`Spine version "${spineVer}" is not 4.x — import may produce incorrect results.`);
  }

  const project = createDefaultProject(typeof skel.name === "string" ? skel.name : "imported");
  if (typeof skel.width === "number") project.width = skel.width;
  if (typeof skel.height === "number") project.height = skel.height;
  if (typeof skel.fps === "number") project.fps = skel.fps;
  // Wipe the default seed animation — we'll rebuild from the import.
  project.animations = {};
  project.animationOrder = [];

  // Bones. Spine 4.x data is in a y-up world; our editor is y-down.
  // We Y-flip positions (see localY) and *negate* rotations. In y-up
  // a positive rotation is CCW from +X toward +Y (up); in y-down it
  // must be CW (toward +Y=down) to point the same visual direction.
  // Negating the angle flips the sign of sin while keeping cos, which
  // is exactly what's needed. Length is the bone's gizmo length, a
  // positive scalar in both systems.
  // Spine stores the skeleton at world offset (skel.x, skel.y) so the
  // skeleton's bounding box starts at (0,0) in the Spine game world.
  // Our project extends from (0, 0) to (width, height). We shift the
  // root bone(s) by -skel.x, -skel.y so the whole rig lands inside the
  // project rectangle. Descendant bone positions are parent-relative
  // and must NOT get the skel shift — applying it to every bone
  // independently creates spurious offsets.
  const skelX = typeof skel.x === "number" ? skel.x : 0;
  const skelY = typeof skel.y === "number" ? skel.y : 0;
  const localX = (v: number): number => v - skelX;
  const localY = (v: number): number => toEditorY(v) - skelY;
  const boneNameToId = new Map<string, Id>();
  const bones = Array.isArray(doc.bones) ? doc.bones as Array<Record<string, unknown>> : [];
  let palettePos = 0;
  for (const b of bones) {
    const name = String(b.name ?? "");
    if (!name) continue;
    const id = newId();
    boneNameToId.set(name, id);
    const bone: Bone = {
      id,
      name,
      parent: typeof b.parent === "string" ? null /* fixed up below once everyone has an id */ : null,
      // skel offset applies only to root bones (those without a parent
      // string). Descendants inherit the shift through the parent chain.
      x: typeof b.parent === "string"
        ? (typeof b.x === "number" ? b.x : 0)
        : (typeof b.x === "number" ? localX(b.x) : localX(0)),
      y: typeof b.parent === "string"
        ? (typeof b.y === "number" ? toEditorY(b.y) : 0)
        : (typeof b.y === "number" ? localY(b.y) : localY(0)),
      rotation: typeof b.rotation === "number" ? toEditorRot(b.rotation) : 0,
      scaleX: typeof b.scaleX === "number" ? b.scaleX : 1,
      scaleY: typeof b.scaleY === "number" ? b.scaleY : 1,
      length: typeof b.length === "number" ? b.length : 0,
      // Spine 4.x inherit: "noRotationOrReflection" — rotation / scale /
      // reflection are not inherited from the parent. Used by the foot
      // and weapon bones in the official hero example so they stay
      // world-aligned when the shin / hand rotates. Default = "normal"
      // (all transforms inherited), which is also what older projects
      // and Spine 3.x exports use.
      inherit: b.inherit === "noRotationOrReflection" ? "noRotationOrReflection" : "normal",
      color: typeof b.color === "string" ? "#" + b.color.slice(0, 6).toLowerCase() : (BONE_PALETTE[palettePos % BONE_PALETTE.length] ?? BONE_PALETTE[0]!),
    };
    palettePos++;
    project.bones[id] = bone;
    project.boneOrder.push(id);
  }
  // Second pass — wire parents now that every bone has an id.
  for (const b of bones) {
    const name = String(b.name ?? "");
    if (!name) continue;
    const id = boneNameToId.get(name)!;
    const parentName = typeof b.parent === "string" ? b.parent : null;
    if (parentName === null) {
      project.bones[id]!.parent = null;
      if (!project.rootIds.includes(id)) project.rootIds.push(id);
    } else {
      const pid = boneNameToId.get(parentName);
      project.bones[id]!.parent = pid ?? null;
      if (!pid) {
        warnings.push(`Bone "${name}" references missing parent "${parentName}" — promoted to root.`);
        if (!project.rootIds.includes(id)) project.rootIds.push(id);
      }
    }
  }

  /* Slots */
  const slotNameToId = new Map<string, Id>();
  const slotDefaultAttachment = new Map<Id, string | null>();
  const slotsArr = Array.isArray(doc.slots) ? doc.slots as Array<Record<string, unknown>> : [];
  for (const s of slotsArr) {
    const name = String(s.name ?? "");
    if (!name) continue;
    const boneName = typeof s.bone === "string" ? s.bone : "";
    const boneId = boneNameToId.get(boneName);
    if (!boneId) {
      warnings.push(`Slot "${name}" references missing bone "${boneName}" — slot dropped.`);
      continue;
    }
    const id = newId();
    slotNameToId.set(name, id);
    const slot: Slot = {
      id,
      name,
      bone: boneId,
      attachment: null, // resolved after attachments load
    };
    if (typeof s.color === "string") slot.tint = "#" + s.color.toLowerCase();
    project.slots[id] = slot;
    project.slotOrder.push(id);
    slotDefaultAttachment.set(id, typeof s.attachment === "string" ? s.attachment : null);
  }

  /* Constraints — all dropped with warning */
  for (const k of ["ik", "transform", "path"] as const) {
    const arr = doc[k];
    if (Array.isArray(arr) && arr.length > 0) {
      warnings.push(`${arr.length} ${k}-constraint(s) dropped — SpriteForge does not yet support these (P3+).`);
    }
  }

  /* Skins → attachments. Only the "default" skin is imported. */
  const { atlas, warnings: atlasWarnings } = parseAtlas(atlasText);
  warnings.push(...atlasWarnings);
  const skinsArr = Array.isArray(doc.skins) ? doc.skins as Array<Record<string, unknown>> : [];
  let defaultSkin: Record<string, unknown> | null = null;
  for (const sk of skinsArr) {
    if (sk.name === "default") defaultSkin = sk;
    else warnings.push(`Skin "${String(sk.name)}" dropped — only the "default" skin is imported (multi-skin support is P3+).`);
  }
  // Older Spine JSONs use `{ "skin": { "default": {...} } }` (object,
  // not array). Handle both.
  const skinObj = !Array.isArray(doc.skins) && typeof doc.skins === "object" && doc.skins !== null
    ? (doc.skins as Record<string, unknown>) : null;
  const defaultAttachments = (defaultSkin?.attachments ?? skinObj?.default ?? {}) as Record<string, Record<string, Record<string, unknown>>>;

  // Each attachment becomes one MeshAttachment. We walk slots to keep
  // ordering consistent with the source JSON.
  const attachmentNameToId = new Map<string /* slot.attName */, Id>();
  for (const slotName of Object.keys(defaultAttachments)) {
    const slotId = slotNameToId.get(slotName);
    if (!slotId) {
      warnings.push(`Attachments for slot "${slotName}" dropped — slot not found.`);
      continue;
    }
    const slotEntries = defaultAttachments[slotName] ?? {};
    for (const attName of Object.keys(slotEntries)) {
      const att = slotEntries[attName] ?? {};
      const type = String(att.type ?? "region");
      const skip = ["boundingbox", "path", "point", "clipping"];
      if (skip.includes(type)) {
        warnings.push(`Attachment "${attName}" (type=${type}) dropped — SpriteForge currently supports region/mesh only.`);
        continue;
      }
      if (type === "linkedmesh") {
        warnings.push(`Linked-mesh attachment "${attName}" dropped — re-link manually after import (P3+).`);
        continue;
      }
      const path = String(att.path ?? attName);
      const region = atlas.regions.get(path);
      if (!region) {
        warnings.push(`Attachment "${attName}" references atlas region "${path}" not found in the .atlas — dropped.`);
        continue;
      }
      const slot = project.slots[slotId]!;
      const attachmentId = await buildAttachmentFromSpine(
        att, region, attName, slot.bone, pageImage, warnings,
      );
      if (!attachmentId) continue;
      // Spine region attachments carry an offset (x, y) and rotation
      // that offset the image from the bone's head. Without applying
      // them, every attachment would render centered on the bone head
      // — so the body sprite (x=33.8, y=2.6, rot=-92.7°) would draw
      // on top of the bone gizmo instead of down the spine. Apply them
      // here so the imported project looks like the source rig.
      const offX = typeof att.x === "number" ? att.x : 0;
      // Y-flip the attachment's y offset. Rotation is NOT flipped —
      // see flipY docstring.
      const offY = typeof att.y === "number" ? toEditorY(att.y) : 0;
      const offR = typeof att.rotation === "number" ? toEditorRot(att.rotation) : 0;
      const stored: MeshAttachment = (await sliceRegionIntoAttachment(
        attachmentId, attName, region, slot.bone, pageImage,
        offX, offY, offR,
      ))!;
      // Apply per-attachment vertices / triangles parsed from the JSON
      // if the type is "mesh"; otherwise leave the stored quad alone.
      if (type === "mesh") {
        applyMeshDataFromSpine(stored, att, slot.bone, warnings, toEditorY, spriteForgeAtlasUvs ? region : null, atlas.page.width, atlas.page.height);
      }
      project.attachments[stored.id] = stored;
      project.attachmentOrder.push(stored.id);
      attachmentNameToId.set(`${slotName}|${attName}`, stored.id);
    }
  }
  // Resolve each slot's default attachment.
  for (const [slotId, attName] of slotDefaultAttachment) {
    if (!attName) continue;
    const slot = project.slots[slotId]!;
    const id = attachmentNameToId.get(`${slot.name}|${attName}`);
    if (id) slot.attachment = id;
  }

  /* Events */
  const events = doc.events;
  if (events && typeof events === "object" && Object.keys(events).length > 0) {
    warnings.push(`${Object.keys(events).length} event(s) dropped — SpriteForge does not yet model events (P3+).`);
  }

  /* Animations */
  const animsObj = (doc.animations ?? {}) as Record<string, Record<string, unknown>>;
  for (const animName of Object.keys(animsObj)) {
    const src = animsObj[animName] ?? {};
    const id = newId();
    const tracks: Track[] = [];
    let maxTime = 0;
    // Bone tracks
    const animBones = (src.bones ?? {}) as Record<string, Record<string, unknown>>;
    for (const boneName of Object.keys(animBones)) {
      const boneId = boneNameToId.get(boneName);
      if (!boneId) {
        warnings.push(`Animation "${animName}" references missing bone "${boneName}" — track dropped.`);
        continue;
      }
      const bt = animBones[boneName] ?? {};
      const bone = project.bones[boneId];
      if (!bone) continue;
      // Translate. Spine 4.x stores translate keyframe values as
      // additive offsets from the bone's bind pose, NOT absolute
      // positions. Our FK evaluator (evalPoseWithSamples) replaces
      // bone.x/y with the sample — so we must convert to absolute by
      // adding the bone's bind-pose position here. We also Y-flip
      // the y-offset to match our y-down world (see flipY docstring).
      if (Array.isArray(bt.translate)) {
        const kfs: Keyframe[] = [];
        for (const k of bt.translate) {
          const kk = k as Record<string, unknown>;
          const time = typeof kk.time === "number" ? kk.time : 0;
          const offX = typeof kk.x === "number" ? kk.x : 0;
          const offY = typeof kk.y === "number" ? toEditorY(kk.y) : 0;
          // Abs position = bind-pose position + flipped offset
          const absX = bone.x + offX;
          const absY = bone.y + offY;
          kfs.push(spineKfToOurs(time, { x: absX, y: absY }, kk.curve));
          if (time > maxTime) maxTime = time;
        }
        tracks.push({ kind: "bone", boneId, property: "translate", keyframes: kfs });
      }
      // Rotate. Same as translate: Spine stores additive values
      // relative to the bone's bind-pose rotation. Convert to
      // absolute so the FK evaluator sees the final angle.
      if (Array.isArray(bt.rotate)) {
        const kfs: Keyframe[] = [];
        for (const k of bt.rotate) {
          const kk = k as Record<string, unknown>;
          const time = typeof kk.time === "number" ? kk.time : 0;
          const offAngle = typeof kk.angle === "number" ? kk.angle : (typeof kk.value === "number" ? kk.value : 0);
          // Abs rotation = -(bind-pose + offset) = negated(bind) - offset
          const absAngle = bone.rotation - offAngle;
          kfs.push(spineKfToOurs(time, absAngle, kk.curve));
          if (time > maxTime) maxTime = time;
        }
        // Normalize Spine bezier control points to [0,1] space.
        // Spine stores bezier CPs in VALUE space (degrees); our
        // easeWithBezier expects normalized [0,1] proportions.
        // Without this, cp2y=-15.4° causes 93° overshoot at mid-span.
        normalizeBezierCurves(kfs, (a, b) => {
          const denom = (a.value as number) - (b.value as number);
          if (Math.abs(denom) < 0.001) return false;
          a.cp1y = ((a.cp1y ?? 0) - bone.rotation + (a.value as number)) / denom;
          a.cp2y = ((a.cp2y ?? 1) - bone.rotation + (a.value as number)) / denom;
          return true;
        });
        tracks.push({ kind: "bone", boneId, property: "rotation", keyframes: kfs });
      }
      // Scale. Spine stores multiplicative factors relative to the
      // bone's bind-pose scale. Convert to absolute for the evaluator.
      if (Array.isArray(bt.scale)) {
        const kfs: Keyframe[] = [];
        for (const k of bt.scale) {
          const kk = k as Record<string, unknown>;
          const time = typeof kk.time === "number" ? kk.time : 0;
          const offSx = typeof kk.x === "number" ? kk.x : 1;
          const offSy = typeof kk.y === "number" ? kk.y : 1;
          // Abs scale = bind-pose scale * factor
          const absX = (bone.scaleX ?? 1) * offSx;
          const absY = (bone.scaleY ?? 1) * offSy;
          kfs.push(spineKfToOurs(time, { x: absX, y: absY }, kk.curve));
          if (time > maxTime) maxTime = time;
        }
        tracks.push({ kind: "bone", boneId, property: "scale", keyframes: kfs });
      }
    }
    // Slot tracks
    const animSlots = (src.slots ?? {}) as Record<string, Record<string, unknown>>;
    for (const slotName of Object.keys(animSlots)) {
      const slotId = slotNameToId.get(slotName);
      if (!slotId) {
        warnings.push(`Animation "${animName}" references missing slot "${slotName}" — track dropped.`);
        continue;
      }
      const st = animSlots[slotName] ?? {};
      // attachment swap track
      if (Array.isArray(st.attachment)) {
        const kfs: Keyframe[] = [];
        for (const k of st.attachment) {
          const kk = k as Record<string, unknown>;
          const time = typeof kk.time === "number" ? kk.time : 0;
          const name = typeof kk.name === "string" ? kk.name : "";
          // Map attachment name → our id.
          const attId = name ? (attachmentNameToId.get(`${slotName}|${name}`) ?? "") : "";
          kfs.push({ time, value: attId, curve: "stepped" });
          if (time > maxTime) maxTime = time;
        }
        tracks.push({ kind: "slot", slotId, property: "attachment", keyframes: kfs });
      }
      // color tint track
      if (Array.isArray(st.color)) {
        const kfs: Keyframe[] = [];
        for (const k of st.color) {
          const kk = k as Record<string, unknown>;
          const time = typeof kk.time === "number" ? kk.time : 0;
          const color = typeof kk.color === "string" ? "#" + kk.color.toLowerCase() : "#ffffffff";
          kfs.push(spineKfToOurs(time, color, kk.curve));
          if (time > maxTime) maxTime = time;
        }
        tracks.push({ kind: "slot", slotId, property: "color", keyframes: kfs });
      }
    }
    // Drop FFD / draw-order / events with warnings
    if (src.deform) warnings.push(`Animation "${animName}" has FFD/deform tracks — dropped (P3+).`);
    if (src.drawOrder) warnings.push(`Animation "${animName}" has draw-order tracks — dropped (P3+).`);
    if (src.events) warnings.push(`Animation "${animName}" has event tracks — dropped (P3+).`);
    if (src.ik) warnings.push(`Animation "${animName}" has IK tracks — dropped (P3+).`);

    const anim: Animation = {
      id, name: animName, duration: Math.max(0.5, maxTime), looping: true, tracks,
    };
    project.animations[id] = anim;
    project.animationOrder.push(id);
  }
  if (project.animationOrder.length > 0) {
    project.activeAnimationId = project.animationOrder[0]!;
  } else {
    // No imported animation — recreate the default placeholder.
    const placeholder: Animation = {
      id: newId(), name: "idle", duration: 1.0, looping: true, tracks: [],
    };
    project.animations[placeholder.id] = placeholder;
    project.animationOrder.push(placeholder.id);
    project.activeAnimationId = placeholder.id;
  }

  return { project, warnings };
}

/* ---------- Helpers ---------- */

/** Convert a Spine keyframe `curve` field (string "stepped", or 4-tuple
 *  bezier control points, or absent) into our Keyframe shape. Default
 *  curve is linear when the field is absent. */
function spineKfToOurs(time: number, value: Keyframe["value"], curve: unknown): Keyframe {
  const out: Keyframe = { time, value, curve: "linear" };
  if (curve === "stepped") {
    out.curve = "stepped";
  } else if (Array.isArray(curve) && curve.length === 4) {
    out.curve = "bezier";
    out.cp1x = +(curve[0] ?? 0); out.cp1y = +(curve[1] ?? 0);
    out.cp2x = +(curve[2] ?? 1); out.cp2y = +(curve[3] ?? 1);
  }
  return out;
}

/** Normalize Spine bezier control points on a keyframe array from
 *  Spine value space (degrees) to [0,1] proportions expected by our
 *  easing system. `normalizePair` receives adjacent keyframes (a, b)
 *  and should set a.cp1y / a.cp2y to [0,1]; returning false skips
 *  the segment (keeping it linear). */
function normalizeBezierCurves(
  kfs: Keyframe[],
  normalizePair: (a: Keyframe, b: Keyframe) => boolean,
): void {
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]!, b = kfs[i + 1]!;
    if (a.curve !== "bezier") continue;
    if (!normalizePair(a, b)) { a.curve = "linear"; continue; }
  }
}

/** Slice a region from the page image into a fresh data URL and wrap
 *  it in a MeshAttachment with a single-bone weight. The caller can
 *  later overwrite vertices/triangles for type === "mesh" attachments. */
async function sliceRegionIntoAttachment(
  attachmentId: Id,
  attName: string,
  region: AtlasRegion,
  bindBone: Id,
  pageImage: HTMLImageElement,
  offX = 0,
  offY = 0,
  offRot = 0,
): Promise<MeshAttachment | null> {
  const canvas = document.createElement("canvas");
  canvas.width = region.w;
  canvas.height = region.h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(pageImage, region.x, region.y, region.w, region.h, 0, 0, region.w, region.h);
  const dataUrl = canvas.toDataURL("image/png");
  // Build the quad corners in bone-local space, then apply the
  // Spine attachment's offset and rotation around the bone head.
  // The "image up" direction in the Spine 4.x data corresponds to
  // the image's top of canvas (head of torso, neck, etc.), which is
  // -Y in the image's local space. In the editor's y-down bone-local
  // space, image -Y is **also** -Y, so we put the image's top edge
  // at the smaller y values of the quad. The world rotation that
  // the editor applies (math y-up matrix on a y-down screen) takes
  // care of mapping the bone-local orientation to the screen.
  const w2 = region.w / 2;
  const h2 = region.h / 2;
  // Note the order: we want (BL, BR, TR, TL) to match the convention
  // of the editor's other attachments (bone-local "BL" = bottom-left
  // on screen), and the UVs to match the convention of the editor's
  // other attachments (UV.y = 1 at the top of the image). The Y
  // component is NEGATED in the raw quad so that the image's "up"
  // (-Y in image-local, which is the head of the torso) lands at
  // the top of the screen in the editor's y-down world.
  const raw: Array<[number, number]> = [
    [-w2, -h2],  // "BL" — image top-left
    [ w2, -h2],  // "BR" — image top-right
    [ w2,  h2],  // "TR" — image bottom-right
    [-w2,  h2],  // "TL" — image bottom-left
  ];
  const r = (offRot * Math.PI) / 180;
  const cosR = Math.cos(r);
  const sinR = Math.sin(r);
  const verts: Vertex[] = raw.map(([x, y]) => {
    const xr = x * cosR - y * sinR;
    const yr = x * sinR + y * cosR;
    return {
      x: xr + offX,
      y: yr + offY,
      bones: [bindBone, bindBone, bindBone, bindBone],
      weights: [1, 0, 0, 0],
    };
  });
  return {
    id: attachmentId,
    name: attName,
    imageDataUrl: dataUrl,
    imageWidth: region.w,
    imageHeight: region.h,
    vertices: verts,
    triangles: [
      { a: 0, b: 1, c: 2 },
      { a: 0, b: 2, c: 3 },
    ],
    // UVs match the editor's other attachments (V=1 at the top of
    // the image because UNPACK_FLIP_Y_WEBGL is true at upload time).
    // The image is now correctly oriented: image "up" (head) is at
    // bone-local -Y, which is the top of the image on screen.
    uvs: [
      { u: 0, v: 1 }, { u: 1, v: 1 }, { u: 1, v: 0 }, { u: 0, v: 0 },
    ],
    bindBone,
    boneRefs: [bindBone],
  };
}

async function buildAttachmentFromSpine(
  _att: Record<string, unknown>,
  _region: AtlasRegion,
  _attName: string,
  _bindBone: Id,
  _pageImage: HTMLImageElement,
  _warnings: string[],
): Promise<Id | null> {
  // Just allocate a fresh id — the actual building happens in
  // sliceRegionIntoAttachment. Kept as a separate seam so future
  // callers (e.g. linked-mesh resolution) can hook here.
  return newId();
}

/** Apply Spine "type=mesh" vertex/triangle data on top of the
 *  default-quad attachment we built from the atlas region. Spine has
 *  two vertex formats:
 *    - "flat": vertices is [x, y, x, y, ...]  (no skinning)
 *    - "weighted": vertices is [boneCount, boneIdx, x, y, w, ...] (skinned)
 *  We support flat fully; weighted is coerced to single-bone per
 *  vertex with weight 1 on the slot's bind bone (with a warning). */
function applyMeshDataFromSpine(
  stored: MeshAttachment,
  src: Record<string, unknown>,
  bindBone: Id,
  warnings: string[],
  toEditorY: (v: number) => number,
  atlasRegion: AtlasRegion | null,
  atlasW: number,
  atlasH: number,
): void {
  const triangles = Array.isArray(src.triangles) ? src.triangles as number[] : null;
  const verticesField = Array.isArray(src.vertices) ? src.vertices as number[] : null;
  const uvsField = Array.isArray(src.uvs) ? src.uvs as number[] : null;
  if (!triangles || !verticesField) return;
  // Detect weighted: weighted vertex format starts each vertex with
  // a bone count. The flat format's length is exactly 2 × N (N = uvs/2).
  const expectedFlatLen = uvsField ? uvsField.length : -1;
  const isFlat = verticesField.length === expectedFlatLen;
  const verts: Vertex[] = [];
  if (isFlat) {
    for (let i = 0; i + 1 < verticesField.length; i += 2) {
      verts.push({
        x: verticesField[i] ?? 0,
        // Y-flip mesh vertex y too — same reason as bone.y.
        y: toEditorY(verticesField[i + 1] ?? 0),
        bones: [bindBone, bindBone, bindBone, bindBone],
        weights: [1, 0, 0, 0],
      });
    }
  } else {
    warnings.push(`Mesh "${stored.name}" uses weighted vertices — coerced to single-bone (weights are lost).`);
    // Walk the weighted format: [n, idx0, x0, y0, w0, idx1, ..., n2, ...]
    let i = 0;
    while (i < verticesField.length) {
      const n = verticesField[i++] ?? 0;
      let avgX = 0, avgY = 0, totW = 0;
      for (let k = 0; k < n; k++) {
        // const idx = verticesField[i++]; (we don't use the bone index)
        i++;
        const vx = verticesField[i++] ?? 0;
        const vy = verticesField[i++] ?? 0;
        const vw = verticesField[i++] ?? 0;
        avgX += vx * vw; avgY += vy * vw; totW += vw;
      }
      if (totW <= 0) totW = 1;
      verts.push({
        x: avgX / totW,
        y: toEditorY(avgY / totW),
        bones: [bindBone, bindBone, bindBone, bindBone],
        weights: [1, 0, 0, 0],
      });
    }
  }
  const tris: Triangle[] = [];
  for (let i = 0; i + 2 < triangles.length; i += 3) {
    tris.push({ a: triangles[i]!, b: triangles[i + 1]!, c: triangles[i + 2]! });
  }
  stored.vertices = verts;
  stored.triangles = tris;
  if (uvsField) {
    // Spine 4.x mesh UVs are in y-up image space (V=0 at bottom, V=1
    // at top, matching OpenGL/WebGL). Our WebGL renderer sets
    // UNPACK_FLIP_Y_WEBGL=true so V=0 is the bottom of the texture,
    // V=1 is the top. Spine's V=0..1 maps directly to ours — no
    // V flip needed. The Y-flip on the world coordinates (the parent
    // bone + the vertex y) is what makes the rendered image upright
    // on screen; the UV space is independent of world Y.
    const uvs: Array<{ u: number; v: number }> = [];
    const u0 = atlasRegion && atlasW > 0 ? atlasRegion.x / atlasW : 0;
    const v0 = atlasRegion && atlasH > 0 ? atlasRegion.y / atlasH : 0;
    const du = atlasRegion && atlasW > 0 ? atlasRegion.w / atlasW : 1;
    const dv = atlasRegion && atlasH > 0 ? atlasRegion.h / atlasH : 1;
    for (let i = 0; i + 1 < uvsField.length; i += 2) {
      const rawU = uvsField[i] ?? 0;
      const rawV = uvsField[i + 1] ?? 0;
      uvs.push({
        u: atlasRegion ? (rawU - u0) / du : rawU,
        v: atlasRegion ? 1 - (rawV - v0) / dv : rawV,
      });
    }
    stored.uvs = uvs;
  }
}
