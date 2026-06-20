// src/editor/save-load.ts
// .sfproj file save/load.
//
// A .sfproj file is a JSON document with a tiny wrapper:
//
//   {
//     "format": "spriteforge-project",
//     "version": 1,
//     "savedAt": "2026-06-18T07:00:00.000Z",
//     "project": { ...full Project state, including images as data URLs... }
//   }
//
// The wrapper carries three things the user cares about:
//   1. `format` — string-checked on load so we don't try to parse
//      random .sfproj files that are actually a different tool's output.
//   2. `version` — the wrapper's own version (independent of
//      `Project.version`, which is the data-model schema version).
//      Bumped if the wrapper layout changes (e.g. to add an `author` field).
//   3. `savedAt` — ISO-8601 timestamp of the save.
//
// Future-proofing: we *could* ship a migration system keyed on
// `Project.version`, but for now we only have v4 and the schema is
// stable. If a load produces a different `Project.version`, the loader
// refuses and asks the user to upgrade the editor.
//
// All images travel inline as data URLs. For a typical small project
// (< 5MB of textures) the file is < 5MB which is fine for blob downloads.
// For larger projects, P2 will add an "external textures" option.

import type { Project } from "../core/model";

const SFPROJ_FORMAT = "spriteforge-project";
const SFPROJ_WRAPPER_VERSION = 1;

export interface SFPROJ {
  format: typeof SFPROJ_FORMAT;
  version: number;
  savedAt: string;
  project: Project;
}

export interface SaveResult {
  blob: Blob;
  filename: string;
  bytes: number;
}

export interface LoadResult {
  project: Project;
  filename: string;
  warnings: string[];
}

/** Slugify a freeform string into a filesystem-safe lower-kebab-case
 *  base name. Returns `fallback` (default "untitled") if the result
 *  would be empty. Used to derive .sfproj / .json / .png / .atlas /
 *  preview file names from `Project.name`. */
export function slugifyName(name: string | undefined | null, fallback = "untitled"): string {
  return (name || fallback)
    .replace(/[^a-z0-9_\-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || fallback;
}

/** Build a `.sfproj` Blob from a Project. */
export function packProject(project: Project, filenameBase?: string): SaveResult {
  // Shallow-clone so we don't mutate the live project.
  const clone: Project = JSON.parse(JSON.stringify(project));
  const safeName = slugifyName(filenameBase || clone.name);
  const doc: SFPROJ = {
    format: SFPROJ_FORMAT,
    version: SFPROJ_WRAPPER_VERSION,
    savedAt: new Date().toISOString(),
    project: clone,
  };
  const json = JSON.stringify(doc, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  return {
    blob,
    filename: `${safeName}.sfproj`,
    bytes: blob.size,
  };
}

/** Parse a `.sfproj` Blob into a Project. Throws on bad input. */
export async function unpackProject(
  file: File,
  expectedProjectVersion: number
): Promise<LoadResult> {
  const text = await file.text();
  let doc: any;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Error(`File is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof doc !== "object" || doc === null) {
    throw new Error("File root is not an object");
  }
  if (doc.format !== SFPROJ_FORMAT) {
    throw new Error(
      `Wrong format: expected "${SFPROJ_FORMAT}", got "${String(doc.format)}"`
    );
  }
  if (typeof doc.version !== "number") {
    throw new Error("Wrapper version is missing or not a number");
  }
  if (doc.version > SFPROJ_WRAPPER_VERSION) {
    throw new Error(
      `File was saved with a newer version of SpriteForge (v${doc.version}). ` +
        `This editor understands up to v${SFPROJ_WRAPPER_VERSION}.`
    );
  }
  if (!doc.project || typeof doc.project !== "object") {
    throw new Error("Project payload is missing");
  }
  const proj = doc.project as Project;
  if (typeof proj.version !== "number") {
    throw new Error("Project schema version is missing or not a number");
  }
  if (proj.version !== expectedProjectVersion) {
    throw new Error(
      `Project schema version mismatch: file is v${proj.version}, ` +
        `editor expects v${expectedProjectVersion}.`
    );
  }
  const warnings: string[] = [];
  // Sanity check: warn if no bones or no animations.
  if (!proj.boneOrder || proj.boneOrder.length === 0) {
    warnings.push("Project has no bones");
  }
  if (!proj.animationOrder || proj.animationOrder.length === 0) {
    warnings.push("Project has no animations — playback will be empty");
  }
  // Sanity check: dangling references. Skip the heavy fixup — let the
  // caller decide what to do (probably just warn).
  for (const id of proj.boneOrder) {
    if (!proj.bones[id]) {
      warnings.push(`Bone id "${id}" is in boneOrder but not in bones map`);
    }
  }
  for (const id of proj.slotOrder) {
    if (!proj.slots[id]) {
      warnings.push(`Slot id "${id}" is in slotOrder but not in slots map`);
    }
  }
  return {
    project: proj,
    filename: file.name,
    warnings,
  };
}

/** Trigger a browser download of a Blob. No-op outside a browser. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 0);
}

/** Save a project, preferring the File System Access API's
 *  `showSaveFilePicker` over the legacy download path. The FSA path
 *  gives a proper native "Save As" dialog where the user can navigate
 *  freely and overwrite any existing `.sfproj` file (including one
 *  whose name differs from the suggested filename) — the legacy
 *  `<a download>` path can gray out non-matching files in some
 *  browsers' download UI.
 *
 *  After a successful FSA save we keep the file handle in module
 *  scope so the next call with the same handle can write silently
 *  (true Save behavior — Cmd+S doesn't re-prompt). Pass `forcePicker`
 *  to always show the dialog (e.g. for "Save As" / Shift+Cmd+S).
 *
 *  Falls back to `downloadBlob` on browsers without FSA support.
 *  Returns the chosen filename (or null if the user cancelled). */
let cachedHandle: any = null; // FileSystemFileHandle, untyped to avoid DOM lib deps

export async function saveProject(
  project: Project,
  opts: { suggestedName?: string; forcePicker?: boolean } = {}
): Promise<{ filename: string; bytes: number; via: "fsa" | "download" } | null> {
  const { blob, filename, bytes } = packProject(project, opts.suggestedName);
  const suggestedName = filename;

  const canFsa =
    typeof window !== "undefined" &&
    "showSaveFilePicker" in window;

  if (canFsa) {
    // Silent re-save when we already have a writable handle and the
    // caller didn't force the picker.
    if (!opts.forcePicker && cachedHandle) {
      try {
        // createWritable() prompts the user for permission the first
        // time per session; subsequent writes are silent.
        if ((await cachedHandle.queryPermission({ mode: "readwrite" })) !== "granted") {
          await cachedHandle.requestPermission({ mode: "readwrite" });
        }
        const writable = await cachedHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        return { filename: cachedHandle.name ?? suggestedName, bytes, via: "fsa" };
      } catch (err) {
        // Permission denied / user dismissed the prompt — fall through
        // to the picker so they can pick a different file.
        cachedHandle = null;
      }
    }

    try {
      const handle = await (window as any).showSaveFilePicker({
        suggestedName,
        types: [
          {
            description: "SpriteForge project",
            accept: { "application/json": [".sfproj"] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      cachedHandle = handle;
      return { filename: handle.name ?? suggestedName, bytes, via: "fsa" };
    } catch (err) {
      // User cancelled (AbortError) or the platform refused — fall
      // back to a regular download so their work is not lost.
      if ((err as DOMException)?.name === "AbortError") return null;
      downloadBlob(blob, suggestedName);
      return { filename: suggestedName, bytes, via: "download" };
    }
  }

  // No FSA — legacy download path.
  downloadBlob(blob, suggestedName);
  return { filename: suggestedName, bytes, via: "download" };
}

/** Drop the cached file handle (e.g. after New Project or Load, since
 *  the in-memory handle no longer points at the file backing the
 *  current project). */
export function clearCachedSaveHandle(): void {
  cachedHandle = null;
}

/** Pick a File from a `<input type="file">` change event. */
export function pickFile(accept = ".sfproj,application/json"): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    input.addEventListener("change", () => {
      const file = input.files && input.files[0] ? input.files[0] : null;
      input.remove();
      resolve(file);
    });
    document.body.appendChild(input);
    input.click();
  });
}
