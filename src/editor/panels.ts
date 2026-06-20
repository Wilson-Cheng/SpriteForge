// src/editor/panels.ts
// Side-panel UI: tool palette, hierarchy tree, and inspector for the
// selected bone(s). Pure DOM — no framework.

import type { EditorState, Tool } from "./store";
import { setTool, reparentBone, selectBones, selectBone, removeBone, addBone, setKeyframe, deleteKeyframeAt, clearSelection, type KeyframeRef } from "./store";
import { bus, EV } from "./bus";
import { confirmDialog } from "./modal";
import type { Bone, Id, MeshAttachment } from "../core/model";
import { uniqueName } from "../core/model";
import { evalBoneWorld, evalPoseWithSamples, sampleAnimation } from "../core/eval";
import { walkTree, descendantCount } from "./hierarchy-ops";
import { removeAttachment } from "./attachments";
import { autoKeyRecord } from "./timeline";
import { getActiveAnimation } from "./store";
import { PLAYBACK_EV } from "./playback";
import { escapeHtml } from "../shared/dom";

/* ---------- tool palette ---------- */

export function buildToolPalette(parent: HTMLElement, state: EditorState): void {
  parent.innerHTML = `
    <div class="panel-header">Tools</div>
    <div class="tool-row">
      <button class="tool-btn" data-tool="select" title="Select / move (V)">
        <svg viewBox="0 0 24 24" width="20" height="20"><path d="M5 3l14 8-6 1-2 8-6-17z" fill="currentColor"/></svg>
        <span>Select</span>
        <kbd>V</kbd>
      </button>
      <button class="tool-btn" data-tool="bone" title="Bone tool (B)">
        <svg viewBox="0 0 24 24" width="20" height="20">
          <circle cx="6" cy="12" r="3" fill="currentColor"/>
          <line x1="6" y1="12" x2="20" y2="12" stroke="currentColor" stroke-width="3"/>
          <circle cx="20" cy="12" r="2.5" fill="none" stroke="currentColor" stroke-width="2"/>
        </svg>
        <span>Bone</span>
        <kbd>B</kbd>
      </button>
      <button class="tool-btn" data-tool="rotate" title="Rotate bone — drag a selected bone to rotate around its head (R)">
        <svg viewBox="0 0 24 24" width="20" height="20">
          <path d="M12 4a8 8 0 1 0 7.5 5.2" fill="none" stroke="currentColor" stroke-width="2"/>
          <path d="M19 4v4h-4" fill="none" stroke="currentColor" stroke-width="2"/>
        </svg>
        <span>Rotate</span>
        <kbd>R</kbd>
      </button>
      <button class="tool-btn" data-tool="scale" title="Scale bone — drag a selected bone to scale away from its head (Q)">
        <svg viewBox="0 0 24 24" width="20" height="20">
          <rect x="3" y="3" width="8" height="8" fill="none" stroke="currentColor" stroke-width="2"/>
          <rect x="13" y="13" width="8" height="8" fill="currentColor"/>
        </svg>
        <span>Scale</span>
        <kbd>Q</kbd>
      </button>
    </div>
    <div class="panel-subhdr">Hierarchy</div>
    <div class="tool-row">
      <button class="tool-btn small" id="h-add-child" title="Add child bone (N)">
        <svg viewBox="0 0 24 24" width="18" height="18">
          <circle cx="12" cy="6" r="2.5" fill="currentColor"/>
          <line x1="12" y1="6" x2="12" y2="18" stroke="currentColor" stroke-width="2.5"/>
          <line x1="6" y1="14" x2="18" y2="14" stroke="currentColor" stroke-width="2.5"/>
        </svg>
        <span>Child</span>
        <kbd>N</kbd>
      </button>
      <button class="tool-btn small" id="h-make-root" title="Make selected bone a root">
        <svg viewBox="0 0 24 24" width="18" height="18">
          <circle cx="6" cy="6" r="2.5" fill="currentColor"/>
          <line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="2.5"/>
        </svg>
        <span>Root</span>
      </button>
    </div>
    <div class="panel-subhdr">File</div>
    <div class="tool-row">
      <button class="tool-btn small" id="h-new" title="New project (⌘/Ctrl+N) — clears the current project after a confirm">
        <svg viewBox="0 0 24 24" width="18" height="18">
          <path d="M6 3h9l4 4v14H6z" fill="none" stroke="currentColor" stroke-width="2"/>
          <path d="M14 3v5h5" fill="none" stroke="currentColor" stroke-width="2"/>
          <line x1="12" y1="11" x2="12" y2="17" stroke="currentColor" stroke-width="2"/>
          <line x1="9" y1="14" x2="15" y2="14" stroke="currentColor" stroke-width="2"/>
        </svg>
        <span>New</span>
        <kbd>⌘N</kbd>
      </button>
      <button class="tool-btn small" id="h-save" title="Save project to a .sfproj file (⌘/Ctrl+S)">
        <svg viewBox="0 0 24 24" width="18" height="18">
          <path d="M5 4h11l3 3v13H5z" fill="none" stroke="currentColor" stroke-width="2"/>
          <path d="M7 4v5h9V4" fill="none" stroke="currentColor" stroke-width="2"/>
        </svg>
        <span>Save</span>
        <kbd>⌘S</kbd>
      </button>
      <button class="tool-btn small" id="h-open" title="Open a .sfproj file (⌘/Ctrl+O)">
        <svg viewBox="0 0 24 24" width="18" height="18">
          <path d="M3 7h6l2 2h10v10H3z" fill="none" stroke="currentColor" stroke-width="2"/>
        </svg>
        <span>Open</span>
        <kbd>⌘O</kbd>
      </button>
      <button class="tool-btn small" id="h-import-spine" title="Import a Spine 4.1 bundle (.json + .atlas + .png) — choose all three at once">
        <svg viewBox="0 0 24 24" width="18" height="18">
          <path d="M4 4h16v6H4zM4 14h10v6H4z" fill="none" stroke="currentColor" stroke-width="2"/>
          <path d="M17 13l3 3-3 3M20 16h-7" fill="none" stroke="currentColor" stroke-width="2"/>
        </svg>
        <span>Spine</span>
      </button>
      <button class="tool-btn small" id="h-insert" title="Insert image attachment from a PNG/JPG (⌘/Ctrl+I)">
        <svg viewBox="0 0 24 24" width="18" height="18">
          <rect x="3" y="5" width="18" height="14" fill="none" stroke="currentColor" stroke-width="2"/>
          <circle cx="9" cy="11" r="2" fill="currentColor"/>
          <path d="M21 17l-5-5-9 9" fill="none" stroke="currentColor" stroke-width="2"/>
        </svg>
        <span>Insert</span>
        <kbd>⌘I</kbd>
      </button>
      <button class="tool-btn small" id="h-export" title="Export Spine 4.1 JSON + atlas + PNG bundle for any Spine-capable runtime">
        <svg viewBox="0 0 24 24" width="18" height="18">
          <path d="M5 13v6h14v-6M12 4v9m-3-3l3 3 3-3" fill="none" stroke="currentColor" stroke-width="2"/>
        </svg>
        <span>Export</span>
      </button>
      <button class="tool-btn small" id="h-mp4" title="Export MP4 preview (requires browser WebCodecs H.264 support)">
        <svg viewBox="0 0 24 24" width="18" height="18">
          <rect x="3" y="6" width="14" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/>
          <path d="M17 10l4-2v8l-4-2z" fill="currentColor"/>
        </svg>
        <span>MP4</span>
      </button>
    </div>
  `;
  for (const btn of parent.querySelectorAll<HTMLButtonElement>(".tool-btn[data-tool]")) {
    btn.addEventListener("click", () => {
      const t = btn.dataset.tool as Tool;
      setTool(state, t);
      bus.emit(EV.TOOL_CHANGED);
    });
  }
  document.getElementById("h-add-child")?.addEventListener("click", () => addChildOfSelection(state));
  document.getElementById("h-make-root")?.addEventListener("click", () => makeSelectionRoot(state));
  // The remaining hierarchy buttons are pure event re-emitters. Each
  // listener body is identical so a small loop would be cleaner, but
  // we keep the literal getElementById() calls per-button so the
  // `npm run check:dom` static scan can detect any of these IDs going
  // missing in index.html (the scanner is regex-based and only sees
  // literal string arguments).
  document.getElementById("h-new")?.addEventListener("click", () => bus.emit("file.new"));
  document.getElementById("h-save")?.addEventListener("click", () => bus.emit("file.save"));
  document.getElementById("h-open")?.addEventListener("click", () => bus.emit("file.open"));
  document.getElementById("h-import-spine")?.addEventListener("click", () => bus.emit("file.importSpine"));
  document.getElementById("h-insert")?.addEventListener("click", () => bus.emit("file.insert"));
  document.getElementById("h-export")?.addEventListener("click", () => bus.emit("export.spine"));
  document.getElementById("h-mp4")?.addEventListener("click", () => bus.emit("export.mp4"));
  bus.on<undefined>("hierarchy.addChild", () => addChildOfSelection(state));
  syncToolPalette(parent, state);
  bus.on(EV.TOOL_CHANGED, () => syncToolPalette(parent, state));
}

function syncToolPalette(parent: HTMLElement, state: EditorState): void {
  for (const btn of parent.querySelectorAll<HTMLButtonElement>(".tool-btn[data-tool]")) {
    btn.classList.toggle("active", btn.dataset.tool === state.tool);
  }
}

function addChildOfSelection(state: EditorState): void {
  const ids = Array.from(state.selection.boneIds);
  const candidate = ids.length === 1 ? ids[0] : null;
  let id: Id;
  if (candidate !== null && state.project.bones[candidate]) {
    // Place child 80px below the parent's head in WORLD space. We use the
    // parent's world transform (via evalBoneWorld) so grandchild bones end
    // up at the right world position — parent.x/y/rotation alone is the
    // parent's LOCAL frame and is wrong for non-root parents.
    const world = evalBoneWorld(state.project, candidate);
    if (world) {
      const r = Math.atan2(world.m[1], world.m[0]);
      const wx = world.m[4] + Math.cos(r) * 80;
      const wy = world.m[5] + Math.sin(r) * 80;
      id = addBonePublic(state, candidate, wx, wy);
    } else {
      id = addBonePublic(state, candidate, 0, 0);
    }
  } else {
    id = addBonePublic(state, null, 256, 200);
  }
  selectBones(state, [id]);
  bus.emit(EV.PROJECT_CHANGED);
  bus.emit(EV.SELECTION_CHANGED);
}

function makeSelectionRoot(state: EditorState): void {
  let changed = false;
  for (const id of state.selection.boneIds) {
    if (reparentBone(state, id, null)) changed = true;
  }
  if (changed) {
    bus.emit(EV.PROJECT_CHANGED);
    bus.emit(EV.SELECTION_CHANGED);
  }
}

/* ---------- hierarchy panel (tree with drag-drop reparent) ---------- */

export function buildHierarchy(parent: HTMLElement, state: EditorState): void {
  parent.innerHTML = `
    <div class="panel-header">Hierarchy</div>
    <ul class="sf-hierarchy-list" id="h-list"></ul>
  `;
  const list = parent.querySelector<HTMLUListElement>("#h-list")!;

  const render = () => {
    const items: string[] = [];
    for (const { bone, depth } of walkTree(state.project)) {
      const sel = state.selection.boneIds.has(bone.id);
      const kids = descendantCount(state.project, bone.id);
      const indent = 8 + depth * 14;
      // FR-RB-6 — eye icon toggles visibility on this bone (and any
      // attachment whose bind-bone is this one). Hidden bones still
      // appear in the tree (otherwise users couldn't un-hide them).
      const hidden = bone.visible === false;
      items.push(
        `<li class="h-item ${sel ? "sel" : ""} ${hidden ? "hidden" : ""}" data-id="${bone.id}" draggable="true" style="padding-left:${indent}px">` +
          `<span class="eye" data-vis="${bone.id}" title="${hidden ? "Show" : "Hide"} bone">${hidden ? "◌" : "●"}</span>` +
          `<span class="dot" style="background:${bone.color}"></span>` +
          `<span class="name">${escapeHtml(bone.name)}</span>` +
          (kids > 0 ? `<span class="count">${kids}</span>` : "") +
        `</li>`
      );
    }
    list.innerHTML = items.join("") || `<li class="h-empty">No bones yet. Press <kbd>B</kbd> then click the stage.</li>`;
  };

  // Click — shift adds, plain replaces. Drop-target is the list itself.
  list.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    // Visibility toggle takes priority over selection so a click on the
    // eye doesn't also reselect / pull focus.
    const eye = target.closest<HTMLElement>(".eye");
    if (eye && eye.dataset.vis) {
      const id = eye.dataset.vis as Id;
      const b = state.project.bones[id];
      if (b) {
        b.visible = b.visible === false ? true : false;
        bus.emit(EV.PROJECT_CHANGED);
      }
      e.stopPropagation();
      return;
    }
    const li = target.closest<HTMLElement>(".h-item");
    if (!li) return;
    const id = li.dataset.id as Id;
    if (e.shiftKey) selectBone(state, id, true);
    else selectBone(state, id, false);
    bus.emit(EV.SELECTION_CHANGED);
  });

  // Drag-drop reparent.
  let dragId: Id | null = null;
  list.addEventListener("dragstart", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>(".h-item");
    if (!li) return;
    dragId = li.dataset.id as Id;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/sf-bone", dragId);
    }
  });
  list.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const li = (e.target as HTMLElement).closest<HTMLElement>(".h-item");
    if (!li) {
      // Drop on the empty area of the list → make it a root.
      list.classList.add("drop-root");
      return;
    }
    list.classList.remove("drop-root");
    li.classList.add("drop-target");
  });
  list.addEventListener("dragleave", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>(".h-item");
    if (li) li.classList.remove("drop-target");
    list.classList.remove("drop-root");
  });
  list.addEventListener("drop", (e) => {
    e.preventDefault();
    list.classList.remove("drop-root");
    for (const el of list.querySelectorAll(".drop-target")) el.classList.remove("drop-target");
    if (!dragId) return;
    const li = (e.target as HTMLElement).closest<HTMLElement>(".h-item");
    const newParent: Id | null = li ? (li.dataset.id as Id) : null;
    if (reparentBone(state, dragId, newParent)) {
      bus.emit(EV.PROJECT_CHANGED);
    }
    dragId = null;
  });

  render();
  bus.on(EV.PROJECT_CHANGED, render);
  bus.on(EV.SELECTION_CHANGED, render);

  // Double-click a bone name → inline edit. We swap the <span.name>
  // for an <input>, select all text, and commit on Enter / blur.
  // Escape cancels. Re-render via PROJECT_CHANGED after the input
  // loses focus so the new name shows up.
  list.addEventListener("dblclick", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>(".h-item");
    if (!li) return;
    const id = li.dataset.id as Id;
    const b = state.project.bones[id];
    if (!b) return;
    const nameSpan = li.querySelector<HTMLElement>(".name");
    if (!nameSpan) return;
    e.preventDefault();
    e.stopPropagation();
    startInlineRename(li, nameSpan, b, state);
  });

  // Right-click on a bone → small context menu with Rename + the
  // usual add-child / make-root / visibility / delete actions.
  list.addEventListener("contextmenu", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>(".h-item");
    if (!li) return;
    e.preventDefault();
    e.stopPropagation();
    const id = li.dataset.id as Id;
    const b = state.project.bones[id];
    if (!b) return;
    // Select the bone under the cursor. We only emit SELECTION_CHANGED
    // when the selection actually changed — otherwise the render() call
    // would rebuild the <li>s and the `li` we'd capture for the menu
    // becomes stale, so the menu's Rename action would target a
    // detached element and silently no-op.
    const wasSelected = state.selection.boneIds.has(id);
    if (!wasSelected) {
      selectBone(state, id, false);
      bus.emit(EV.SELECTION_CHANGED);
    }
    openBoneContextMenu(e.clientX, e.clientY, state, id);
  });

  // F2 on a selected bone → inline rename. This is the standard
  // shortcut shown in the right-click menu's hint column.
  list.addEventListener("keydown", (e) => {
    if (e.key !== "F2") return;
    if (state.selection.boneIds.size !== 1) return;
    const id = state.selection.boneIds.values().next().value as Id | undefined;
    if (!id) return;
    const b = state.project.bones[id];
    const li = list.querySelector<HTMLElement>(`.h-item[data-id="${id}"]`);
    const nameSpan = li?.querySelector<HTMLElement>(".name");
    if (!b || !li || !nameSpan) return;
    e.preventDefault();
    startInlineRename(li, nameSpan, b, state);
  });
}

/** State for the open hierarchy context menu. Module-level so the
 *  helpers can read/write it. */
let _boneCtxMenu: HTMLDivElement | null = null;
let _boneCtxCleanup: (() => void) | null = null;

/** Inline-rename helper. Swaps the <span.name> for an <input>, commits
 *  on Enter / blur, cancels on Escape. Only one rename is allowed at a
 *  time — a second dblclick while editing is ignored. */
let _renameInProgress = false;
function startInlineRename(
  _li: HTMLElement,
  nameSpan: HTMLElement,
  b: { id: Id; name: string },
  state: EditorState,
): void {
  if (_renameInProgress) return;
  _renameInProgress = true;
  const original = b.name;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "h-rename-input";
  input.value = original;
  input.maxLength = 64;
  nameSpan.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    if (commit) {
      const trimmed = input.value.trim();
      if (trimmed.length > 0 && trimmed !== b.name) {
        // uniqueName appends "-2", "-3" … if the chosen name is taken
        // by another bone. The user gets a unique name rather than a
        // hard error — matches the inspector's autoKey behaviour.
        b.name = uniqueName(state.project, trimmed, b.id);
      }
    }
    _renameInProgress = false;
    bus.emit(EV.PROJECT_CHANGED);
  };
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter")  { ev.preventDefault(); finish(true); }
    else if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
}

/** Right-click context menu for a bone row. Re-uses .tl-ctxmenu so
 *  the look is consistent with the keyframe menu. The list <li> is
 *  looked up fresh by id whenever a menu item is clicked, because a
 *  render() in between (caused by the right-click selecting the bone)
 *  would have detached the original <li>. */
function openBoneContextMenu(x: number, y: number, state: EditorState, boneId: Id): void {
  closeBoneContextMenu();
  const menu = document.createElement("div");
  menu.className = "tl-ctxmenu h-ctxmenu";
  menu.innerHTML = `
    <div class="tl-ctxmenu-row" data-act="rename"><span class="tl-ctxmenu-label">Rename…</span><span class="tl-ctxmenu-sc">F2</span></div>
    <div class="tl-ctxmenu-sep"></div>
    <div class="tl-ctxmenu-row" data-act="addChild"><span class="tl-ctxmenu-label">Add child bone</span><span class="tl-ctxmenu-sc">N</span></div>
    <div class="tl-ctxmenu-row" data-act="makeRoot"><span class="tl-ctxmenu-label">Make root</span></div>
    <div class="tl-ctxmenu-row" data-act="toggleVis"><span class="tl-ctxmenu-label">Toggle visibility</span><span class="tl-ctxmenu-sc">H</span></div>
    <div class="tl-ctxmenu-sep"></div>
    <div class="tl-ctxmenu-row" data-act="delete"><span class="tl-ctxmenu-label">Delete</span><span class="tl-ctxmenu-sc">⌫</span></div>
  `;
  document.body.appendChild(menu);
  // Clamp to viewport so the menu doesn't open off-screen.
  const vw = window.innerWidth, vh = window.innerHeight;
  const r = menu.getBoundingClientRect();
  if (x + r.width > vw) x = vw - r.width - 4;
  if (y + r.height > vh) y = vh - r.height - 4;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  _boneCtxMenu = menu;

  const onDocClick = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) closeBoneContextMenu();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeBoneContextMenu();
  };
  document.addEventListener("mousedown", onDocClick, true);
  window.addEventListener("keydown", onKey, true);
  _boneCtxCleanup = () => {
    document.removeEventListener("mousedown", onDocClick, true);
    window.removeEventListener("keydown", onKey, true);
  };

  menu.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".tl-ctxmenu-row");
    if (!row) return;
    const act = row.dataset.act;
    if (act === "rename") {
      // Look up the <li> by id each time. A previous menu action (or
      // even just opening the menu) can trigger a re-render that
      // detaches the original <li>.
      const li = document.querySelector<HTMLElement>(`.h-item[data-id="${boneId}"]`);
      const nameSpan = li?.querySelector<HTMLElement>(".name");
      const b = state.project.bones[boneId];
      if (nameSpan && b) startInlineRename(li!, nameSpan, b, state);
    } else if (act === "addChild") {
      const b = state.project.bones[boneId];
      if (b) {
        clearSelection(state);
        const id = addBone(state, b.id, 0, 0);
        selectBone(state, id);
        bus.emit(EV.PROJECT_CHANGED);
        bus.emit(EV.SELECTION_CHANGED);
      }
    } else if (act === "makeRoot") {
      if (reparentBone(state, boneId, null)) bus.emit(EV.PROJECT_CHANGED);
    } else if (act === "toggleVis") {
      const b = state.project.bones[boneId];
      if (b) {
        b.visible = b.visible === false ? true : false;
        bus.emit(EV.PROJECT_CHANGED);
      }
    } else if (act === "delete") {
      void confirmDialog({
        title: "Delete bone",
        message: "Delete this bone and its children?",
        okLabel: "Delete",
        destructive: true,
      }).then((ok) => {
        if (!ok) return;
        removeBone(state, boneId);
        bus.emit(EV.PROJECT_CHANGED);
      });
    }
    closeBoneContextMenu();
  });
}

/** Dismiss any open hierarchy context menu. */
function closeBoneContextMenu(): void {
  if (_boneCtxMenu) { _boneCtxMenu.remove(); _boneCtxMenu = null; }
  if (_boneCtxCleanup) { _boneCtxCleanup(); _boneCtxCleanup = null; }
}

/* ---------- inspector ---------- */

export function buildInspector(parent: HTMLElement, state: EditorState): void {
  parent.innerHTML = `
    <div class="panel-header">Inspector</div>
    <div class="inspector-body"></div>
  `;
  const body = parent.querySelector<HTMLDivElement>(".inspector-body")!;
  // When the user is typing in an inspector field, suppress the
  // PROJECT_CHANGED / playback re-render that would otherwise destroy
  // the input and defocus it. Set by the input's focus handler below.
  let inspectorInputFocused = false;
  const render = () => {
    if (inspectorInputFocused) return;
    // If a keyframe is selected, show its details at the top of the
    // inspector. This lets the user see exactly which (bone, property,
    // time) they've picked, and edit the keyframe value directly. The
    // bone section still renders below so they can also see the bone's
    // resting state.
    const kfSel = state.keyframeSelection;
    const keyframeHtml = kfSel.length === 1 ? renderKeyframeSection(kfSel[0]!, state) : "";
    const ids = Array.from(state.selection.boneIds);
    if (ids.length === 0 && kfSel.length === 0) {
      body.innerHTML = `<p class="hint">No selection. Click a bone in the stage or the hierarchy, or click a keyframe diamond in the timeline.</p>`;
      return;
    }
    if (ids.length > 1) {
      body.innerHTML = keyframeHtml + `<p class="hint">${ids.length} bones selected. Multi-edit comes in P2.</p>`;
      return;
    }
    const b = state.project.bones[ids[0]];
    if (!b) return;
    // Use the sampled world transform so the inspector reflects the
    // current playhead pose (not the static bone positions). If the
    // project has no active animation, fall back to the raw evalPose.
    const anim = getActiveAnimation(state);
    // When a single keyframe on this bone is selected, the X / Y /
    // Rotation / Scale X / Scale Y fields should reflect the *sampled*
    // pose at that keyframe's time — not the playhead's current time.
    // For the keyframe's own property the sampled value equals the
    // keyframe's value exactly; for the other properties it shows
    // what the rest of the bone is doing at that same instant.
    const kfOnThisBone = kfSel.length === 1 && kfSel[0]!.boneId === b.id
      ? kfSel[0]!
      : null;
    const sampledAt = kfOnThisBone ? kfOnThisBone.time : state.playback.currentTime;
    const samples = anim ? sampleAnimation(anim, sampledAt) : null;
    const sample = samples?.get(b.id) ?? null;
    // Display values: prefer the sample (selected keyframe, or current
    // playhead), fall back to the bone's resting value.
    const dispX = sample?.x ?? b.x;
    const dispY = sample?.y ?? b.y;
    const dispRot = sample?.rotation ?? b.rotation;
    const dispScaleX = sample?.scaleX ?? b.scaleX ?? 1;
    const dispScaleY = sample?.scaleY ?? b.scaleY ?? 1;
    const pose = samples ? evalPoseWithSamples(state.project, samples) : null;
    const world = pose?.get(b.id) ?? evalBoneWorld(state.project, b.id);
    const wx = world ? (world.m[4] ?? 0).toFixed(1) : "—";
    const wy = world ? (world.m[5] ?? 0).toFixed(1) : "—";
    const parentName = b.parent ? (state.project.bones[b.parent]?.name ?? "?") : null;
    const kids = descendantCount(state.project, b.id);
    // P2 usability fix #4 — list any attachments bound to this bone so
    // the user has a way to see / delete them from the same panel.
    // Without this, attachments are reachable only through the
    // hierarchy panel's separate Attachments section, which is easy to
    // miss when the focus is on the inspector.
    const boundAttachments = state.project.attachmentOrder
      .map((id) => state.project.attachments[id])
      .filter((a): a is NonNullable<typeof a> => !!a && a.bindBone === b.id);
    const attachmentsHtml = boundAttachments.length === 0
      ? `<p class="hint" style="text-align:left;padding:6px 0">No attachments bound to this bone. Drop a PNG on the stage or press <kbd>⌘I</kbd>.</p>`
      : boundAttachments.map((a) => `
          <div class="att-row" data-att="${a.id}" title="Click ✕ to delete this attachment. Drag the bone to move it.">
            <span class="att-thumb" style="background-image:url('${a.imageDataUrl}')"></span>
            <span class="att-meta">
              <b>${escapeHtml(a.name)}</b>
              <span class="att-dim">${a.imageWidth}×${a.imageHeight}</span>
            </span>
            <button class="att-del" data-att-del="${a.id}" title="Delete attachment">✕</button>
          </div>`).join("");
    body.innerHTML = keyframeHtml + `
      <div class="field"><label>Name</label><input data-f="name" type="text" value="${escapeHtml(b.name)}"></div>
      <div class="grid-2">
        <div class="field"><label>X (local)</label><input data-f="x" type="number" step="0.1" value="${dispX.toFixed(1)}"></div>
        <div class="field"><label>Y (local)</label><input data-f="y" type="number" step="0.1" value="${dispY.toFixed(1)}"></div>
      </div>
      <div class="field"><label>Rotation (°)</label><input data-f="rotation" type="number" step="0.1" value="${dispRot.toFixed(1)}"></div>
      <div class="grid-2">
        <div class="field"><label>Scale X</label><input data-f="scaleX" type="number" step="0.05" value="${dispScaleX.toFixed(2)}"></div>
        <div class="field"><label>Scale Y</label><input data-f="scaleY" type="number" step="0.05" value="${dispScaleY.toFixed(2)}"></div>
      </div>
      <div class="field"><label>Length</label><input data-f="length" type="number" step="0.1" value="${b.length.toFixed(1)}"></div>
      <div class="readout">
        <div><span>World</span><b>(${wx}, ${wy})</b></div>
        <div><span>Parent</span><b>${parentName ? escapeHtml(parentName) : "<i>root</i>"}</b></div>
        <div><span>Children</span><b>${kids}</b></div>
      </div>
      <div class="att-section">
        <div class="att-section-hdr">Attachments (${boundAttachments.length})</div>
        ${attachmentsHtml}
      </div>
    `;
    body.querySelectorAll<HTMLInputElement>("input").forEach((inp) => {
      inp.addEventListener("input", () => {
        const f = inp.dataset.f;
        if (!f) return;
        const v = inp.type === "number" ? parseFloat(inp.value) : inp.value;
        // Name is always bone-level — the name doesn't live on a keyframe.
        if (f === "name") {
          b.name = String(v);
          bus.emit(EV.PROJECT_CHANGED);
          return;
        }
        // Map the inspector field to its track property.
        const prop = fieldToProperty(f);
        if (prop === null) {
          // length / other bone-only fields — write to the bone, no
          // keyframe, no autoKey.
          if (Number.isFinite(v as number)) {
            (b as unknown as Record<string, number>)[f] = v as number;
          }
          bus.emit(EV.PROJECT_CHANGED);
          return;
        }
        // If a keyframe for this (bone, property) exists at the selected
        // keyframe's time, write to that keyframe's value — that's what
        // the user sees in the field. Otherwise (no keyframe selected,
        // or the selected keyframe is for a different property) write
        // to the bone and autoKey-record at the playhead, matching the
        // pre-existing behaviour.
        const targetKf = keyframeValueTarget(state, b.id, prop);
        if (targetKf) {
          applyKeyframeValueEdit(targetKf.track, targetKf.kf, f, v as number);
        } else {
          if (Number.isFinite(v as number)) {
            (b as unknown as Record<string, number>)[f] = v as number;
          }
          autoKeyRecord(state, b.id, prop);
        }
        bus.emit(EV.PROJECT_CHANGED);
      });
      // The inspector subscribes to PROJECT_CHANGED / playback ticks and
      // re-renders itself — which would destroy the input mid-keystroke
      // (typing "45" loses focus after "4"). Skip the re-render while an
      // input is focused, and do a single sync on blur.
      inp.addEventListener("focus", () => { inspectorInputFocused = true; });
      inp.addEventListener("blur",  () => {
        inspectorInputFocused = false;
        render();
      });
    });
    // Keyframe delete button.
    body.querySelector<HTMLButtonElement>("[data-kf-del]")?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (state.keyframeSelection.length === 0) return;
      const ref = state.keyframeSelection[0]!;
      deleteKeyframeAt(state, ref.boneId, ref.property, ref.time);
      state.keyframeSelection = [];
      bus.emit(EV.PROJECT_CHANGED);
    });
    // Wire the per-attachment delete buttons in the inspector. We
    // confirm because the action is destructive and the row is a
    // small target — easy to mis-click.
    body.querySelectorAll<HTMLButtonElement>("[data-att-del]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.dataset.attDel;
        if (!id) return;
        const att = state.project.attachments[id];
        if (!att) return;
        void confirmDialog({
          title: "Delete attachment",
          message: `Delete attachment "${att.name}"?`,
          okLabel: "Delete",
          destructive: true,
        }).then((ok) => {
          if (!ok) return;
          removeAttachment(state.project, id);
          bus.emit(EV.PROJECT_CHANGED);
        });
      });
    });
  };
  render();
  bus.on(EV.SELECTION_CHANGED, render);
  bus.on(EV.PROJECT_CHANGED, render);
  // During playback, the playhead advances via project:changed events
  // (see playback.ts). Re-render the inspector so the World readout
  // tracks the moving bone.
  bus.on(PLAYBACK_EV.TICK, render);
}

/* ---------- shared helpers ---------- */

import { addBone as addBonePublic } from "./store";

/** Render the keyframe-detail section that appears at the top of the
 *  inspector when a single keyframe is selected. Shows the bone, the
 *  property, the time, and the current value (editable for translate/
 *  scale; read-only for rotation in this iteration). */
/** Map an inspector field name to the corresponding track property.
 *  Returns `null` for bone-only fields (name, length) that don't
 *  have an associated animation track. */
function fieldToProperty(f: keyof Bone | string): "translate" | "rotation" | "scale" | null {
  if (f === "x" || f === "y") return "translate";
  if (f === "rotation") return "rotation";
  if (f === "scaleX" || f === "scaleY") return "scale";
  return null;
}

/** Find the keyframe whose value an inspector field should write to,
 *  or `null` if the edit should go to the bone (with autoKey).
 *  Precedence:
 *    1. A keyframe is selected on this bone for this property, at
 *       the selected time. → write to that keyframe.
 *    2. The selected keyframe (if any) is for a *different* property
 *       on this bone (e.g. a rotate keyframe is selected, the user
 *       edits X) — fall through; the user is editing the bone's
 *       resting value at the playhead (autoKey creates a new keyframe
 *       on the matching property if one doesn't exist).
 */
function keyframeValueTarget(
  state: EditorState,
  boneId: Id,
  prop: "translate" | "rotation" | "scale",
): { track: NonNullable<ReturnType<typeof getActiveAnimation>>["tracks"][number]; kf: { time: number; value: number | { x: number; y: number } } } | null {
  const sel = state.keyframeSelection;
  if (sel.length !== 1) return null;
  const ref = sel[0]!;
  if (ref.boneId !== boneId) return null;
  if (ref.property !== prop) return null;
  const anim = getActiveAnimation(state);
  if (!anim) return null;
  const track = anim.tracks.find((t) => t.boneId === boneId && t.property === prop);
  if (!track) return null;
  const kf = track.keyframes.find((k) => Math.abs(k.time - ref.time) < 0.005);
  if (!kf) return null;
  return { track, kf: kf as { time: number; value: number | { x: number; y: number } } };
}

/** Apply a numeric edit from an inspector field to a specific
 *  keyframe's value, matching the existing data-kf-v semantics. */
function applyKeyframeValueEdit(
  _track: unknown,
  kf: { time: number; value: number | { x: number; y: number } },
  f: string,
  v: number,
): void {
  if (f === "rotation") {
    if (Number.isFinite(v)) kf.value = v;
    return;
  }
  if (f === "x" && typeof kf.value === "object" && kf.value) {
    if (Number.isFinite(v)) kf.value = { x: v, y: kf.value.y };
    return;
  }
  if (f === "y" && typeof kf.value === "object" && kf.value) {
    if (Number.isFinite(v)) kf.value = { x: kf.value.x, y: v };
  }
}

/** Render the keyframe-detail banner. The banner itself just
 *  identifies the picked keyframe (bone, property, time) and provides
 *  a delete button. The numeric value is shown in the bone section's
 *  regular X / Y / Rotation / Scale fields so the user has a single
 *  consistent set of inputs. */
function renderKeyframeSection(ref: KeyframeRef, state: EditorState): string {
  const bone = state.project.bones[ref.boneId];
  const boneName = bone ? escapeHtml(bone.name) : "<i>missing bone</i>";
  const propName = ref.property;
  return `
    <div class="inspector-kf">
      <div class="inspector-kf-hdr">
        <span class="inspector-kf-tag">Keyframe</span>
        <span class="inspector-kf-prop">${propName}</span>
        <span class="inspector-kf-bone">${boneName}</span>
        <span class="inspector-kf-time">@ ${ref.time.toFixed(2)}s</span>
        <button class="inspector-kf-del" data-kf-del title="Delete this keyframe">✕</button>
      </div>
    </div>
  `;
}


/* ---------- attachment list (shown in the hierarchy panel as a section) ---------- */

export function buildAttachmentList(parent: HTMLElement, state: EditorState): void {
  // Find the existing list element and add a section below.
  const container = parent.querySelector(".sf-panel-body") || parent;
  let section = container.querySelector<HTMLElement>(".sf-attachments");
  if (!section) {
    const splitter = document.createElement("div");
    splitter.id = "attachment-splitter";
    splitter.className = "sidebar-splitter attachment-splitter";
    section = document.createElement("div");
    section.className = "sf-attachments";
    section.innerHTML = `<div class="sf-panel-header">Attachments</div><ul class="sf-attachment-list"></ul>`;
    container.appendChild(splitter);
    container.appendChild(section);
  }
  const list = section.querySelector<HTMLUListElement>(".sf-attachment-list")!;

  function render(): void {
    const items = state.project.attachmentOrder.map((id) => {
      const att = state.project.attachments[id];
      if (!att) return "";
      return `<li class="att-item" data-id="${att.id}">
        <span class="thumb" style="background-image:url('${att.imageDataUrl}')"></span>
        <span class="att-info">
          <span class="name">${escapeHtml(att.name)}</span>
          <span class="dim">${att.imageWidth}×${att.imageHeight}</span>
        </span>
        <button class="att-remove" data-att-remove="${att.id}" title="Remove attachment" aria-label="Remove attachment">×</button>
      </li>`;
    }).join("");
    const empty = `<li class="h-empty">No attachments. Drag a PNG onto the stage, or press <kbd>I</kbd> for a sample.</li>`;
    list.innerHTML = state.project.attachmentOrder.length === 0 ? empty : items;

    for (const li of list.querySelectorAll<HTMLElement>(".att-item")) {
      li.addEventListener("mouseenter", () => {
        const id = li.dataset.id;
        if (!id) return;
        const att = state.project.attachments[id];
        if (att) showAttachmentHoverPreview(li, att, state);
      });
      li.addEventListener("mouseleave", hideAttachmentHoverPreview);
    }
    for (const btn of list.querySelectorAll<HTMLButtonElement>(".att-remove")) {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.dataset.attRemove;
        if (!id) return;
        const name = state.project.attachments[id]?.name ?? "(unknown)";
        void confirmDialog({
          title: "Remove attachment",
          message: `Remove attachment "${name}"?`,
          okLabel: "Remove",
          destructive: true,
        }).then((ok) => {
          if (!ok) return;
          removeAttachment(state.project, id);
          bus.emit(EV.PROJECT_CHANGED);
        });
      });
    }
  }
  render();
  bus.on(EV.PROJECT_CHANGED, render);
}

function showAttachmentHoverPreview(anchor: HTMLElement, att: MeshAttachment, state: EditorState): void {
  hideAttachmentHoverPreview();
  const bindBone = state.project.bones[att.bindBone]?.name ?? att.bindBone;
  const slots = state.project.slotOrder
    .map((id) => state.project.slots[id])
    .filter((slot): slot is NonNullable<typeof slot> => !!slot && slot.attachment === att.id)
    .map((slot) => slot.name);
  const extras: string[] = [];
  if (att.uvs) extras.push("UVs");
  if (att.nineSlice) extras.push("9-slice");
  if (att.outlinePoints && att.outlinePoints.length > 0) extras.push(`${att.outlinePoints.length / 2} outline pts`);
  const pop = document.createElement("div");
  pop.className = "att-hover-preview";
  pop.innerHTML = `
    <div class="att-hover-image"><img src="${att.imageDataUrl}" alt="${escapeHtml(att.name)}"></div>
    <div class="att-hover-info">
      <div class="att-hover-title">${escapeHtml(att.name)}</div>
      <div class="att-hover-grid">
        <span>Size</span><b>${att.imageWidth}×${att.imageHeight}</b>
        <span>Bind bone</span><b>${escapeHtml(bindBone)}</b>
        <span>Mesh</span><b>${att.vertices.length} verts · ${att.triangles.length} tris</b>
        <span>Influences</span><b>${att.boneRefs.length} bone${att.boneRefs.length === 1 ? "" : "s"}</b>
        <span>Slot</span><b>${slots.length ? escapeHtml(slots.join(", ")) : "—"}</b>
        <span>Data</span><b>${extras.length ? escapeHtml(extras.join(" · ")) : "—"}</b>
      </div>
    </div>
  `;
  document.body.appendChild(pop);
  const rect = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  const gap = 10;
  const left = Math.max(8, rect.left - pr.width - gap);
  const top = Math.max(8, Math.min(window.innerHeight - pr.height - 8, rect.top + rect.height / 2 - pr.height / 2));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function hideAttachmentHoverPreview(): void {
  document.querySelector<HTMLElement>(".att-hover-preview")?.remove();
}
