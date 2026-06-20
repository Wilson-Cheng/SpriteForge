// Production build: minified ESM, source maps, no watch.
//
// Usage:   npm run build
// Output:  /dist/{editor,runtime}.js (+ .map)
//
// We do per-entry builds with explicit outfiles so the output is flat
// (dist/editor.js, dist/runtime.js) instead of nested under the entry
// filename (dist/editor/main.js).

import * as esbuild from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const FFMPEG_VENDOR = path.join(ROOT, "public", "vendor", "ffmpeg");

const ENTRIES = {
  editor:  "src/editor/main.ts",
  runtime: "src/runtime/main.ts",
};

async function copyFfmpegAssets() {
  await fs.mkdir(FFMPEG_VENDOR, { recursive: true });
  const ffmpegEsm = path.join(ROOT, "node_modules", "@ffmpeg", "ffmpeg", "dist", "esm");
  const coreEsm = path.join(ROOT, "node_modules", "@ffmpeg", "core", "dist", "esm");
  for (const file of ["worker.js", "const.js", "errors.js"]) {
    await fs.copyFile(path.join(ffmpegEsm, file), path.join(FFMPEG_VENDOR, file));
  }
  for (const file of ["ffmpeg-core.js", "ffmpeg-core.wasm"]) {
    await fs.copyFile(path.join(coreEsm, file), path.join(FFMPEG_VENDOR, file));
  }
}

await copyFfmpegAssets();

await Promise.all(
  Object.entries(ENTRIES).map(([name, entry]) =>
    esbuild.build({
      entryPoints: [entry],
      bundle: true,
      outfile: path.join(DIST, `${name}.js`),
      format: "esm",
      target: ["es2022", "chrome110", "firefox110", "safari16"],
      sourcemap: true,
      minify: true,
      logLevel: "info",
    })
  )
);

console.log("  ➜  build complete → ./dist/");
