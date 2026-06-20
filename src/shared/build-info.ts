// Build-info constants. The dev script writes BUILD_ID at rebuild time;
// VERSION is mirrored from package.json so the editor's Help → About
// and footer stay in sync with the published release.
//
// VERSION follows semver; we bump major on data-model breaks, minor on
// new editor features, patch on bug fixes. Keep this in lockstep with
// `package.json` `version`.

export const VERSION = "0.8.0";

/** Human-readable build identifier. The dev server overwrites this on
 *  rebuild (see scripts/dev.mjs). For release builds it stays at the
 *  literal "release". */
export const BUILD_ID = "p0-skeleton";

/** Canonical project repository URL — surfaced in Help → About and any
 *  other "open on GitHub" affordances. */
export const APP_REPO_URL = "https://github.com/Wilson-Cheng/SpriteForge";
