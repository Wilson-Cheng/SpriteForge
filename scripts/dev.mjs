// Dev script: esbuild watch (per-entry, flat output) + a tiny static server
// + livereload via SSE.
//
// Usage:   npm run dev
// Opens:   http://localhost:5173/index.html
//
// Output:  /dist/editor.js  +  /dist/runtime.js   (flat, per-entry)
// Livereload: page listens on /__livereload SSE, calls location.reload() on
// the "reload" event. The dev server broadcasts after every esbuild rebuild.

import * as esbuild from "esbuild";
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const DIST = path.join(ROOT, "dist");
const FFMPEG_VENDOR = path.join(ROOT, "public", "vendor", "ffmpeg");
const PORT = Number(process.env.PORT ?? 5173);

const ENTRIES = {
  editor:  "src/editor/main.ts",
  runtime: "src/runtime/main.ts",
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".webp": "image/webp",
  ".ico":  "image/x-icon",
  ".map":  "application/json; charset=utf-8",
  ".wasm": "application/wasm",
};

// Set of connected SSE clients for livereload.
const sseClients = new Set();

function broadcastReload() {
  for (const res of sseClients) {
    try { res.write("event: reload\ndata: 1\n\n"); } catch { /* client gone */ }
  }
}

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const target = path.normalize(path.join(root, decoded));
  if (!target.startsWith(root)) return null;
  return target;
}

async function copyFfmpegAssets() {
  await fsp.mkdir(FFMPEG_VENDOR, { recursive: true });
  const ffmpegEsm = path.join(ROOT, "node_modules", "@ffmpeg", "ffmpeg", "dist", "esm");
  const coreEsm = path.join(ROOT, "node_modules", "@ffmpeg", "core", "dist", "esm");
  for (const file of ["worker.js", "const.js", "errors.js"]) {
    await fsp.copyFile(path.join(ffmpegEsm, file), path.join(FFMPEG_VENDOR, file));
  }
  for (const file of ["ffmpeg-core.js", "ffmpeg-core.wasm"]) {
    await fsp.copyFile(path.join(coreEsm, file), path.join(FFMPEG_VENDOR, file));
  }
}

await copyFfmpegAssets();

function serveStatic(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let pathname = url.pathname;

  if (pathname === "/__livereload") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    });
    res.write(": connected\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (pathname === "/") pathname = "/index.html";

  const filePath = safeJoin(ROOT, pathname);
  if (!filePath) { res.writeHead(403).end("forbidden"); return; }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404).end("not found"); return; }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cache-Control": "no-store",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(serveStatic);
server.listen(PORT, () => {
  console.log(`\n  ➜  SpriteForge dev server`);
  console.log(`     Editor:   http://localhost:${PORT}/index.html`);
  console.log(`     Runtime:  http://localhost:${PORT}/runtime.html`);
  console.log(`     Livereload: enabled (SSE)\n`);
});

// esbuild context: watch mode, one per entry, flat output.
const contexts = await Promise.all(
  Object.entries(ENTRIES).map(([name, entry]) =>
    esbuild.context({
      entryPoints: [path.join(ROOT, entry)],
      bundle: true,
      outfile: path.join(DIST, `${name}.js`),
      format: "esm",
      target: ["es2022"],
      sourcemap: true,
      logLevel: "info",
    })
  )
);

await Promise.all(contexts.map((ctx) => ctx.watch()));
console.log(`  ➜  esbuild watching ${Object.keys(ENTRIES).length} entries…`);

// On every rebuild, bump the build-hash in index.html (cache-buster for
// the bundle script) and push a "reload" event to all SSE clients.
const INDEX_HTML = path.join(ROOT, "index.html");
let pendingBump = null;
async function bumpBuildVersion() {
  // hash = short prefix of the build epoch + the editor bundle's mtime+size,
  // so it changes every rebuild but stays stable for the lifetime of a build.
  try {
    const editorPath = path.join(DIST, "editor.js");
    const st = await fsp.stat(editorPath);
    const hash = crypto
      .createHash("sha1")
      .update(`${st.mtimeMs}|${st.size}|${Date.now()}`)
      .digest("hex")
      .slice(0, 8);
    const html = await fsp.readFile(INDEX_HTML, "utf8");
    if (html.includes(`editor.js?v=BUILD_VERSION`)) {
      // first run after the marker was added — replace the literal token
      const next = html.replace(
        `editor.js?v=BUILD_VERSION`,
        `editor.js?v=${hash}`,
      );
      await fsp.writeFile(INDEX_HTML, next, "utf8");
    } else if (html.match(/editor\.js\?v=([a-f0-9]+)/)) {
      const next = html.replace(/editor\.js\?v=([a-f0-9]+)/, `editor.js?v=${hash}`);
      await fsp.writeFile(INDEX_HTML, next, "utf8");
    }
  } catch (e) {
    // non-fatal — first build may not have written the bundle yet
  }
  broadcastReload();
}

// esbuild's watch() doesn't expose a "rebuild done" hook directly, so we
// poll the editor.js mtime. 250ms is responsive enough for livereload.
let lastMtime = 0;
setInterval(async () => {
  try {
    const st = await fsp.stat(path.join(DIST, "editor.js"));
    if (st.mtimeMs !== lastMtime) {
      if (lastMtime !== 0) await bumpBuildVersion();
      lastMtime = st.mtimeMs;
    }
  } catch { /* bundle not written yet */ }
}, 250).unref?.();
