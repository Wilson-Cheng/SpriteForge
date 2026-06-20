// src/editor/menu-bar.ts
// Header menubar — File / Tools / Hierarchy / Help dropdown menus that
// mirror the actions also available from the sidebar panels and the
// keyboard shortcuts.
//
// Each menu item just emits a bus event (or, for shortcut display, looks
// up the matching `Shortcut` in `../shared/keymap`). We don't add any new
// behavior — every command surfaced here is already wired in `main.ts`
// or `panels.ts` via the same event name. Disabled items use
// `aria-disabled="true"` and are skipped when clicked.
//
// Design notes:
//   - Plain DOM, no framework. Mirrors panels.ts / timeline.ts style.
//   - Click toggles the active dropdown. Click on a different menu
//     swaps the open one. Click outside (or Escape) closes.
//   - Only one menu is open at a time; the active one is tracked on
//     the menubar root element via `dataset.openIndex`.
//   - Shortcut hints come from `../shared/keymap.SHORTCUTS` so the
//     menubar and the `?` help overlay stay in sync if the keymap
//     changes.

import { bus } from "./bus";
import type { EditorState } from "./store";
import { SHORTCUTS, type Shortcut } from "../shared/keymap";
import { VERSION, APP_REPO_URL } from "../shared/build-info";

/** What a single dropdown row renders. `event` is the bus channel
 *  emitted on click; `shortcutId` (when given) is the `Shortcut.id`
 *  whose key string is shown on the right of the row. A row with
 *  `event === "@separator"` renders as a divider instead. */
interface MenuItem {
  label: string;
  /** Bus event to emit on click, or `"@separator"` for a divider, or
   *  `"@toggleHelp"` to toggle the help overlay (handled inline). */
  event: string;
  /** Shortcut id whose key combo to display, or undefined for none. */
  shortcutId?: string;
  /** Optional predicate. When it returns false, the row is rendered
   *  with `aria-disabled="true"` and clicks are ignored. Re-evaluated
   *  each time the menu opens. */
  enabled?: (state: EditorState) => boolean;
}

interface MenuDef {
  label: string;
  items: MenuItem[];
}

/** Render a key combo like "⌘S" / "⇧W" / "Space" from a Shortcut
 *  record. Mirrors the formatter in main.ts's help panel; duplicating
 *  the few lines avoids adding an import cycle for a presentational
 *  helper. */
function formatKey(s: Shortcut): string {
  const parts: string[] = [];
  if (s.mod) parts.push(navigator.platform.includes("Mac") ? "⌘" : "Ctrl");
  if (s.shift) parts.push("⇧");
  let key = s.key;
  if (key === "space") key = "Space";
  else if (key === "delete") key = "⌫";
  else if (key.length === 1) key = key.toUpperCase();
  parts.push(key);
  return parts.join("");
}

function shortcutLabel(id: string | undefined): string {
  if (!id) return "";
  const s = SHORTCUTS.find((x) => x.id === id);
  return s ? formatKey(s) : "";
}

/** The menu definitions. Order here is the visible left-to-right
 *  order in the header. Items without `event` mirrors of existing
 *  bus channels are intentionally NOT added — we only surface what's
 *  already wired so behavior stays a single source of truth. */
function buildMenus(): MenuDef[] {
  return [
    {
      label: "File",
      items: [
        { label: "New project",          event: "file.new",         shortcutId: "file.new" },
        { label: "Open\u2026",           event: "file.open",        shortcutId: "file.open" },
        { label: "Save",                 event: "file.save",        shortcutId: "file.save" },
        { label: "Recent\u2026",         event: "file.recent",      shortcutId: "file.recent" },
        { label: "@sep",                 event: "@separator" },
        { label: "Insert image\u2026",   event: "file.insert",      shortcutId: "file.insert" },
        { label: "Import Spine\u2026",   event: "file.importSpine" },
        { label: "@sep",                 event: "@separator" },
        { label: "Export Spine bundle", event: "export.spine" },
        { label: "Export MP4 preview",  event: "export.mp4",       shortcutId: "export.mp4" },
      ],
    },
    {
      label: "Edit",
      items: [
        { label: "Undo", event: "edit.undo", shortcutId: "edit.undo" },
        { label: "Redo", event: "edit.redo", shortcutId: "edit.redo" },
      ],
    },
    {
      label: "View",
      items: [
        { label: "Frame all",       event: "view.reset",    shortcutId: "view.reset" },
        { label: "Frame selection", event: "view.frameSel", shortcutId: "view.frameSel" },
        { label: "@sep",            event: "@separator" },
        { label: "Show / hide grid",   event: "view.grid",   shortcutId: "view.grid" },
        { label: "Show / hide bones",  event: "view.bones" },
        { label: "Show / hide images", event: "view.images" },
      ],
    },
    {
      label: "Tools",
      items: [
        { label: "Select / move",       event: "tool.select", shortcutId: "tool.select" },
        { label: "Bone",                event: "tool.bone",   shortcutId: "tool.bone" },
        { label: "Rotate",              event: "tool.rotate", shortcutId: "tool.rotate" },
        { label: "Scale",               event: "tool.scale",  shortcutId: "tool.scale" },
        { label: "@sep",                event: "@separator" },
        { label: "Edit mode",           event: "mode.edit",    shortcutId: "mode.edit" },
        { label: "Pose mode",           event: "mode.pose",    shortcutId: "mode.pose" },
        { label: "Animate mode",        event: "mode.animate", shortcutId: "mode.animate" },
        { label: "@sep",                event: "@separator" },
        { label: "Recompute auto-weights",   event: "mesh.autoWeights", shortcutId: "mesh.autoWeights" },
        { label: "Subdivide mesh",           event: "mesh.subdivide",   shortcutId: "mesh.subdivide" },
        { label: "Cut mesh",                 event: "mesh.cut",         shortcutId: "mesh.cut" },
        { label: "Create two-bone IK",       event: "ik.create",        shortcutId: "ik.create" },
      ],
    },
    {
      label: "Hierarchy",
      items: [
        {
          label: "Add child bone",
          event: "hierarchy.addChild",
          shortcutId: "hierarchy.addChild",
          // Disabled when nothing is selected (the action does work
          // with no selection, falling back to a root bone — but
          // we expose "Add child" as a hierarchy-of-selection action,
          // so the affordance is clearer when greyed out).
          enabled: (s) => s.selection.boneIds.size >= 1,
        },
        { label: "Insert sample sprite", event: "attachment.insertSample", shortcutId: "attachment.insertSample" },
      ],
    },
    {
      label: "Help",
      items: [
        { label: "Keyboard shortcuts\u2026", event: "@toggleHelp" },
        { label: "About SpriteForge\u2026",  event: "@showAbout" }
      ],
    },
  ];
}

/** Mount the menubar into the given container element. The container
 *  is assumed to be the `<nav id="sf-menubar">` declared in
 *  `index.html`. Returns a cleanup function for tests / hot reload. */
export function buildMenuBar(container: HTMLElement, state: EditorState): () => void {
  const defs = buildMenus();

  const html: string[] = [];
  for (let i = 0; i < defs.length; i++) {
    const def = defs[i]!;
    html.push(
      `<div class="sf-menu" data-menu-index="${i}">` +
        `<button class="sf-menu-btn" type="button" aria-haspopup="menu" aria-expanded="false">${escape(def.label)}</button>` +
        `<div class="sf-menu-dropdown" role="menu" data-menu-dropdown="${i}"></div>` +
      `</div>`,
    );
  }
  container.innerHTML = html.join("");

  // Render dropdown bodies. We do this after innerHTML so we can
  // attach listeners directly to each row's element.
  for (let i = 0; i < defs.length; i++) {
    const def = defs[i]!;
    const dropdown = container.querySelector<HTMLElement>(`[data-menu-dropdown="${i}"]`)!;
    renderDropdownBody(dropdown, def, state);
  }

  /** Open the dropdown at index `i`, closing any other. Pass `null`
   *  to close all. Re-runs the disabled-predicate evaluation as part
   *  of opening so menu state matches the current selection. */
  const setOpen = (i: number | null) => {
    for (const el of container.querySelectorAll<HTMLElement>(".sf-menu")) {
      const idx = Number(el.dataset.menuIndex);
      const open = idx === i;
      el.classList.toggle("open", open);
      const btn = el.querySelector<HTMLButtonElement>(".sf-menu-btn");
      if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) {
        // Re-evaluate enabled() on each row.
        const def = defs[idx]!;
        const dropdown = el.querySelector<HTMLElement>(".sf-menu-dropdown")!;
        for (const row of dropdown.querySelectorAll<HTMLElement>(".sf-menu-item")) {
          const itemIdx = Number(row.dataset.itemIndex);
          const it = def.items[itemIdx];
          const enabled = !it?.enabled || it.enabled(state);
          row.setAttribute("aria-disabled", enabled ? "false" : "true");
        }
      }
    }
    container.dataset.openIndex = i === null ? "" : String(i);
  };

  // Click on a menu button toggles its dropdown. Click on a different
  // menu button while one is open swaps directly to that dropdown.
  container.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const btn = target.closest<HTMLElement>(".sf-menu-btn");
    if (btn) {
      const idx = Number((btn.parentElement as HTMLElement).dataset.menuIndex);
      const cur = container.dataset.openIndex;
      setOpen(cur === String(idx) ? null : idx);
      e.stopPropagation();
      return;
    }
    const row = target.closest<HTMLElement>(".sf-menu-item");
    if (!row) return;
    if (row.getAttribute("aria-disabled") === "true") return;
    const event = row.dataset.event;
    if (!event) return;
    setOpen(null);
    handleMenuEvent(event);
    e.stopPropagation();
  });

  // Hover-to-switch: when one menu is already open, hovering over a
  // different menu's button swaps the dropdown without requiring a
  // second click. Standard menubar UX.
  container.addEventListener("mouseover", (e) => {
    if (container.dataset.openIndex === "" || container.dataset.openIndex === undefined) return;
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".sf-menu-btn");
    if (!btn) return;
    const idx = Number((btn.parentElement as HTMLElement).dataset.menuIndex);
    if (String(idx) === container.dataset.openIndex) return;
    setOpen(idx);
  });

  // Click anywhere outside the menubar dismisses the open dropdown.
  // We listen at the document level on mousedown so the close happens
  // before the click bubbles to a downstream handler (the viewport's
  // pointerdown, the timeline's scrub, etc.).
  const onDocDown = (e: MouseEvent) => {
    if (!container.contains(e.target as Node)) setOpen(null);
  };
  document.addEventListener("mousedown", onDocDown, true);

  // Escape closes the open dropdown.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (!container.dataset.openIndex) return;
    setOpen(null);
    e.stopPropagation();
  };
  window.addEventListener("keydown", onKey, true);

  return () => {
    document.removeEventListener("mousedown", onDocDown, true);
    window.removeEventListener("keydown", onKey, true);
  };
}

function renderDropdownBody(parent: HTMLElement, def: MenuDef, _state: EditorState): void {
  const html: string[] = [];
  for (let i = 0; i < def.items.length; i++) {
    const it = def.items[i]!;
    if (it.event === "@separator") {
      html.push(`<div class="sf-menu-sep"></div>`);
      continue;
    }
    const sc = shortcutLabel(it.shortcutId);
    html.push(
      `<div class="sf-menu-item" role="menuitem" data-item-index="${i}" data-event="${escape(it.event)}">` +
        `<span class="sf-menu-label">${escape(it.label)}</span>` +
        (sc ? `<span class="sf-menu-sc">${escape(sc)}</span>` : "") +
      `</div>`,
    );
  }
  parent.innerHTML = html.join("");
}

/** Dispatch a menu item's event. Most route directly to the bus —
 *  the editor already has handlers for these. A couple of special
 *  cases (`@toggleHelp`, `@showAbout`, `@openGithub`) handle their
 *  own behavior inline because there's no existing bus channel for
 *  them. */
function handleMenuEvent(event: string): void {
  if (event === "@toggleHelp") {
    document.getElementById("help")?.classList.toggle("open");
    return;
  }
  if (event === "@showAbout") {
    showAboutDialog();
    return;
  }
  if (event === "@openGithub") {
    window.open(APP_REPO_URL, "_blank", "noopener");
    return;
  }
  bus.emit(event);
}

/** Show an "About SpriteForge" modal: version (mirrored from
 *  package.json via `shared/build-info.ts`), repo link, and a short
 *  description. Built inline so the menubar doesn't grow a dependency
 *  on the editor's `modal.ts` helpers (which are Promise-based and
 *  designed for confirm/alert flows, not read-only info). Reuses the
 *  existing `.sf-modal-*` styles defined in theme-dark.css. */
function showAboutDialog(): void {
  // Bail out if an About dialog is already open — guards against rapid
  // double-clicks re-opening it while the previous overlay is still
  // being torn down by its own dismiss handler.
  if (document.querySelector(".sf-about-overlay")) return;

  const overlay = document.createElement("div");
  overlay.className = "sf-modal-overlay sf-about-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "About SpriteForge");

  const box = document.createElement("div");
  box.className = "sf-modal sf-about";
  overlay.appendChild(box);

  const title = document.createElement("div");
  title.className = "sf-modal-title";
  title.textContent = "About SpriteForge";
  box.appendChild(title);

  const msg = document.createElement("div");
  msg.className = "sf-modal-msg sf-about-msg";
  msg.innerHTML =
    `<div class="sf-about-line"><b>SpriteForge</b> &middot; v${VERSION}</div>` +
    `<div class="sf-about-line sf-muted">Browser-based skeletal 2D sprite animation editor.</div>` +
    `<div class="sf-about-line sf-muted">Spine 4.1 JSON compatible &middot; MIT licensed</div>` +
    `<div class="sf-about-line sf-about-repo">` +
      `<a href="${APP_REPO_URL}" target="_blank" rel="noopener noreferrer">${APP_REPO_URL}</a>` +
    `</div>`;
  box.appendChild(msg);

  const actions = document.createElement("div");
  actions.className = "sf-modal-actions";
  box.appendChild(actions);

  const openRepo = document.createElement("button");
  openRepo.className = "sf-modal-btn";
  openRepo.textContent = "Open on GitHub";
  openRepo.addEventListener("click", () => {
    window.open(APP_REPO_URL, "_blank", "noopener");
    dismiss();
  });
  actions.appendChild(openRepo);

  const copyUrl = document.createElement("button");
  copyUrl.className = "sf-modal-btn";
  copyUrl.textContent = "Copy link";
  copyUrl.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(APP_REPO_URL);
      copyUrl.textContent = "Copied!";
      setTimeout(() => { copyUrl.textContent = "Copy link"; }, 1500);
    } catch {
      // Clipboard API unavailable (insecure context, etc.) — fall back
      // to selecting the link text so the user can copy manually.
      copyUrl.textContent = "Copy failed";
      setTimeout(() => { copyUrl.textContent = "Copy link"; }, 1500);
    }
  });
  actions.appendChild(copyUrl);

  const closeBtn = document.createElement("button");
  closeBtn.className = "sf-modal-btn primary";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", dismiss);
  actions.appendChild(closeBtn);

  document.body.appendChild(overlay);

  function dismiss(): void {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      dismiss();
    } else if (e.key === "Enter" && document.activeElement === closeBtn) {
      e.preventDefault();
      dismiss();
    }
  }
  document.addEventListener("keydown", onKey, true);

  // Backdrop click dismisses, matching the existing modal helpers.
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) dismiss();
  });

  setTimeout(() => closeBtn.focus(), 0);
}

/** Tiny HTML escape — same shape as the one in `shared/dom.ts`,
 *  duplicated locally so this module has zero non-bus imports
 *  besides the keymap (keeps the menubar trivially tree-shakable). */
function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
