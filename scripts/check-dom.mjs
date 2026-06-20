// scripts/check-dom.mjs
// Tiny guard: scans src/editor/**.ts for getElementById("foo") lookups and
// verifies that every "foo" exists as id="foo" in index.html. Scans
// src/runtime/**.ts against runtime.html.
//
// Catches the class of bug where a JS lookup is added but the corresponding
// DOM element is missing or renamed. This was the P1.A boot crash.
//
// Usage:  node scripts/check-dom.mjs
// Exit:   0 = all lookups resolve, 1 = at least one is missing

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML_EDITOR  = path.join(ROOT, "index.html");
const HTML_RUNTIME = path.join(ROOT, "runtime.html");

/** Collect every id="..." in the given file. */
function collectIds(file) {
  if (!fs.existsSync(file)) return new Set();
  const h = fs.readFileSync(file, "utf8");
  const set = new Set();
  for (const m of h.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)) set.add(m[1]);
  return set;
}

const editorIds  = collectIds(HTML_EDITOR);
const runtimeIds = collectIds(HTML_RUNTIME);

/** Recursively yield .ts files in a directory. */
function* walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(p);
    else if (/\.ts$/.test(ent.name)) yield p;
  }
}

const idRe = /getElementById\(\s*["']([^"']+)["']\s*\)/g;
const referenced = new Map();   // id -> [{file, line, target}]

function scan(dir, target) {
  if (!fs.existsSync(dir)) return;
  for (const file of walk(dir)) {
    const src = fs.readFileSync(file, "utf8");
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      let m;
      idRe.lastIndex = 0;
      while ((m = idRe.exec(line)) !== null) {
        const id = m[1];
        if (!referenced.has(id)) referenced.set(id, []);
        referenced.get(id).push({ file: path.relative(ROOT, file), line: i + 1, target });
      }
    });
  }
}

scan(path.join(ROOT, "src/editor"),  "index.html");
scan(path.join(ROOT, "src/runtime"), "runtime.html");

let failed = 0;
console.log(`Scanned ${referenced.size} getElementById() lookups.`);
console.log(`  editor  ids: ${editorIds.size}  ·  runtime ids: ${runtimeIds.size}\n`);

for (const [id, hits] of referenced) {
  const target = hits[0].target;
  const pool = target === "index.html" ? editorIds : runtimeIds;
  if (pool.has(id)) continue;
  failed++;
  console.error(`✗ getElementById("${id}") has no matching id="..." in ${target}`);
  for (const h of hits) console.error(`    ${h.file}:${h.line}`);
}

if (failed > 0) {
  console.error(`\n${failed} missing DOM target(s). Editor will crash on boot.`);
  process.exit(1);
} else {
  console.log("✓ All DOM lookups resolve.");
}
