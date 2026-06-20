// src/editor/atlas-export.ts
// Pack all attachment images into a single atlas PNG + emit a Spine 4.1
// .atlas text file.
//
// Packing strategy: simple row-major grid with 2px padding. The atlas size
// grows in 256-px increments up to 4096 (the conservative browser-canvas
// upper bound for WebGL 1, and the standard "max texture" for Spine atlases).
// For typical small projects (< 50 attachments of < 256×256) this lands
// inside a 2048×2048 atlas and uploads as a single texture.
//
// The atlas text file is the Spine 4.1 format (one region per attachment).
// Each region name matches the corresponding Spine attachment name in the
// exported JSON, so the runtime can find the texture by attachment name.
//
// This file is the P1.F-b slice. The exported atlas can be loaded by
// spine-ts (any 3.x+) or by the standalone runtime.html in P1.F-c.

import type { Project, Id, MeshAttachment } from "../core/model";
import { downloadBlob } from "./save-load";

/** Per-region record in the atlas. */
export interface AtlasRegion {
  /** Attachment id (matches the model's MeshAttachment.id). */
  id: Id;
  /** Region name in the .atlas file (Spine attachment name). */
  name: string;
  /** X in the atlas. */
  x: number;
  /** Y in the atlas. */
  y: number;
  /** Width in the atlas (= source width for non-rotated regions). */
  width: number;
  /** Height in the atlas (= source height for non-rotated regions). */
  height: number;
  /** Original image dimensions (unaffected by padding). */
  sourceWidth: number;
  /** Original image dimensions (unaffected by padding). */
  sourceHeight: number;
  /** The decoded image as a data URL — we keep this so we can read
   *  pixels to compose the atlas. */
  imageDataUrl: string;
}

/** Full atlas output: PNG + .atlas text + region map. */
export interface AtlasOutput {
  /** Atlas as a PNG data URL. */
  pngDataUrl: string;
  /** Spine 4.1 .atlas text. */
  atlasText: string;
  /** Region records keyed by attachment name (so the caller can look up
   *  UVs by Spine attachment name and apply them to the Spine JSON's
   *  `uvs` arrays). */
  regions: AtlasRegion[];
  /** Final atlas size. */
  atlasWidth: number;
  atlasHeight: number;
  /** Page name (file name of the PNG, also the page header in the
   *  .atlas text). */
  pageName: string;
}

/** Decode a data URL to an HTMLImageElement. Used at build time (we're
 *  already in a browser context; no fetch needed). */
function decodeImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not decode image: ${dataUrl.slice(0, 64)}…`));
    img.src = dataUrl;
  });
}

/** Power-of-two ceiling, capped at 4096. */
function nextAtlasSize(bytes: number): number {
  // 256 is the minimum sane atlas; 4096 is the universal WebGL 1 max.
  let n = 256;
  while (n < bytes && n < 4096) n *= 2;
  return Math.max(n, 256);
}

/** Compose the final atlas PNG and Spine 4.1 .atlas text. */
export async function buildAtlas(
  project: Project,
  pageName = "spriteforge.png"
): Promise<AtlasOutput> {
  // Collect all attachments, dedupe by image data URL (so a sprite that
  // is re-used across attachments becomes a single atlas region).
  // Keyed by imageDataUrl (the bytes, not the name) so two attachments
  // referencing the same PNG get one atlas region with a single name.
  const byHash = new Map<string, AtlasRegion>();
  const dups: Array<{ att: MeshAttachment; shared: string }> = [];

  for (const aid of project.attachmentOrder) {
    const att = project.attachments[aid];
    if (!att) continue;
    const url = att.imageDataUrl;
    if (byHash.has(url)) {
      dups.push({ att, shared: url });
      continue;
    }
    const img = await decodeImage(url);
    byHash.set(url, {
      id: att.id,
      name: att.name.replace(/[^a-zA-Z0-9_]/g, "_") || `att_${att.id.slice(0, 6)}`,
      x: 0,
      y: 0,
      width: img.naturalWidth,
      height: img.naturalHeight,
      sourceWidth: img.naturalWidth,
      sourceHeight: img.naturalHeight,
      imageDataUrl: url,
    });
  }

  // Dedupe the regions list.
  const uniqueRegions = Array.from(byHash.values());
  if (uniqueRegions.length === 0) {
    // No attachments — emit a 256x256 empty atlas so downstream code
    // (Spine JSON) has a real page to point at.
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 256;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "rgba(0,0,0,0)";
    ctx.fillRect(0, 0, 256, 256);
    return {
      pngDataUrl: c.toDataURL("image/png"),
      atlasText: `${pageName}\nsize: 256,256\nformat: RGBA\nfilter: Linear,Linear\nrepeat: none\n`,
      regions: [],
      atlasWidth: 256,
      atlasHeight: 256,
      pageName,
    };
  }

  // Pack row-major. Each region gets padded by 2px on all sides.
  const PAD = 2;
  // Atlas target size: sum of widths * 1.5 padded, rounded up to 256.
  const totalArea = uniqueRegions.reduce(
    (s, r) => s + (r.width + PAD * 2) * (r.height + PAD * 2),
    0
  );
  const initial = nextAtlasSize(Math.max(totalArea, 256));
  let atlasWidth = initial;
  let atlasHeight = initial;

  // Try to lay out in a square-ish grid. If it doesn't fit, grow the atlas.
  // Spine's at most 4096×4096, so cap and emit a warning.
  let cursorX = 0;
  let cursorY = 0;
  let rowH = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    cursorX = 0;
    cursorY = 0;
    rowH = 0;
    let fits = true;
    for (const r of uniqueRegions) {
      const w = r.width + PAD * 2;
      const h = r.height + PAD * 2;
      if (cursorX + w > atlasWidth) {
        cursorX = 0;
        cursorY += rowH;
        rowH = 0;
      }
      if (cursorY + h > atlasHeight) {
        fits = false;
        break;
      }
      r.x = cursorX + PAD;
      r.y = cursorY + PAD;
      cursorX += w;
      rowH = Math.max(rowH, h);
    }
    if (fits) break;
    if (atlasWidth >= 4096 && atlasHeight >= 4096) break;
    if (atlasWidth <= atlasHeight) atlasWidth *= 2;
    else atlasHeight *= 2;
  }

  // Render the atlas.
  const canvas = document.createElement("canvas");
  canvas.width = atlasWidth;
  canvas.height = atlasHeight;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, atlasWidth, atlasHeight);

  for (const r of uniqueRegions) {
    const img = await decodeImage(r.imageDataUrl);
    ctx.drawImage(img, r.x, r.y, r.width, r.height);
  }

  // Build the .atlas text (Spine 4.1 format).
  // Page header:
  //   spriteforge.png
  //   size: 1024,1024
  //   format: RGBA
  //   filter: Linear,Linear
  //   repeat: none
  // Per region:
  //   name
  //     bounds: x,y,width,height
  //     offsets: 0,0,0,0
  //     rotate: false
  //     index: -1
  const lines: string[] = [
    pageName,
    `size: ${atlasWidth},${atlasHeight}`,
    "format: RGBA",
    "filter: Linear,Linear",
    "repeat: none",
    "",
  ];
  for (const r of uniqueRegions) {
    lines.push(r.name);
    lines.push(`  bounds: ${r.x},${r.y},${r.width},${r.height}`);
    lines.push(`  offsets: 0,0,${r.sourceWidth},${r.sourceHeight}`);
    lines.push("  rotate: false");
    lines.push("  index: -1");
    lines.push("");
  }
  // For attachments that share an image, we still need a per-attachment
  // region entry so the runtime can find the same texture under each
  // name. Spine 4.1 supports `index: N` to disambiguate; for a
  // same-name-with-different-attachment case we emit an index.
  // For our case (image deduped) we use the same bounds.
  if (dups.length > 0) {
    for (const { att, shared } of dups) {
      const r = byHash.get(shared)!;
      const name = att.name.replace(/[^a-zA-Z0-9_]/g, "_") || `att_${att.id.slice(0, 6)}`;
      if (name === r.name) continue;
      lines.push(name);
      lines.push(`  bounds: ${r.x},${r.y},${r.width},${r.height}`);
      lines.push(`  offsets: 0,0,${r.sourceWidth},${r.sourceHeight}`);
      lines.push("  rotate: false");
      lines.push("  index: -1");
      lines.push("");
    }
  }

  return {
    pngDataUrl: canvas.toDataURL("image/png"),
    atlasText: lines.join("\n"),
    regions: uniqueRegions,
    atlasWidth,
    atlasHeight,
    pageName,
  };
}

/** Build a per-attachment UV map. The Spine JSON exporter needs to know,
 *  for each attachment's 4 corner verts, what UV to write. We use the
 *  atlas region to compute the UVs. */
export function buildUvMap(
  atlas: AtlasOutput
): Map<Id, { u0: number; v0: number; u1: number; v1: number }> {
  const map = new Map<Id, { u0: number; v0: number; u1: number; v1: number }>();
  for (const r of atlas.regions) {
    const u0 = r.x / atlas.atlasWidth;
    const v0 = r.y / atlas.atlasHeight;
    const u1 = (r.x + r.width) / atlas.atlasWidth;
    const v1 = (r.y + r.height) / atlas.atlasHeight;
    map.set(r.id, { u0, v0, u1, v1 });
  }
  return map;
}

/** Save an atlas (PNG + .atlas text) as a zip-like pair of downloads.
 *  Browsers don't have a built-in zip API, so we trigger two separate
 *  downloads. The user gets:
 *    - spriteforge.png    (the atlas image)
 *    - spriteforge.atlas  (the .atlas text)
 */
export function downloadAtlas(atlas: AtlasOutput): { pngFilename: string; atlasFilename: string; pngBytes: number; atlasBytes: number } {
  const base = atlas.pageName.replace(/\.png$/, "");
  const pngFilename = `${base}.png`;
  const atlasFilename = `${base}.atlas`;
  // Convert data URL → blob so the click goes through URL.createObjectURL
  // (matches the JSON download path; lets test harnesses intercept via
  // URL.createObjectURL patching).
  const pngBlob = dataUrlToBlob(atlas.pngDataUrl, "image/png");
  const atlasBlob = new Blob([atlas.atlasText], { type: "text/plain" });
  triggerDownload(pngBlob, pngFilename);
  triggerDownload(atlasBlob, atlasFilename);
  return {
    pngFilename,
    atlasFilename,
    pngBytes: pngBlob.size,
    atlasBytes: atlas.atlasText.length,
  };
}

function dataUrlToBlob(dataUrl: string, fallbackMime: string): Blob {
  // data:image/png;base64,iVBORw0K...  → Uint8Array
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return new Blob([dataUrl], { type: fallbackMime });
  const head = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  const isBase64 = /;base64$/i.test(head);
  if (isBase64) {
    // atob → Uint8Array
    const bin = atob(body);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const mime = (head.match(/^data:([^;]+)/i) ?? [, fallbackMime])[1];
    return new Blob([u8], { type: mime || fallbackMime });
  }
  return new Blob([decodeURIComponent(body)], { type: fallbackMime });
}

const triggerDownload = downloadBlob;
