// src/editor/export-helpers.ts
// Bundle-export helpers: turn the in-memory Project into the 3 files a
// user can drop into a Spine runtime (or the standalone runtime.html
// we ship in `runtime/runtime.html`):
//
//   1. <name>.json     — Spine 4.1 JSON (bones, slots, meshes, skins, anims)
//   2. <name>.png      — atlas PNG
//   3. <name>.atlas    — atlas text (Spine 4.1 format)
//
// All three are downloaded as a single user gesture (one button click
// triggers 3 anchor-downloads — most browsers batch them under a
// "download 3 files?" prompt which is fine).

import type { Project } from "../core/model";
import { exportSpineJson } from "./spine-export";
import { buildAtlas, downloadAtlas } from "./atlas-export";
import { downloadBlob, slugifyName } from "./save-load";

/** A complete bundle export. */
export interface BundleResult {
  jsonFilename: string;
  jsonBytes: number;
  pngFilename: string;
  pngBytes: number;
  atlasFilename: string;
  atlasBytes: number;
}

/** Download all 3 files of a SpriteForge → Spine bundle. */
export async function downloadBundle(project: Project): Promise<BundleResult> {
  // Build the atlas first (it's needed for the UVs in the Spine JSON).
  const atlas = await buildAtlas(project, "spriteforge.png");
  // Build the Spine JSON using the atlas's UVs.
  const json = exportSpineJson(project, { atlas }, true);

  // Derive filenames.
  const safeName = slugifyName(project.name);
  const jsonFilename = `${safeName}.json`;
  const pngFilename = `${safeName}.png`;
  const atlasFilename = `${safeName}.atlas`;

  // Download the JSON.
  downloadBlob(new Blob([json], { type: "application/json" }), jsonFilename);
  // Download the atlas (PNG + .atlas text in one helper call).
  const atlasResult = downloadAtlas({ ...atlas, pageName: pngFilename });

  return {
    jsonFilename,
    jsonBytes: json.length,
    pngFilename: atlasResult.pngFilename,
    pngBytes: atlasResult.pngBytes,
    atlasFilename: atlasResult.atlasFilename,
    atlasBytes: atlasResult.atlasBytes,
  };
}

// Re-export for compatibility with anything that may have imported the
// old internal helper. Prefer importing `downloadBlob` from save-load.
export { downloadBlob as triggerDownload };
