// src/editor/main.ts
// Editor entry point. Wires the panel layout, instantiates the viewport,
// installs keyboard shortcuts, and starts the render loop.

import { createInitialState, addBone, selectBone, cutKeyframes, copyKeyframes, pasteKeyframes, duplicateKeyframes, setMode, removeBone } from "./store";
import { createDefaultProject } from "../core/model";
import { Viewport } from "./viewport";
import { attachToolHandlers, installToolShortcuts } from "./tools";
import { buildToolPalette, buildHierarchy, buildInspector, buildAttachmentList } from "./panels";
import { buildMenuBar } from "./menu-bar";
import { bus, EV } from "./bus";
import { alertDialog, confirmDialog } from "./modal";
import { SHORTCUTS, matches } from "../shared/keymap";
import { VERSION, BUILD_ID } from "../shared/build-info";
import { loadImageFromFile, createQuadAttachment, addAttachment, recomputeAutoWeights, subdivideMeshAttachment, cutMeshByLine } from "./attachments";
import { parseSheetMetadata, importSpriteSheet } from "./sprite-sheet";
import { importSpineProject } from "./spine-import";
import { buildTimeline, autoKeyRecord } from "./timeline";
import { toggle as togglePlayback, stop as stopPlayback, setSpeed, step as stepPlayback, mixToAnimation } from "./playback";
import { packProject, unpackProject, pickFile, saveProject, clearCachedSaveHandle } from "./save-load";
import { downloadBundle } from "./export-helpers";
import { exportMp4Preview } from "./preview-export";
import { History } from "./history";
import { startAutosaveLoop, readAutosave, clearAutosave, pushRecent, readRecent, type RecentFile } from "./persistence";
import { CURRENT_PROJECT_VERSION, newId } from "../core/model";
import { applyIk } from "../core/ik";
import type { Id } from "../core/model";

const log = (msg: string, ...rest: unknown[]) =>
  console.log(`%c[sf-editor]%c ${msg}`, "color:#5b9cff;font-weight:600", "color:inherit", ...rest);

function boot(): void {
  log(`SpriteForge editor v${VERSION} (build ${BUILD_ID})`);
  log("Phase 2.A — Undo/redo (Cmd+Z / Cmd+Shift+Z), all P1 features still active.");

  const state = createInitialState();
  const history = new History();

  // Look up an element by id and assert it exists. Casts to HTMLElement
  // because the editor's DOM IDs are pre-declared in index.html and
  // missing IDs are caught by `npm run check:dom`. The `!` is safe at
  // runtime; it just removes the noisy `as HTMLElement` from each line.
  const byId = (id: string) => document.getElementById(id) as HTMLElement;

  /** Replace `state.project`'s contents in place with `next`. Modules
   *  (panels, viewport, timeline) hold references to `state.project`,
   *  so we delete every own key on the existing object and copy from
   *  the new one — replacing the reference would orphan those views.
   *  This is the same pattern `history.deserialize` uses for undo. */
  const replaceProjectInPlace = (next: typeof state.project): void => {
    for (const k of Object.keys(state.project)) {
      delete (state.project as unknown as Record<string, unknown>)[k];
    }
    Object.assign(state.project, next);
  };

  /** Wrap an export action with a uniform "log on success / show modal
   *  on failure" shell. The exporters in this module all follow the
   *  same pattern; this helper is just the one place that pattern
   *  lives. `formatLog` returns the success message to log. */
  const runExport = async <T>(
    title: string,
    action: () => Promise<T>,
    formatLog: (result: T) => string,
  ): Promise<void> => {
    try {
      const result = await action();
      log(formatLog(result));
    } catch (err) {
      console.error(`[export] ${title} failed:`, err);
      void alertDialog({
        title: `${title} failed`,
        message: (err as Error).message,
        pre: true,
      });
    }
  };

  const toolPalette = byId("tools");
  const hierarchy   = byId("hierarchy");
  const inspector   = byId("inspector");
  const timeline    = byId("timeline");
  const stage       = byId("stage");
  const status      = byId("status");
  const help        = byId("help");
  const helpList    = byId("help-list");
  const stageHint   = byId("stage-hint");
  const sidebarSplitter = byId("sidebar-splitter");
  // The menubar lives in the title bar; it's optional (only present
  // when index.html declares `<nav id="sf-menubar">`), so we look it
  // up via document.getElementById rather than `byId` to avoid the
  // hard-fail cast.
  const menubar = document.getElementById("sf-menubar");

  buildToolPalette(toolPalette, state);
  buildHierarchy(hierarchy, state);
  buildInspector(inspector, state);
  buildAttachmentList(hierarchy, state);
  buildTimeline(timeline, state);
  if (menubar) buildMenuBar(menubar, state);
  const attachmentSplitter = document.getElementById("attachment-splitter");
  const attachmentsPanel = hierarchy.querySelector<HTMLElement>(".sf-attachments");
  const hierarchyList = hierarchy.querySelector<HTMLElement>(".sf-hierarchy-list");

  if (sidebarSplitter) {
    sidebarSplitter.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const startHeight = hierarchy.offsetHeight;
      const startY = e.clientY;
      sidebarSplitter.classList.add("dragging");
      
      const onMove = (moveEv: PointerEvent) => {
        const deltaY = moveEv.clientY - startY;
        const parentHeight = hierarchy.parentElement ? hierarchy.parentElement.offsetHeight : window.innerHeight;
        const minHierarchyHeight = 100;
        const minInspectorHeight = 100;
        const splitterHeight = sidebarSplitter.offsetHeight || 6;
        const maxHierarchyHeight = parentHeight - minInspectorHeight - splitterHeight;
        const targetHeight = Math.max(minHierarchyHeight, Math.min(maxHierarchyHeight, startHeight + deltaY));
        document.documentElement.style.setProperty('--hierarchy-h', `${targetHeight}px`);
      };
      
      const onUp = () => {
        sidebarSplitter.classList.remove("dragging");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  }

  if (attachmentSplitter && attachmentsPanel && hierarchyList) {
    attachmentSplitter.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const startHeight = attachmentsPanel.offsetHeight;
      const startY = e.clientY;
      attachmentSplitter.classList.add("dragging");

      const onMove = (moveEv: PointerEvent) => {
        const deltaY = moveEv.clientY - startY;
        const parentHeight = hierarchy.clientHeight;
        const headerHeight = hierarchy.querySelector<HTMLElement>(".panel-header")?.offsetHeight ?? 0;
        const splitterHeights = (sidebarSplitter.offsetHeight || 6) + (attachmentSplitter.offsetHeight || 6);
        const minTreeHeight = 80;
        const minAttachmentHeight = 70;
        const maxAttachmentHeight = Math.max(minAttachmentHeight, parentHeight - headerHeight - splitterHeights - minTreeHeight);
        const targetHeight = Math.max(minAttachmentHeight, Math.min(maxAttachmentHeight, startHeight - deltaY));
        document.documentElement.style.setProperty("--attachments-h", `${targetHeight}px`);
      };

      const onUp = () => {
        attachmentSplitter.classList.remove("dragging");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  }

  const viewport = new Viewport(stage, state);
  viewport.frameAll();
  attachToolHandlers(viewport, state);

  // Status bar.
  const refreshStatus = () => {
    const tool = state.tool === "select" ? "Select" : state.tool === "bone" ? "Bone" : state.tool === "rotate" ? "Rotate" : "Scale";
    const mode = state.mode === "edit" ? "Edit" : state.mode === "pose" ? "Pose" : "Animate";
    const selCount = state.selection.boneIds.size;
    let sel = "—";
    if (selCount === 1) {
      const id = Array.from(state.selection.boneIds)[0];
      sel = state.project.bones[id]?.name ?? "—";
    } else if (selCount > 1) {
      sel = `${selCount} selected`;
    }
    const attCount = state.project.attachmentOrder.length;
    status.textContent =
      `mode: ${mode}  ·  tool: ${tool}  ·  selection: ${sel}  ·  bones: ${state.project.boneOrder.length}  ·  attachments: ${attCount}  ·  zoom: ${state.viewport.zoom.toFixed(2)}×`;
  };
  bus.on(EV.PROJECT_CHANGED, refreshStatus);
  bus.on(EV.SELECTION_CHANGED, refreshStatus);
  bus.on(EV.TOOL_CHANGED, refreshStatus);
  bus.on(EV.VIEWPORT_CHANGED, refreshStatus);
  refreshStatus();

  // Help panel. Group shortcuts by their `group` field so each section
// (Tools, View, File, Playback, Edit, Mode) is a self-contained block
// that the CSS column layout won't tear across columns. The list is a
// flat <ul> of <li class="sf-help-group"> blocks; each block holds its
// heading and its own flat row list.
  helpList.innerHTML = (() => {
    const groups = new Map<string, typeof SHORTCUTS>();
    for (const s of SHORTCUTS) {
      const arr = groups.get(s.group) ?? [];
      arr.push(s);
      groups.set(s.group, arr);
    }
    const out: string[] = [];
    for (const [group, items] of groups) {
      out.push(`<li class="sf-help-group"><h4>${group}</h4>`);
      for (const s of items) {
        out.push(`<div class="sf-help-row"><span class="hk">${formatKey(s)}</span><span class="hl">${s.label}</span></div>`);
      }
      out.push(`</li>`);
    }
    return out.join("");
  })();
  document.getElementById("help-close")?.addEventListener("click", () => {
    help.classList.remove("open");
  });

  // Keyboard shortcuts. Skip if the user is typing in a text input
  // (e.g. the ease popover's cp1x field, or the inspector's rotation
  // field) so we don't swallow Cmd+C / Cmd+V etc when they should go
  // to the field.
  window.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement | null;
    const inEditableField = !!(t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable));
    // Help / Escape are global — they work even when an input is
    // focused, so the user can always reach the shortcut reference.
    if (e.key === "?") { help.classList.toggle("open"); e.preventDefault(); return; }
    if (e.key === "Escape" && help.classList.contains("open")) {
      help.classList.remove("open"); e.preventDefault(); return;
    }
    if (inEditableField) return;
    for (const sc of SHORTCUTS) {
      if (matches(e, sc)) {
        e.preventDefault();
        bus.emit(sc.id, undefined);
        return;
      }
    }
  });
  bus.on("view:frame-all", () => viewport.frameAll());
  bus.on("view.reset", () => viewport.frameAll());
  bus.on("view.frameSel", () => viewport.frameSelection());
  bus.on("view.grid", () => {
    state.viewport.showGrid = !state.viewport.showGrid;
    bus.emit(EV.VIEWPORT_CHANGED);
  });
  bus.on("view.bones", () => {
    state.viewport.showBones = !state.viewport.showBones;
    bus.emit(EV.VIEWPORT_CHANGED);
  });
  bus.on("view.images", () => {
    state.viewport.showImages = !state.viewport.showImages;
    bus.emit(EV.VIEWPORT_CHANGED);
  });
  bus.on("tool.select", () => { state.tool = "select"; bus.emit(EV.TOOL_CHANGED); });
  bus.on("tool.bone",   () => { state.tool = "bone";   bus.emit(EV.TOOL_CHANGED); });
  bus.on("tool.rotate", () => { state.tool = "rotate"; bus.emit(EV.TOOL_CHANGED); });
  bus.on("tool.scale",  () => { state.tool = "scale";  bus.emit(EV.TOOL_CHANGED); });
  // Mode switching (FR-RB-7 — P2.B). The store's setMode handles the
  // Pose-mode snapshot/restore. Re-emit project + selection so panels
  // re-render the new mode and pick up any restored bone positions.
  bus.on("mode.edit",    () => { setMode(state, "edit");    bus.emit(EV.PROJECT_CHANGED); bus.emit(EV.TOOL_CHANGED); });
  bus.on("mode.pose",    () => { setMode(state, "pose");    bus.emit(EV.PROJECT_CHANGED); bus.emit(EV.TOOL_CHANGED); });
  bus.on("mode.animate", () => { setMode(state, "animate"); bus.emit(EV.PROJECT_CHANGED); bus.emit(EV.TOOL_CHANGED); });
  bus.on<undefined>("play.toggle", () => togglePlayback(state));
  bus.on<undefined>("play.stop",   () => stopPlayback(state));
  // FR-PB-4 / FR-PB-5 / FR-TA-6 — playback polish.
  bus.on<undefined>("play.stepNext", () => stepPlayback(state, +1));
  bus.on<undefined>("play.stepPrev", () => stepPlayback(state, -1));
  bus.on<undefined>("play.speedUp", () => {
    setSpeed(state, Math.min(4, (state.playback.speed || 1) * 1.5));
    log(`Playback speed: ${state.playback.speed.toFixed(2)}×`);
  });
  bus.on<undefined>("play.speedDown", () => {
    setSpeed(state, Math.max(0.1, (state.playback.speed || 1) / 1.5));
    log(`Playback speed: ${state.playback.speed.toFixed(2)}×`);
  });
  bus.on<undefined>("play.onion", () => {
    state.playback.onionSkinAlpha = state.playback.onionSkinAlpha > 0 ? 0 : 0.3;
    log(`Onion skin: ${state.playback.onionSkinAlpha > 0 ? "on" : "off"} (alpha=${state.playback.onionSkinAlpha.toFixed(2)})`);
    bus.emit(EV.PROJECT_CHANGED);
  });
  // FR-TA-7 — animation crossfade preview. The bus payload is the
  // target animation id; the editor switches activeAnimationId after
  // the requested mix interval. The full bone-by-bone mix lives in
  // the runtime's setAnimation API; this is the editor-side preview.
  bus.on<string | undefined>("anim.mixTo", (targetId) => {
    if (typeof targetId === "string") mixToAnimation(state, targetId);
  });
  bus.on<undefined>("play.key", () => {
    // Manual keyframe set: record a translate + rotation keyframe for
    // each selected bone at the current playhead. With auto-key off,
    // the user can still record explicitly via K.
    for (const id of state.selection.boneIds) {
      autoKeyRecord(state, id, "translate");
      autoKeyRecord(state, id, "rotation");
      autoKeyRecord(state, id, "scale");
    }
  });

  // Keyframe clipboard. These fire on the standard edit.cut / edit.copy /
  // edit.paste / edit.duplicate ids. Note: when the focus is in a text
  // input (e.g. the easing popover's cp1x field), the keymap dispatcher
  // should NOT swallow Cmd+C etc — see the keydown handler below.
  bus.on<undefined>("edit.cut", () => {
    if (state.keyframeSelection.length === 0) return;
    cutKeyframes(state, state.keyframeSelection.slice());
    state.keyframeSelection = [];
    bus.emit(EV.PROJECT_CHANGED);
  });
  bus.on<undefined>("edit.copy", () => {
    if (state.keyframeSelection.length === 0) return;
    copyKeyframes(state, state.keyframeSelection.slice());
    bus.emit(EV.PROJECT_CHANGED);
  });
  bus.on<undefined>("edit.paste", () => {
    if (!state.clipboard || state.clipboard.entries.length === 0) return;
    pasteKeyframes(state);
    bus.emit(EV.PROJECT_CHANGED);
  });
  bus.on<undefined>("edit.duplicate", () => {
    if (state.keyframeSelection.length === 0) return;
    duplicateKeyframes(state, state.keyframeSelection.slice());
    bus.emit(EV.PROJECT_CHANGED);
  });

  // Delete key — context-sensitive. Priority order:
  //   1. If keyframes are selected, delete those (matches Spine).
  //   2. If a bone is selected, delete the bone (and any attachments
  //      bound to it — removeBone cascades).
  //   3. Otherwise no-op.
  bus.on<undefined>("edit.delete", () => {
    if (state.keyframeSelection.length > 0) {
      // Reuse cut as a "remove without copying" — simpler than threading
      // a separate delete-only path through the store.
      const refs = state.keyframeSelection.slice();
      for (const r of refs) {
        // Inline delete to avoid touching the clipboard.
        const anim = state.project.animations[state.project.activeAnimationId];
        if (!anim) continue;
        const tr = anim.tracks.find((t) => t.boneId === r.boneId && t.property === r.property);
        if (!tr) continue;
        const ix = tr.keyframes.findIndex((k) => Math.abs(k.time - r.time) < 0.005);
        if (ix >= 0) tr.keyframes.splice(ix, 1);
      }
      state.keyframeSelection = [];
      bus.emit(EV.PROJECT_CHANGED);
      return;
    }
    if (state.selection.boneIds.size > 0) {
      const ids = Array.from(state.selection.boneIds);
      // Build the confirmation message — call out attached images so
      // the user knows the cascade.
      let attCount = 0;
      for (const id of ids) {
        for (const aid of state.project.attachmentOrder) {
          if (state.project.attachments[aid]?.bindBone === id) attCount++;
        }
      }
      const tail = attCount > 0 ? ` and ${attCount} attachment${attCount === 1 ? "" : "s"}` : "";
      void confirmDialog({
        title: "Delete bones",
        message: `Delete ${ids.length} bone${ids.length === 1 ? "" : "s"}${tail}?`,
        okLabel: "Delete",
        destructive: true,
      }).then((ok) => {
        if (!ok) return;
        for (const id of ids) removeBone(state, id);
        bus.emit(EV.PROJECT_CHANGED);
        bus.emit(EV.SELECTION_CHANGED);
      });
    }
  });

  // Insert a sample sprite programmatically. Used by the `I` shortcut and
  // by the "Insert Sample" button. The sample is a procedurally generated
  // 64×64 PNG of a face so the user can see skinning without needing to
  // provide their own art.
  bus.on<undefined>("attachment.insertSample", () => insertSampleSprite());
  bus.on<undefined>("attachment.insertFile", (dataUrl?: unknown) => {
    if (typeof dataUrl === "string") insertFromDataUrl(dataUrl);
  });
  // FR-MS-4 — recompute auto-weights for all attachments against the
  // current rig. Useful after the user adds/removes bones; the original
  // weights are computed at attachment-create time, so they go stale
  // when the rig changes. We run on every attachment instead of forcing
  // the user to select one — the operation is fast and the right answer
  // is usually "all of them."
  bus.on<undefined>("mesh.autoWeights", () => {
    let n = 0;
    for (const id of state.project.attachmentOrder) {
      if (recomputeAutoWeights(state.project, id)) n++;
    }
    log(`Recomputed auto-weights on ${n} attachment(s).`);
    bus.emit(EV.PROJECT_CHANGED);
  });
  // FR-MS-5 — subdivide mesh attachments on the selected bone (or all
  // attachments if no bone is selected). Splits each triangle 1→4 by
  // inserting midpoint vertices, then invalidates the GL cache so the
  // next frame uploads the new buffers. The auto-weights for the new
  // midpoint vertices are interpolated from the endpoint weights at
  // subdivide time, then recomputable later via Shift+W.
  bus.on<undefined>("mesh.subdivide", () => {
    let targetIds = state.selection.boneIds.size > 0
      ? state.project.attachmentOrder.filter((aid) => {
          const a = state.project.attachments[aid];
          return a && state.selection.boneIds.has(a.bindBone);
        })
      : state.project.attachmentOrder.slice();
    // If the selected bone has no attachments, fall back to all meshes.
    // This avoids a silent no-op when the user has a control/child bone
    // selected but expects the visible sprite to be affected.
    if (targetIds.length === 0 && state.selection.boneIds.size > 0) {
      targetIds = state.project.attachmentOrder.slice();
    }
    if (targetIds.length === 0) {
      log("Subdivide: no attachments to subdivide.");
      return;
    }
    let totalAdded = 0;
    for (const aid of targetIds) {
      const added = subdivideMeshAttachment(state.project, aid);
      totalAdded += added;
      // Force the skin renderer to drop its cached VBO/IBO so the next
      // draw uploads the larger buffers.
      viewport.invalidateAttachment(aid);
    }
    const meshCount = targetIds.length;
    log(`Subdivided ${meshCount} mesh${meshCount === 1 ? "" : "es"} (+${totalAdded} vertices).`);
    bus.emit(EV.PROJECT_CHANGED);
  });
  // P3 — two-bone IK creation. Select a CHILD bone (must have a parent),
  // then Shift+K. The target is placed at the selected bone's current
  // tail, so the constraint initially preserves the pose. The user can
  // later edit `project.ik[id].target` via the inspector UI once we add
  // explicit IK handles; for now this is the functional solver core.
  bus.on<undefined>("mesh.cut", () => {
    let targetIds = state.selection.boneIds.size > 0
      ? state.project.attachmentOrder.filter((aid) => {
          const a = state.project.attachments[aid];
          return a && state.selection.boneIds.has(a.bindBone);
        })
      : state.project.attachmentOrder.slice();
    if (targetIds.length === 0 && state.selection.boneIds.size > 0) {
      targetIds = state.project.attachmentOrder.slice();
    }
    let removed = 0;
    for (const aid of targetIds) {
      const a = state.project.attachments[aid];
      if (!a || a.vertices.length < 3) continue;
      // Default line = local diagonal from first to third vertex (quad
      // BL→TR). Future knife-tool drags will pass a user-defined line.
      const A = a.vertices[0]!;
      const B = a.vertices[2] ?? a.vertices[a.vertices.length - 1]!;
      removed += cutMeshByLine(state.project, aid, A.x, A.y, B.x, B.y);
      viewport.invalidateAttachment(aid);
    }
    log(`Mesh cut removed ${removed} triangle${removed === 1 ? "" : "s"}.`);
    bus.emit(EV.PROJECT_CHANGED);
  });

  bus.on<undefined>("ik.create", () => {
    if (state.selection.boneIds.size !== 1) {
      void alertDialog({
        title: "IK needs a child bone",
        message: "Select exactly one child bone to create a two-bone IK constraint.",
      });
      return;
    }
    const boneId = Array.from(state.selection.boneIds)[0]!;
    const b = state.project.bones[boneId];
    if (!b || !b.parent) {
      void alertDialog({
        title: "IK needs a child bone",
        message: "IK needs a selected child bone with a parent.",
      });
      return;
    }
    const world = viewport.computePose().get(boneId);
    if (!world) return;
    const tx = (world.m[4] ?? 0) + (world.m[0] ?? 1) * b.length;
    const ty = (world.m[5] ?? 0) + (world.m[2] ?? 0) * b.length;
    const id = newId();
    state.project.ik[id] = {
      id,
      name: `${b.name}-ik`,
      targetBone: boneId,
      target: { x: tx, y: ty },
      bend: 1,
      mix: 1,
    };
    state.project.ikOrder.push(id);
    const applied = applyIk(state.project);
    log(`Created IK constraint "${state.project.ik[id]!.name}" (${applied} applied).`);
    bus.emit(EV.PROJECT_CHANGED);
  });
  function insertSampleSprite(): void {
    const dataUrl = generateSamplePng(64);
    insertFromDataUrl(dataUrl);
  }

  /** Pick the bone that a newly inserted image/sprite-sheet should bind
   *  to. Important usability rule: if ANY bone is selected, use the
   *  most recently selected valid bone, not only the selection when it
   *  has exactly one item. The previous code required size === 1, so a
   *  multi-selection silently fell back to project.boneOrder[0] (usually
   *  the root/first bone), which made images inserted after creating a
   *  second bone bind to the first bone instead. */
  function pickAttachmentTargetBone(): Id | undefined {
    const selected = Array.from(state.selection.boneIds).filter((id) => !!state.project.bones[id]);
    if (selected.length > 0) return selected[selected.length - 1];
    // No selection: keep the old safe fallback, first bone in project.
    return state.project.boneOrder.find((id) => !!state.project.bones[id]);
  }

  function insertFromDataUrl(dataUrl: string): void {
    const img = new Image();
    img.onload = () => {
      // Pick the bind bone: active/last selected bone if any, otherwise
      // first project bone, otherwise auto-create one. Falls back
      // gracefully when the project has no bones yet.
      let targetBone: Id | undefined = pickAttachmentTargetBone();
      if (!targetBone) {
        // No bones → create a default root at the stage center.
        const id = addBone(state, null, state.project.width / 2, state.project.height / 2);
        state.project.bones[id]!.length = 80;
        targetBone = id;
      }
      const att = createQuadAttachment(state.project, targetBone, {
        dataUrl,
        width: img.naturalWidth,
        height: img.naturalHeight,
      });
      addAttachment(state.project, att);
      if (stageHint) stageHint.style.display = "none";
      bus.emit(EV.PROJECT_CHANGED);
    };
    img.src = dataUrl;
  }

  installToolShortcuts(state);

  // Drag-drop a PNG anywhere on the stage → insert as attachment.
  // Drag-drop a .sfproj → load it.
  stage.addEventListener("dragover", (e) => { e.preventDefault(); });
  stage.addEventListener("drop", async (e) => {
    e.preventDefault();
    if (!e.dataTransfer) return;
    const files = Array.from(e.dataTransfer.files);
    const proj = files.find((f) => f.name.endsWith(".sfproj") || f.type === "application/json");
    // FR-AI-3 — sprite-sheet import. Trigger when the drop contains BOTH
    // a JSON file (with a `frames` field) AND a PNG/JPG. We match the
    // pair by name-stem if there are several of each; otherwise we just
    // use the first of each kind.
    const imgs = files.filter((f) => f.type.startsWith("image/"));
    const jsons = files.filter((f) => f.type === "application/json" || f.name.endsWith(".json"));
    const atlases = files.filter((f) => f.name.endsWith(".atlas") || f.name.endsWith(".atlas.txt"));
    // Spine bundle import (P2.5.c — §14.3). Priority: when the drop
    // contains a JSON, a PNG, AND a .atlas, treat it as a Spine 4.x
    // export and run the partial importer. We sniff the JSON to be
    // sure (presence of `skeleton.spine` or top-level `bones`) so a
    // sprite-sheet JSON dropped alongside an unrelated .atlas doesn't
    // accidentally fire the Spine path.
    if (jsons.length > 0 && imgs.length > 0 && atlases.length > 0) {
      // The drop has a full Spine-shaped triple. Sniff the JSON first
      // so a TexturePacker array that happens to share a folder with a
      // .atlas file doesn't get mis-imported.
      try {
        // Use the basename-matching heuristic to pick the right triple
        // when the drop contains multiple Spine variants. The hero
        // sample in spine-runtimes ships hero-ess.json + hero-pma.atlas
        // + hero-pma.png, none of which share a basename.
        const triple = pickSpineTriple([
          ...jsons, ...atlases, ...imgs,
        ]);
        if (!triple) {
          void alertDialog({
            title: "Spine import needs all three files",
            message: "Drop a .json, .atlas and .png together to import a Spine bundle.",
            pre: true,
          });
          return;
        }
        const jsonText = await triple.json.text();
        const sniff = JSON.parse(jsonText) as Record<string, unknown>;
        const looksSpine = (sniff.skeleton && typeof sniff.skeleton === "object")
          || Array.isArray(sniff.bones);
        if (looksSpine) {
          await doSpineImport(triple.json, triple.atlas, triple.png);
          return;
        }
      } catch (err) {
        // Fall through to other handlers if Spine sniff/parse failed.
        console.error("[spine-import] sniff failed:", err);
      }
    } else if (jsons.length > 0 && (imgs.length === 0 || atlases.length === 0)) {
      // Partial Spine drop — the user dropped a Spine JSON but is
      // missing the .atlas or .png (or both). Show a clear diagnostic
      // so they know what's wrong instead of falling into the
      // sprite-sheet path and failing with a less helpful error.
      try {
        const jsonText = await jsons[0]!.text();
        const sniff = JSON.parse(jsonText) as Record<string, unknown>;
        const looksSpine = (sniff.skeleton && typeof sniff.skeleton === "object")
          || Array.isArray(sniff.bones);
        if (looksSpine) {
          const missing: string[] = [];
          if (!imgs.length)   missing.push(".png");
          if (!atlases.length) missing.push(".atlas");
          void alertDialog({
            title: "Spine bundle needs all three files",
            message: `You dropped a Spine 4.x JSON (${jsons[0]!.name}) but the ${missing.join(" and ")} ${missing.length === 1 ? "file is" : "files are"} missing. Drop the .json + .atlas + .png together, or use the "Spine" button in the hierarchy panel and pick all three.`,
            pre: true,
          });
          return;
        }
      } catch { /* not a JSON we can sniff — fall through */ }
    }
    if (imgs.length > 0 && jsons.length > 0) {
      // Pick the JSON whose stem matches an image's stem, if any; else
      // fall back to the first JSON.
      const stem = (n: string) => n.replace(/\.[^./]+$/, "");
      const imageFile = imgs[0]!;
      const matchedJson = jsons.find((j) => stem(j.name) === stem(imageFile.name)) ?? jsons[0]!;
      try {
        const text = await matchedJson.text();
        const meta = parseSheetMetadata(text);
        const loaded = await loadImageFromFile(imageFile);
        // Decode the data URL into an HTMLImageElement for the slice loop.
        const img = await new Promise<HTMLImageElement>((res, rej) => {
          const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("decode failed"));
          i.src = loaded.dataUrl;
        });
        // Pick a target bone. Same active-selection fallback as single-image insert.
        let targetBone: Id | undefined = pickAttachmentTargetBone();
        if (!targetBone) {
          const id = addBone(state, null, state.project.width / 2, state.project.height / 2);
          state.project.bones[id]!.length = 80;
          targetBone = id;
        }
        const result = await importSpriteSheet(state.project, targetBone, img, meta);
        log(`Sprite sheet: imported ${result.attachmentIds.length} attachment(s) from "${matchedJson.name}".`);
        for (const w of result.warnings) log(`  warn: ${w}`);
        if (stageHint) stageHint.style.display = "none";
        bus.emit(EV.PROJECT_CHANGED);
      } catch (err) {
        console.error("[sheet] import failed:", err);
        void alertDialog({
          title: "Sprite-sheet import failed",
          message: (err as Error).message,
          pre: true,
        });
      }
      return;
    }
    if (proj) {
      await loadSfprojFromFile(proj);
      return;
    }
    const file = files.find((f) => f.type.startsWith("image/")) ?? null;
    if (!file) return;
    try {
      const img = await loadImageFromFile(file);
      // Same active-selection fallback as insertFromDataUrl.
      let targetBone: Id | undefined = pickAttachmentTargetBone();
      if (!targetBone) {
        const id = addBone(state, null, state.project.width / 2, state.project.height / 2);
        state.project.bones[id]!.length = 80;
        targetBone = id;
      }
      const att = createQuadAttachment(state.project, targetBone, img);
      addAttachment(state.project, att);
      if (stageHint) stageHint.style.display = "none";
      bus.emit(EV.PROJECT_CHANGED);
    } catch (err) {
      console.error("[drop] failed to load image:", err);
    }
  });

  // Start with a clean empty project — no seed bones or sprites.
  // The user can add bones with the Bone tool (B), import a Spine
  // bundle, or load a saved project.

  // URL search params for feature flags (nosample, noautosave, etc.)
  const params = new URLSearchParams(location.search);

  // History (P2.A — FR-UR-1, FR-UR-2). Initialise AFTER the seed rig and
  // sample sprite so the baseline undo target is "fresh project as you
  // see it on load" — undoing past that point is a no-op, which is what
  // users expect. We hook scheduleCapture *after* this init so the
  // PROJECT_CHANGED emits above don't pollute the stack.
  history.init(state);
  bus.on(EV.PROJECT_CHANGED, () => history.scheduleCapture(state));
  bus.on<undefined>("edit.undo", () => {
    if (history.undo(state)) {
      log(`Undo (${history.size().undo} undo / ${history.size().redo} redo)`);
      bus.emit(EV.PROJECT_CHANGED);
      bus.emit(EV.SELECTION_CHANGED);
    }
  });
  bus.on<undefined>("edit.redo", () => {
    if (history.redo(state)) {
      log(`Redo (${history.size().undo} undo / ${history.size().redo} redo)`);
      bus.emit(EV.PROJECT_CHANGED);
      bus.emit(EV.SELECTION_CHANGED);
    }
  });

  // Save/Load. Press `S` to save (download .sfproj), `O` to open
  // (file picker). Drag-drop a .sfproj onto the stage to load — the
  // drop handler is a small extension to the PNG drop handler above.
  bus.on<undefined>("file.new", () => {
    // Confirm — this is destructive. Autosave covers the safety net
    // (the user can decline the autosave-restore on the next reload),
    // but we still ask explicitly so the user doesn't lose work to a
    // mis-click on the New button.
    void confirmDialog({
      title: "New project",
      message: "Start a new project? Any unsaved changes will be discarded.",
      okLabel: "Discard & start",
      destructive: true,
    }).then((ok) => {
      if (!ok) return;
      newProjectNow();
    });
  });

  function newProjectNow(): void {
    // Replace the project's *contents* in place so panels, viewport,
    // and timeline (which all hold a reference to state.project) see
    // the new shape on the next emit. Same pattern as save-load's
    // `loadSfprojFromFile`.
    replaceProjectInPlace(createDefaultProject("untitled"));
    state.selection.boneIds.clear();
    state.keyframeSelection = [];
    state.playback.currentTime = 0;
    state.playback.playing = false;
    viewport.frameAll();
    history.init(state);
    clearAutosave();
    clearCachedSaveHandle(); // the cached FSA handle no longer matches
    log("New project.");
    bus.emit(EV.PROJECT_CHANGED);
    bus.emit(EV.SELECTION_CHANGED);
  }
  bus.on<undefined>("file.save", async () => {
    const result = await saveProject(state.project);
    if (!result) return; // user cancelled the picker
    pushRecent({ filename: result.filename, savedAt: new Date().toISOString(), bytes: result.bytes, source: "save" });
    clearAutosave(); // user is in control again — drop the autosave
    log(`Saved ${result.filename} (${(result.bytes / 1024).toFixed(1)} KB)`);
  });
  bus.on<undefined>("file.open", () => {
    bus.emit("file.load");
  });
  bus.on<undefined>("file.load", async () => {
    const file = await pickFile(".sfproj,application/json");
    if (!file) return;
    await loadSfprojFromFile(file);
  });
  // Import a Spine 4.1 bundle via a single multi-file picker. The user
  // can Cmd-click / Shift-click the .json, .atlas and .png in the OS
  // dialog to select all three at once, or use the dialog's file-type
  // filter to pick them one at a time. We then route through the same
  // importSpineProject path the drop handler uses, so behaviour is
  // identical to drag-drop.
  bus.on<undefined>("file.importSpine", async () => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = ".json,.atlas,.png,application/json,text/plain,image/png";
    input.style.display = "none";
    document.body.appendChild(input);
    const files: File[] = await new Promise((resolve) => {
      input.addEventListener("change", () => {
        const arr = Array.from(input.files ?? []);
        input.remove();
        resolve(arr);
      }, { once: true });
      input.click();
    });
    if (files.length === 0) return;
    const triple = pickSpineTriple(files);
    if (!triple) {
      const missing: string[] = [];
      if (!files.some((f) => /\.json$/i.test(f.name)))  missing.push(".json");
      if (!files.some((f) => /\.atlas(\.txt)?$/i.test(f.name))) missing.push(".atlas");
      if (!files.some((f) => /\.png$/i.test(f.name)))   missing.push(".png");
      void alertDialog({
        title: "Spine import needs all three files",
        message: `Missing: ${missing.join(", ")}. Pick the .json, .atlas and .png files from the Spine export.`,
        pre: true,
      });
      return;
    }
    await doSpineImport(triple.json, triple.atlas, triple.png);
  });
  bus.on<undefined>("file.insert", async () => {
    // Cmd+I — pick a PNG/JPG and insert as attachment.
    const file = await pickFile("image/*");
    if (!file) return;
    try {
      const img = await loadImageFromFile(file);
      // Same active-selection fallback as the drop handler.
      let targetBone: Id | undefined = pickAttachmentTargetBone();
      if (!targetBone) {
        const id = addBone(state, null, state.project.width / 2, state.project.height / 2);
        state.project.bones[id]!.length = 80;
        targetBone = id;
      }
      const att = createQuadAttachment(state.project, targetBone, img);
      addAttachment(state.project, att);
      if (stageHint) stageHint.style.display = "none";
      bus.emit(EV.PROJECT_CHANGED);
    } catch (err) {
      console.error("[insert] failed to load image:", err);
    }
  });
  bus.on<undefined>("export.spine", () =>
    runExport(
      "Export",
      () => downloadBundle(state.project),
      (result) =>
        `Exported: ${result.jsonFilename} (${(result.jsonBytes / 1024).toFixed(1)} KB), ` +
        `${result.pngFilename} (${(result.pngBytes / 1024).toFixed(1)} KB), ` +
        `${result.atlasFilename} (${(result.atlasBytes / 1024).toFixed(1)} KB)`,
    ),
  );
  bus.on<undefined>("export.mp4", () => {
    log("Exporting MP4 preview…");
    return runExport(
      "MP4 export",
      () => exportMp4Preview(state, viewport),
      (r) => `MP4 preview: ${r.filename} (${(r.bytes / 1024).toFixed(1)} KB, ${r.frames} frames)`,
    );
  });
  async function prewarmProjectImages(project: typeof state.project): Promise<void> {
    const dataUrls = project.attachmentOrder
      .map((id: string) => project.attachments[id]?.imageDataUrl)
      .filter((u): u is string => !!u);
    await viewport.prewarmTextures(dataUrls);
    await viewport.eagerUploadAll(project);
  }

  async function loadSfprojFromFile(file: File): Promise<void> {
    try {
      const { project, filename, warnings } = await unpackProject(
        file,
        CURRENT_PROJECT_VERSION
      );
      // Swap the in-memory project in. Object.assign overwrites the same
      // record references in place, so anything holding a reference to
      // state.project.bones/etc. (panels, viewport, timeline) sees the
      // new data on the next redraw.
      Object.assign(state.project, project);
      state.selection.boneIds.clear();
      if (state.project.boneOrder.length > 0) {
        selectBone(state, state.project.boneOrder[0]);
      }
      state.keyframeSelection = [];
      await prewarmProjectImages(state.project);
      viewport.frameAll();
      // Reset undo history — the user opening a different project shouldn't
      // be able to "undo" back to the previous one. The newly-loaded
      // project becomes the new baseline.
      history.init(state);
      // Track in the recent-files list so the user can re-open without
      // re-picking. We don't have the bytes here cheaply; use file.size.
      pushRecent({ filename: file.name, savedAt: new Date().toISOString(), bytes: file.size, source: "open" });
      clearAutosave(); // freshly-opened project is the new ground truth
      clearCachedSaveHandle(); // we don't have an FSA handle for this file
      if (warnings.length > 0) {
        log(`Loaded ${filename} with ${warnings.length} warning(s):`);
        for (const w of warnings) log(`  - ${w}`);
      } else {
        log(`Loaded ${filename}`);
      }
      bus.emit(EV.PROJECT_CHANGED);
      bus.emit(EV.SELECTION_CHANGED);
    } catch (err) {
      console.error("[load] failed to open project:", err);
      void alertDialog({
        title: `Could not open ${file.name}`,
        message: (err as Error).message,
        pre: true,
      });
    }
  }

  /** Shared Spine-bundle import path. Used by both the drop handler
   *  and the "Spine" button in the hierarchy panel so the two entry
   *  points behave identically (same confirm, same project replace,
   *  same warning logging, same history reset). */
  async function doSpineImport(jsonFile: File, atlasFile: File, pngFile: File): Promise<void> {
    try {
      const jsonText = await jsonFile.text();
      // Sniff for a Spine skeleton so we can refuse sprite-sheet JSONs
      // that happen to be named .json (e.g. a TexturePacker array).
      const sniff = JSON.parse(jsonText) as Record<string, unknown>;
      const looksSpine = (sniff.skeleton && typeof sniff.skeleton === "object")
        || Array.isArray(sniff.bones);
      if (!looksSpine) {
        void alertDialog({
          title: "Doesn't look like a Spine JSON",
          message: "The dropped .json doesn't have a `skeleton` block or top-level `bones` array. Is it a TexturePacker / sprite-sheet JSON instead?",
          pre: true,
        });
        return;
      }
      const atlasText = await atlasFile.text();
      const loadedImg = await loadImageFromFile(pngFile);
      const img = await new Promise<HTMLImageElement>((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error("decode failed"));
        i.src = loadedImg.dataUrl;
      });
      const ok = await confirmDialog({
        title: "Import Spine bundle",
        message: "Import this Spine 4.x bundle? Any unsaved changes in the current project will be discarded.",
        okLabel: "Import",
      });
      if (!ok) return;
      const result = await importSpineProject(jsonText, atlasText, img);
      // Replace project contents in place so panels keep their refs.
      replaceProjectInPlace(result.project);
      state.selection.boneIds.clear();
      if (state.project.boneOrder.length > 0) {
        selectBone(state, state.project.boneOrder[0]);
      }
      state.keyframeSelection = [];
      state.playback.currentTime = 0;
      state.playback.playing = false;
      history.init(state);
      clearAutosave();
      // Pre-decode + pre-upload all attachment images before first render
      // to avoid async texture decode/upload race causing missing textures.
      await prewarmProjectImages(result.project);
      viewport.frameAll();
      log(`Spine import: ${state.project.boneOrder.length} bones, ${state.project.attachmentOrder.length} attachments, ${state.project.animationOrder.length} animations.`);
      for (const w of result.warnings) log(`  warn: ${w}`);
      if (stageHint) stageHint.style.display = "none";
      bus.emit(EV.PROJECT_CHANGED);
      bus.emit(EV.SELECTION_CHANGED);
    } catch (err) {
      console.error("[spine] import failed:", err);
      void alertDialog({
        title: "Spine import failed",
        message: (err as Error).message,
        pre: true,
      });
    }
  }

  (window as any).__bus = bus;
  (window as any).__state = state;
  (window as any).__viewport = viewport;
  (window as any).__history = history;
  // Expose persistence helpers for tests / debugging. Production code
  // never touches these via the global; the bus is the supported API.
  (window as any).__persistence = { readAutosave, readRecent, pushRecent, clearAutosave };

  // Autosave loop (FR-PM-2 — P2.C). Started AFTER the seed rig + sample
  // sprite are in place so the first heartbeat captures a meaningful
  // baseline. The loop is a no-op if the project hasn't changed since
  // the last tick; the beforeunload listener fires a final write on
  // tab close as best-effort.
  // Offer to restore an autosave if one exists AND the URL didn't ask
  // to suppress (so the verify scripts can avoid the dialog). The
  // user's reply lands here synchronously via window.confirm; if they
  // accept, we replace the in-memory project with the autosave and
  // re-init the viewport / history. Note: we explicitly do NOT
  // auto-restore — overwriting a fresh project's state silently is
  // surprising. The user gets to decide.
  if (params.get("noautosave") === null) {
    const auto = readAutosave();
    if (auto) {
      const ageMs = Date.now() - new Date(auto.savedAt).getTime();
      const ageMin = Math.max(1, Math.round(ageMs / 60000));
      const ageKb = (auto.bytes / 1024).toFixed(1);
      void confirmDialog({
        title: "Restore autosave?",
        message: `Found an autosave from ${ageMin} minute(s) ago (${ageKb} KB). Restore it?`,
        okLabel: "Restore",
      }).then(async (yes) => {
        if (yes) {
          try {
            const wrapper = JSON.parse(auto.payload) as { project: typeof state.project };
            if (wrapper && wrapper.project) {
              Object.assign(state.project, wrapper.project);
              state.selection.boneIds.clear();
              state.keyframeSelection = [];
              await prewarmProjectImages(state.project);
              viewport.frameAll();
              history.init(state);
              log("Autosave restored.");
              bus.emit(EV.PROJECT_CHANGED);
              bus.emit(EV.SELECTION_CHANGED);
            }
          } catch (err) {
            console.error("[autosave] restore failed:", err);
          }
        } else {
          // The user declined — drop the stale autosave so we don't keep
          // asking on every reload.
          clearAutosave();
        }
      });
    }
  }

  // Recent-files menu (FR-PM-3 — P2.C). Triggered by the bus event
  // `file.recent` — the timeline panel adds a small dropdown button
  // that emits this. The menu lists up to 8 entries; selecting one
  // opens a file picker pre-filtered to .sfproj (we can't programmatic-
  // ally re-open a file by name from a privacy-sandboxed browser tab).
  bus.on<undefined>("file.recent", () => {
    const recent = readRecent();
    if (recent.length === 0) {
      void alertDialog({
        title: "No recent projects",
        message: "No recent projects yet. Save (Cmd+S) or Open (Cmd+O) to populate this list.",
      });
      return;
    }
    const lines = recent.map((r, i) =>
      `${i + 1}. ${r.filename}  ·  ${(r.bytes / 1024).toFixed(1)} KB  ·  ${new Date(r.savedAt).toLocaleString()}  (${r.source})`
    ).join("\n");
    // Browsers can't auto-load files by path, so this is informational
    // only. We still offer "open file picker" via the existing flow so
    // the user can reach the file from their OS.
    void confirmDialog({
      title: "Recent projects",
      message: `${lines}\n\nOpen the file picker now?`,
      pre: true,
      okLabel: "Open file picker",
    }).then((ok) => {
      if (ok) bus.emit("file.load");
    });
  });

  log("Ready. Press `?` for keyboard shortcuts.");
}

/** Find a Spine bundle triple (JSON + atlas + PNG) among a list of files.
 *  Spine exports often live in a folder with multiple variants
 *  (e.g. hero-ess.json + hero-pma.atlas + hero-pma.png + hero-pro.json + ...)
 *  where the JSON and atlas have *different* basenames. We try to
 *  pick the triple whose basenames match best, falling back to the
 *  first-match rule when only one of each is present.
 *  Returns `null` if no .json, no .atlas, or no .png is present. */
function pickSpineTriple(files: File[]): { json: File; atlas: File; png: File } | null {
  const jsonFiles  = files.filter((f) => /\.json$/i.test(f.name));
  const atlasFiles = files.filter((f) => /\.atlas(\.txt)?$/i.test(f.name));
  const pngFiles   = files.filter((f) => /\.png$/i.test(f.name));
  if (jsonFiles.length === 0 || atlasFiles.length === 0 || pngFiles.length === 0) return null;

  const stem = (name: string) => name.replace(/\.[^./]+$/, "").replace(/[-_]ess$|[-_]pro$|[-_]pma$|[-_]texture$/i, "");

  // 1. Exact triple match: same stem on all three.
  for (const j of jsonFiles) {
    const js = stem(j.name);
    const a = atlasFiles.find((x) => stem(x.name) === js);
    const p = pngFiles.find((x) => stem(x.name) === js);
    if (a && p) return { json: j, atlas: a, png: p };
  }
  // 2. JSON-atlas match: same stem on JSON and atlas; pick the PNG
  // whose stem best matches one of those (PNG often shares the
  // atlas's stem, e.g. hero-pma.atlas + hero-pma.png).
  for (const j of jsonFiles) {
    const js = stem(j.name);
    const a = atlasFiles.find((x) => stem(x.name) === js);
    if (!a) continue;
    const atlasStem = stem(a.name);
    const p = pngFiles.find((x) => stem(x.name) === atlasStem)
           ?? pngFiles.find((x) => stem(x.name) === js)
           ?? pngFiles[0]!;
    return { json: j, atlas: a, png: p };
  }
  // 3. Atlas-PNG match: same stem on atlas and PNG; pick the JSON
  // whose stem best matches.
  for (const a of atlasFiles) {
    const as = stem(a.name);
    const p = pngFiles.find((x) => stem(x.name) === as);
    if (!p) continue;
    const j = jsonFiles.find((x) => stem(x.name) === as)
           ?? jsonFiles.find((x) => stem(x.name) === stem(p.name))
           ?? jsonFiles[0]!;
    return { json: j, atlas: a, png: p };
  }
  // 4. No match — fall back to first-of-each.
  return { json: jsonFiles[0]!, atlas: atlasFiles[0]!, png: pngFiles[0]! };
}

function formatKey(s: { key: string; mod?: boolean; shift?: boolean }): string {
  const parts: string[] = [];
  if (s.mod) parts.push(navigator.platform.includes("Mac") ? "⌘" : "Ctrl");
  if (s.shift) parts.push("Shift");
  const display = s.key === "space" ? "Space" :
                  s.key === "delete" ? "Del" :
                  s.key.length === 1 ? s.key.toUpperCase() : s.key;
  parts.push(display);
  return parts.join("+");
}

/** Generate a small 64×64 PNG of a friendly face as a data URL. Used as a
 *  stand-in so the user can see skinning immediately, without supplying
 *  art. */
function generateSamplePng(size: number): string {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  // Background circle.
  ctx.fillStyle = "#7be39a";
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.45, 0, Math.PI * 2);
  ctx.fill();
  // Eyes.
  ctx.fillStyle = "#161922";
  ctx.beginPath();
  ctx.arc(size * 0.38, size * 0.42, size * 0.05, 0, Math.PI * 2);
  ctx.arc(size * 0.62, size * 0.42, size * 0.05, 0, Math.PI * 2);
  ctx.fill();
  // Mouth.
  ctx.strokeStyle = "#161922";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(size * 0.5, size * 0.6, size * 0.12, 0, Math.PI);
  ctx.stroke();
  return c.toDataURL("image/png");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
