// src/editor/persistence.ts
// Browser-side persistence layer (FR-PM-2 autosave + FR-PM-3 recent files
// — P2.C).
//
// Both features write to `localStorage` only — no server, no cookies, no
// IndexedDB (NFR-4 says all processing client-side; localStorage is the
// simplest store that survives a tab kill). Quotas vary by browser
// (~5 MiB on Chrome/Firefox), so the autosave honors a soft cap and
// drops the oldest record if writing would overflow.
//
// Keys we own under localStorage:
//   sf.autosave.v1         — JSON wrapper { savedAt, project }
//   sf.recent.v1           — JSON array of { filename, savedAt, bytes }
//
// Both keys are versioned so we can ship breaking changes without
// crashing on older blobs (we just ignore them and start fresh).
//
// Why not IndexedDB? Project files are small (< 1 MB typical), the API
// is sync enough that the 30s autosave doesn't block paint, and the
// debug story is "open DevTools → Application → Local Storage." If we
// later need > 5 MB we'll switch — same shape on the public API here.

import type { Project } from "../core/model";

const KEY_AUTOSAVE = "sf.autosave.v1";
const KEY_RECENT   = "sf.recent.v1";

/** How long between autosaves. FSD FR-PM-2 names 30 seconds; we do the
 *  serialization on a microtask so the next paint is unaffected. */
export const AUTOSAVE_INTERVAL_MS = 30_000;

/** Cap on the recent-files list. 8 is enough for most workflows; longer
 *  lists overflow common menu UIs. */
const RECENT_CAP = 8;

/** Soft cap on the autosave payload. localStorage's hard cap is ~5 MiB
 *  on Chromium / Firefox; we self-limit to 4 MiB so a single big project
 *  doesn't displace the recent-files list or other site-level state. */
const AUTOSAVE_SOFT_CAP_BYTES = 4 * 1024 * 1024;

export interface AutosaveRecord {
  savedAt: string;     // ISO 8601
  bytes: number;       // size of the serialized project (informational)
  /** Stringified .sfproj wrapper. Stored as a string instead of a nested
   *  object so we don't pay double-encode on every read. */
  payload: string;
}

export interface RecentFile {
  filename: string;
  savedAt: string;
  bytes: number;
  /** "save" if produced by Save, "open" if produced by Open. The UI
   *  surfaces this so the user can tell which side of the door each
   *  entry came from. */
  source: "save" | "open";
}

/* ---------- Autosave ---------- */

/** Write the project to the autosave slot. Idempotent; safe to call as
 *  often as you want. Returns false if storage is full (quota exceeded
 *  or self-imposed cap). Synchronous — localStorage writes don't yield. */
export function writeAutosave(project: Project): boolean {
  try {
    // Construct the same wrapper packProject() builds, but stay in
    // string form to avoid a Blob → text round-trip (which is async
    // in spec land — we can't depend on that for an autosave heartbeat).
    const payload = JSON.stringify({
      format: "spriteforge-project",
      version: 1,
      savedAt: new Date().toISOString(),
      project,
    });
    const bytes = payload.length;
    if (bytes > AUTOSAVE_SOFT_CAP_BYTES) {
      // Project too large — clear any stale entry rather than leaving
      // an out-of-date snapshot lying around.
      localStorage.removeItem(KEY_AUTOSAVE);
      return false;
    }
    const rec: AutosaveRecord = {
      savedAt: new Date().toISOString(),
      bytes,
      payload,
    };
    try {
      localStorage.setItem(KEY_AUTOSAVE, JSON.stringify(rec));
      return true;
    } catch {
      // QuotaExceededError or similar — drop the autosave and give up
      // silently. The user's next manual save will replace it.
      try { localStorage.removeItem(KEY_AUTOSAVE); } catch {}
      return false;
    }
  } catch (err) {
    console.error("[autosave] failed:", err);
    return false;
  }
}

/** Read the most recent autosave, or null if none / corrupted. */
export function readAutosave(): AutosaveRecord | null {
  try {
    const raw = localStorage.getItem(KEY_AUTOSAVE);
    if (!raw) return null;
    const obj = JSON.parse(raw) as AutosaveRecord;
    if (!obj || typeof obj.payload !== "string") return null;
    return obj;
  } catch {
    return null;
  }
}

/** Forget the autosave. Call after a successful manual save (the user
 *  is now in control of their persistence again). */
export function clearAutosave(): void {
  try { localStorage.removeItem(KEY_AUTOSAVE); } catch {}
}

/* ---------- Recent files ---------- */

/** Add an entry to the recent-files list. Newest first; deduplicated by
 *  filename (the new entry replaces an older one with the same name);
 *  capped at `RECENT_CAP` total. */
export function pushRecent(entry: RecentFile): void {
  try {
    const list = readRecent();
    const filtered = list.filter((e) => e.filename !== entry.filename);
    filtered.unshift(entry);
    while (filtered.length > RECENT_CAP) filtered.pop();
    localStorage.setItem(KEY_RECENT, JSON.stringify(filtered));
  } catch (err) {
    console.error("[recent] push failed:", err);
  }
}

/** Read the recent-files list, oldest entries dropped. Always returns
 *  an array (empty on first run / corrupted storage). */
export function readRecent(): RecentFile[] {
  try {
    const raw = localStorage.getItem(KEY_RECENT);
    if (!raw) return [];
    const arr = JSON.parse(raw) as RecentFile[];
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((e) => e && typeof e.filename === "string")
      .slice(0, RECENT_CAP);
  } catch {
    return [];
  }
}

/** Wipe the recent-files list (for tests, or a future "Clear Recent" UI). */
export function clearRecent(): void {
  try { localStorage.removeItem(KEY_RECENT); } catch {}
}

/* ---------- Autosave timer ---------- */

/** Manage the periodic autosave loop. Returns a stop() function so
 *  tests / hot reloads can dispose it cleanly. */
export function startAutosaveLoop(getProject: () => Project, intervalMs = AUTOSAVE_INTERVAL_MS): () => void {
  // We snapshot a stringified hash of the project on every tick so we
  // skip the disk write when nothing changed since the last tick. The
  // serialization itself is cheap; the localStorage write triggers a
  // synchronous IO that's the actual cost we want to avoid.
  let lastHash = "";
  const id = setInterval(async () => {
    const proj = getProject();
    try {
      const text = JSON.stringify(proj);
      if (text === lastHash) return;
      lastHash = text;
      writeAutosave(proj);
    } catch (err) {
      console.error("[autosave] tick failed:", err);
    }
  }, intervalMs);

  // Try to flush on tab close — best-effort only, browsers may kill the
  // tab before this finishes. localStorage writes are sync, so we have
  // a fighting chance compared to fetch / IndexedDB.
  const onBeforeUnload = () => {
    try { writeAutosave(getProject()); } catch {}
  };
  window.addEventListener("beforeunload", onBeforeUnload);

  return () => {
    clearInterval(id);
    window.removeEventListener("beforeunload", onBeforeUnload);
  };
}
