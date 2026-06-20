// src/editor/sprite-sheet.ts
// Sprite-sheet import (FR-AI-3 — P2.F). Slices a packed atlas image into
// separate attachments, one per frame.
//
// We support two metadata formats:
//
//   1. TexturePacker JSON-Hash (most common). The JSON file looks like:
//        { "frames": {
//            "head.png":  { "frame": {"x":0,"y":0,"w":64,"h":64}, ... },
//            "torso.png": { "frame": {"x":64,"y":0,"w":96,"h":128}, ... }
//          },
//          "meta": { "image": "atlas.png", "size": {"w":256,"h":256} } }
//      Anything outside `frames[*].frame` is ignored — we don't need
//      `pivot`, `rotated`, or `spriteSourceSize` because our quad
//      attachments don't carry that metadata yet.
//
//   2. TexturePacker JSON-Array (less common but easy to support):
//        { "frames": [
//            { "filename": "head.png", "frame": {...} },
//            ...
//          ] }
//
//   3. Uniform grid (no JSON). The caller provides cols × rows and we
//      slice the image into equal cells.
//
// On a successful slice, we create one MeshAttachment per frame, each
// bound to the same target bone (the user can re-parent later). The
// original atlas image is not retained — each attachment carries its
// own data URL so save/load and undo work without a side-channel.

import type { Project, Id, MeshAttachment, Slot } from "../core/model";
import { createQuadAttachment, addAttachment, type LoadedImage } from "./attachments";

/** A single frame's bounding box in the atlas. */
export interface SheetFrame {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** TexturePacker-style JSON metadata. Both Hash and Array shapes flow
 *  through `parseSheetMetadata` into the same `SheetFrame[]`. */
export interface SheetMetadata {
  frames: SheetFrame[];
  imageWidth?: number;
  imageHeight?: number;
}

/** Parse a TexturePacker JSON-Hash or JSON-Array document. Throws
 *  with a helpful message on malformed input. */
export function parseSheetMetadata(json: string): SheetMetadata {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch (err) {
    throw new Error(`Sprite-sheet metadata is not valid JSON: ${(err as Error).message}`);
  }
  if (!doc || typeof doc !== "object") {
    throw new Error("Sprite-sheet metadata root must be an object");
  }
  const frames = (doc as { frames?: unknown }).frames;
  const out: SheetFrame[] = [];
  if (Array.isArray(frames)) {
    for (const e of frames) {
      const fr = parseFrameRect((e as { frame?: unknown }).frame, (e as { filename?: string }).filename);
      if (fr) out.push(fr);
    }
  } else if (frames && typeof frames === "object") {
    for (const [name, e] of Object.entries(frames as Record<string, unknown>)) {
      const fr = parseFrameRect((e as { frame?: unknown }).frame, name);
      if (fr) out.push(fr);
    }
  } else {
    throw new Error("Sprite-sheet metadata is missing a `frames` field");
  }
  if (out.length === 0) {
    throw new Error("Sprite-sheet has zero frames — nothing to import");
  }
  // Optional `meta.size` for sanity.
  const meta = (doc as { meta?: { size?: { w?: number; h?: number } } }).meta;
  return {
    frames: out,
    imageWidth: meta?.size?.w,
    imageHeight: meta?.size?.h,
  };
}

function parseFrameRect(rect: unknown, name: string | undefined): SheetFrame | null {
  if (!rect || typeof rect !== "object") return null;
  const r = rect as { x?: number; y?: number; w?: number; h?: number };
  if (typeof r.x !== "number" || typeof r.y !== "number" ||
      typeof r.w !== "number" || typeof r.h !== "number") return null;
  return { name: name || `frame_${r.x}_${r.y}`, x: r.x, y: r.y, w: r.w, h: r.h };
}

/** Build a uniform grid metadata block (FR-AI-3 path 3). */
export function buildGridMetadata(
  imageWidth: number, imageHeight: number, cols: number, rows: number,
  baseName = "frame",
): SheetMetadata {
  if (cols <= 0 || rows <= 0) throw new Error("Grid cols/rows must be positive");
  const cw = Math.floor(imageWidth  / cols);
  const ch = Math.floor(imageHeight / rows);
  const frames: SheetFrame[] = [];
  let i = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      frames.push({
        name: `${baseName}_${i++}`,
        x: c * cw,
        y: r * ch,
        w: cw,
        h: ch,
      });
    }
  }
  return { frames, imageWidth, imageHeight };
}

/** Slice one frame out of the source image into a fresh data URL. We
 *  draw onto a CSS-pixel-sized OffscreenCanvas (fall-back to regular
 *  canvas) and read back as PNG. Tested against typical 64–256 px
 *  frames; for larger frames the time is dominated by toDataURL, not
 *  drawImage. Async because image decoding is async on some
 *  browsers. */
export async function sliceFrame(sourceImage: HTMLImageElement, frame: SheetFrame): Promise<LoadedImage> {
  const canvas = document.createElement("canvas");
  canvas.width = frame.w;
  canvas.height = frame.h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D context for slice");
  ctx.drawImage(sourceImage, frame.x, frame.y, frame.w, frame.h, 0, 0, frame.w, frame.h);
  const dataUrl = canvas.toDataURL("image/png");
  return { dataUrl, width: frame.w, height: frame.h };
}

/** Import a sprite sheet end-to-end: slice each frame, create one
 *  attachment per frame, bind them all to `bindBone`, and return the
 *  list of created slot ids. Frames are processed sequentially so the
 *  caller sees deterministic ordering in the panel. */
export async function importSpriteSheet(
  project: Project,
  bindBone: Id,
  sourceImage: HTMLImageElement,
  metadata: SheetMetadata,
): Promise<{ attachmentIds: Id[]; slotIds: Id[]; warnings: string[] }> {
  const warnings: string[] = [];
  if (!project.bones[bindBone]) {
    throw new Error(`Bind bone "${bindBone}" not found in project`);
  }
  if (metadata.imageWidth && metadata.imageWidth !== sourceImage.naturalWidth) {
    warnings.push(`Metadata image width (${metadata.imageWidth}) doesn't match the loaded image (${sourceImage.naturalWidth}) — proceeding anyway.`);
  }
  if (metadata.imageHeight && metadata.imageHeight !== sourceImage.naturalHeight) {
    warnings.push(`Metadata image height (${metadata.imageHeight}) doesn't match the loaded image (${sourceImage.naturalHeight}) — proceeding anyway.`);
  }
  const attachmentIds: Id[] = [];
  const slotIds: Id[] = [];
  for (const frame of metadata.frames) {
    // Skip out-of-bounds frames defensively (some atlases have padding
    // frames at integer coords that overshoot the image by 1 px).
    if (frame.x + frame.w > sourceImage.naturalWidth || frame.y + frame.h > sourceImage.naturalHeight) {
      warnings.push(`Frame "${frame.name}" overflows the image bounds — skipped.`);
      continue;
    }
    const sliced = await sliceFrame(sourceImage, frame);
    const att: MeshAttachment = createQuadAttachment(project, bindBone, sliced);
    // Take the frame name (sans extension) as the attachment name so
    // the user recognises it in the panel.
    att.name = frame.name.replace(/\.(png|jpe?g|webp)$/i, "");
    const slot: Slot = addAttachment(project, att);
    attachmentIds.push(att.id);
    slotIds.push(slot.id);
  }
  return { attachmentIds, slotIds, warnings };
}
