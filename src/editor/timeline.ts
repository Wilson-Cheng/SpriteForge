// src/editor/timeline.ts
// The timeline panel: time ruler, play controls, and per-(bone,property)
// tracks. P1.D+ adds: per-keyframe easing curves (visual + popover),
// multi-keyframe selection (shift-click, drag-rect), context menu with
// cut/copy/paste/duplicate, and Cmd/Ctrl+C/V/X/D shortcuts.
//
// All keyframe data lives in `state.project.animations[activeId].tracks`.
// The timeline doesn't duplicate the data; it just renders it and emits
// project:changed when the user edits.

import type { EditorState } from "./store";
import {
  getActiveAnimation,
  setKeyframe,
  deleteKeyframeAt,
  setCurrentTime,
  setKeyframeEasing,
  copyKeyframes,
  pasteKeyframes,
  cutKeyframes,
  duplicateKeyframes,
  type KeyframeRef,
} from "./store";
import { toggle, stop, play, pause, seek, PLAYBACK_EV } from "./playback";
import { bus, EV } from "./bus";
import { beginTransaction, endTransaction } from "./history";
import { evalPoseWithSamples } from "../core/eval";
import type { Id, Bone, EasingPreset } from "../core/model";
import { uniqueName, EASING_PRESETS } from "../core/model";
import { walkTree } from "./hierarchy-ops";
import { escapeHtml } from "../shared/dom";

const TRACK_H = 22;          // pixel height of one track row
const TIME_RULER_H = 24;     // pixel height of the time ruler
const LEFT_PAD = 12;         // left padding inside the panel
// Width of the track-label column on the left of the timeline. Mutable
// — the user drags a splitter on the right edge of the spacer to widen
// or shrink it. Persisted across sessions via localStorage.
const RULER_W_KEY = "sf.timeline.labelW.v1";
const RULER_W_DEFAULT = 56;
const RULER_W_MIN = 24;
const RULER_W_MAX = 480;
let rulerW: number = loadRulerW();

// Timeline horizontal zoom (pixels per second of animation time).
// Mutable: Shift+wheel zooms in/out, scoped to the timeline body so it
// doesn't fight the stage viewport's wheel handler. Persisted across
// sessions via localStorage (like the label-column width).
const ZOOM_KEY = "sf.timeline.zoom.v1";
const ZOOM_DEFAULT = 80;
const ZOOM_MIN = 20;
const ZOOM_MAX = 4000;
let timelineZoom: number = loadTimelineZoom();

const GRAPH_H_KEY = "sf.timeline.graphH.v1";
const GRAPH_H_DEFAULT = 84;
const GRAPH_H_MIN = 48;
const GRAPH_H_MAX = 280;
let graphH: number = loadGraphH();

function loadTimelineZoom(): number {
  try {
    const raw = localStorage.getItem(ZOOM_KEY);
    if (raw == null) return ZOOM_DEFAULT;
    const v = parseFloat(raw);
    if (Number.isFinite(v)) return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v));
  } catch { /* corrupted / no storage */ }
  return ZOOM_DEFAULT;
}
function saveTimelineZoom(z: number): void {
  try { localStorage.setItem(ZOOM_KEY, String(z)); } catch { /* non-fatal */ }
}

function loadGraphH(): number {
  try {
    const raw = localStorage.getItem(GRAPH_H_KEY);
    if (raw == null) return GRAPH_H_DEFAULT;
    const v = parseFloat(raw);
    if (Number.isFinite(v)) return Math.max(GRAPH_H_MIN, Math.min(GRAPH_H_MAX, v));
  } catch { /* corrupted / no storage */ }
  return GRAPH_H_DEFAULT;
}
function saveGraphH(h: number): void {
  try { localStorage.setItem(GRAPH_H_KEY, String(Math.round(h))); } catch { /* non-fatal */ }
}

function loadRulerW(): number {
  try {
    const raw = localStorage.getItem(RULER_W_KEY);
    if (raw == null) return RULER_W_DEFAULT;
    const v = parseFloat(raw);
    if (Number.isFinite(v)) return Math.max(RULER_W_MIN, Math.min(RULER_W_MAX, v));
  } catch { /* corrupted / no storage */ }
  return RULER_W_DEFAULT;
}
function saveRulerW(w: number): void {
  try { localStorage.setItem(RULER_W_KEY, String(Math.round(w))); } catch { /* non-fatal */ }
}

let autoKey = true;

function timelineContentWidth(duration: number): number {
  return Math.max(1, Math.ceil(Math.max(0, duration) * timelineZoom));
}

/** Mount the timeline panel into `parent`. The panel is split into a
 *  top row (play controls + animation switcher + auto-key toggle) and
 *  a scrollable body (time ruler + tracks). */
export function buildTimeline(parent: HTMLElement, state: EditorState): void {
  parent.innerHTML = `
    <div class="timeline-resize-handle" id="timeline-resize-handle"></div>
    <div class="tl-toolbar">
      <button class="tl-btn" id="tl-stop" title="Stop and rewind (S)">⏮</button>
      <button class="tl-btn" id="tl-play" title="Play / pause (Space)">▶</button>
      <label class="tl-current-time" title="Current playhead time. Click to edit (jumps precisely).">
        <input type="number" id="tl-time" min="0" max="60" step="0.01" value="0.00">
        <span class="tl-time-unit">s</span>
      </label>
      <span class="tl-time-sep">/</span>
      <label class="tl-duration" title="Animation duration in seconds. Click to edit.">
        <input type="number" id="tl-duration" min="0.1" max="60" step="0.1" value="1.0">
        <span class="tl-time-unit">s</span>
      </label>
      <span class="tl-sep"></span>
      <select class="tl-select" id="tl-anim"></select>
      <button class="tl-btn" id="tl-anim-add" title="New animation">+</button>
      <span class="tl-sep"></span>
      <label class="tl-check" title="Auto-key: changes to the active bone are recorded as keyframes at the playhead">
        <input type="checkbox" id="tl-autokey" ${autoKey ? "checked" : ""}>
        <span>auto-key</span>
      </label>
      <span class="tl-sep"></span>
      <span class="tl-clip" id="tl-clip" title="Keyframe clipboard. Cmd+C / Cmd+V / Cmd+X / Cmd+D"></span>
    </div>
    <div class="tl-graph" id="tl-graph" title="Bezier graph editor: selected keyframe curves across the active animation"></div>
    <div class="tl-graph-resize" id="tl-graph-resize" title="Drag to resize the curve display"></div>
    <div class="tl-body">
      <div class="tl-ruler-wrap">
        <div class="tl-ruler-spacer" id="tl-ruler-spacer">
          <div class="tl-label-splitter" id="tl-label-splitter" title="Drag to resize the track-name column">
            <svg viewBox="0 0 6 18" width="6" height="18" aria-hidden="true">
              <line x1="2" y1="3" x2="2" y2="15" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
              <line x1="4" y1="3" x2="4" y2="15" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
            </svg>
          </div>
        </div>
        <div class="tl-ruler" id="tl-ruler"></div>
      </div>
      <div class="tl-tracks" id="tl-tracks"></div>
    </div>
  `;

  const playBtn = parent.querySelector<HTMLButtonElement>("#tl-play")!;
  const stopBtn = parent.querySelector<HTMLButtonElement>("#tl-stop")!;
  const timeInp = parent.querySelector<HTMLInputElement>("#tl-time")!;
  const durInp = parent.querySelector<HTMLInputElement>("#tl-duration")!;
  const animSel = parent.querySelector<HTMLSelectElement>("#tl-anim")!;
  const animAdd = parent.querySelector<HTMLButtonElement>("#tl-anim-add")!;
  const autoKeyCb = parent.querySelector<HTMLInputElement>("#tl-autokey")!;
  const ruler = parent.querySelector<HTMLDivElement>("#tl-ruler")!;
  const tracks = parent.querySelector<HTMLDivElement>("#tl-tracks")!;
  const graph = parent.querySelector<HTMLDivElement>("#tl-graph")!;
  const graphResize = parent.querySelector<HTMLDivElement>("#tl-graph-resize")!;
  const rulerWrap = parent.querySelector<HTMLDivElement>(".tl-ruler-wrap")!;
  const body = parent.querySelector<HTMLDivElement>(".tl-body")!;
  const resizeHandle = parent.querySelector<HTMLDivElement>("#timeline-resize-handle")!;
  const rulerSpacer = parent.querySelector<HTMLDivElement>("#tl-ruler-spacer")!;
  const labelSplitter = parent.querySelector<HTMLDivElement>("#tl-label-splitter")!;

  // Apply the persisted (or default) track-name column width to the
  // spacer on the ruler row. The matching widths on individual track
  // rows are pushed in renderTracks via the rulerW global.
  rulerSpacer.style.width = `${rulerW}px`;
  graph.style.height = `${graphH}px`;

  graphResize.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const startHeight = graphH;
    const startY = e.clientY;
    graphResize.classList.add("dragging");
    const onMove = (moveEv: PointerEvent) => {
      graphH = Math.max(GRAPH_H_MIN, Math.min(GRAPH_H_MAX, startHeight + moveEv.clientY - startY));
      graph.style.height = `${graphH}px`;
      render();
    };
    const onUp = () => {
      graphResize.classList.remove("dragging");
      saveGraphH(graphH);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  resizeHandle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const startHeight = parent.offsetHeight;
    const startY = e.clientY;
    
    resizeHandle.classList.add("dragging");
    
    const onMove = (moveEv: PointerEvent) => {
      const deltaY = moveEv.clientY - startY;
      const minHeight = 100;
      const maxHeight = Math.max(100, window.innerHeight - 150);
      const targetHeight = Math.max(minHeight, Math.min(maxHeight, startHeight - deltaY));
      document.documentElement.style.setProperty('--timeline-h', `${targetHeight}px`);
      window.dispatchEvent(new Event("resize"));
    };
    
    const onUp = () => {
      resizeHandle.classList.remove("dragging");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  // Track-name column splitter. A single delegated pointerdown handler
  // catches the user grabbing the splitter on the ruler row, the
  // splitter inside any track-row label, OR the label cell itself
  // (so the entire title area acts as a grabbable handle). Width is
  // clamped to a reasonable range, applied to the spacer + every
  // .tl-row-label in place (no full re-render mid-drag), and persisted
  // on drag-end.
  const startLabelResize = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    tracks.classList.add("tl-resizing-label");
    const startX = e.clientX;
    const startW = rulerW;
    const onMove = (moveEv: PointerEvent) => {
      const dx = moveEv.clientX - startX;
      rulerW = Math.max(RULER_W_MIN, Math.min(RULER_W_MAX, startW + dx));
      rulerSpacer.style.width = `${rulerW}px`;
      tracks.querySelectorAll<HTMLDivElement>(".tl-row-label").forEach((el) => {
        el.style.width = `${rulerW}px`;
      });
    };
    const onUp = () => {
      tracks.classList.remove("tl-resizing-label");
      saveRulerW(rulerW);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  labelSplitter.addEventListener("pointerdown", startLabelResize);

  // Delegated handler: any pointerdown on a track-row label OR its
  // embedded splitter also starts the resize. This means the entire
  // title cell acts as a grab handle, not just the 18px splitter strip.
  // The per-keyframe click handler stops propagation, so a pointerdown
  // that lands on a keyframe (inside the .tl-row-track area) won't
  // reach this — those cells are outside .tl-row-label anyway.
  tracks.addEventListener("pointerdown", (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    // Splitter child → start resize.
    if (target.closest(".tl-label-splitter")) {
      startLabelResize(e);
      return;
    }
    // Label cell itself → also start resize (the user grabbed the
    // title area, not a keyframe). We only do this when the click is
    // on the label, not when it's on a keyframe in the track area.
    if (target.closest(".tl-row-label")) {
      startLabelResize(e);
    }
  });

  playBtn.addEventListener("click", () => toggle(state));
  stopBtn.addEventListener("click", () => stop(state));
  animSel.addEventListener("change", () => {
    const id = animSel.value as Id;
    if (state.project.animations[id]) {
      state.project.activeAnimationId = id;
      bus.emit(EV.PROJECT_CHANGED);
    }
  });
  animAdd.addEventListener("click", () => {
    // Prompt for a name. The dialog has a default that's the next
    // "anim-N" slot, which the user can keep or override. Cancelling
    // the dialog (Escape / click outside) aborts the new-animation
    // operation entirely — we don't create a half-named animation.
    const suggested = "anim-" + (state.project.animationOrder.length + 1);
    void promptForAnimName(suggested, state).then((name) => {
      if (name === null) return;
      const newId = addAnimation(state, name);
      state.project.activeAnimationId = newId;
      bus.emit(EV.PROJECT_CHANGED);
    });
  });
  // Double-click the animation dropdown to rename the active animation.
  // Single-click still switches; dblclick opens a small inline prompt
  // bound to the dropdown, so the user can fix typos without leaving
  // the toolbar.
  animSel.addEventListener("dblclick", () => {
    const anim = getActiveAnimation(state);
    if (!anim) return;
    void promptForAnimName(anim.name, state, "Rename animation").then((next) => {
      if (next === null || next === anim.name) return;
      anim.name = next;
      bus.emit(EV.PROJECT_CHANGED);
    });
  });
  autoKeyCb.addEventListener("change", () => {
    autoKey = autoKeyCb.checked;
  });
  // Duration input — commit on change (Enter or arrow buttons) and on
  // blur. Clamp to [0.1, 60] and never let the playhead run past the
  // new end. Re-render the ruler/tracks/graph to reflect the new width.
  const commitDuration = () => {
    const anim = getActiveAnimation(state);
    if (!anim) return;
    const v = parseFloat(durInp.value);
    if (!Number.isFinite(v)) { durInp.value = anim.duration.toFixed(2); return; }
    const next = Math.max(0.1, Math.min(60, v));
    if (Math.abs(next - anim.duration) < 0.0001) return;
    anim.duration = next;
    if (state.playback.currentTime > next) {
      state.playback.currentTime = next;
    }
    bus.emit(EV.PROJECT_CHANGED);
  };
  durInp.addEventListener("change", commitDuration);
  durInp.addEventListener("blur", commitDuration);
  durInp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); durInp.blur(); }
    else if (e.key === "Escape") { e.preventDefault(); durInp.blur(); }
  });
  // Current-time input. Same pattern as duration: commit on
  // change/blur/Enter, escape on Esc. Seeks the playhead to the
  // exact time the user typed, clamped to [0, anim.duration].
  const commitTime = () => {
    const anim = getActiveAnimation(state);
    if (!anim) { timeInp.value = "0.00"; return; }
    const v = parseFloat(timeInp.value);
    if (!Number.isFinite(v)) { timeInp.value = state.playback.currentTime.toFixed(2); return; }
    seek(state, Math.max(0, Math.min(anim.duration, v)));
    // Re-emit so the timeline/playhead redraw at the new time.
    bus.emit(EV.PROJECT_CHANGED);
  };
  timeInp.addEventListener("change", commitTime);
  timeInp.addEventListener("blur", commitTime);
  timeInp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); timeInp.blur(); }
    else if (e.key === "Escape") { e.preventDefault(); timeInp.blur(); }
  });

  // Scrubber: clicking on the ruler sets the playhead; drag updates it.
  let scrubPointerId: number | null = null;
  ruler.addEventListener("pointerdown", (e) => {
    ruler.setPointerCapture(e.pointerId);
    scrubPointerId = e.pointerId;
    state.playback.scrubbing = true;
    if (state.playback.playing) pause(state);
    seekFromEvent(e, ruler, state);
  });
  ruler.addEventListener("pointermove", (e) => {
    if (scrubPointerId !== e.pointerId) return;
    seekFromEvent(e, ruler, state);
  });
  const endScrub = (e: PointerEvent) => {
    if (scrubPointerId !== e.pointerId) return;
    ruler.releasePointerCapture(e.pointerId);
    scrubPointerId = null;
    state.playback.scrubbing = false;
  };
  ruler.addEventListener("pointerup", endScrub);
  ruler.addEventListener("pointercancel", endScrub);

  // Sync body horizontal scroll to ruler wrap.
  tracks.addEventListener("scroll", () => {
    rulerWrap.scrollLeft = tracks.scrollLeft;
    graph.scrollLeft = tracks.scrollLeft;
  });

  const maxZoomForVisibleDuration = (duration: number): number => {
    if (duration <= 0 || tracks.clientWidth <= 0) return ZOOM_MAX;
    const visibleTimeWidth = Math.max(1, tracks.clientWidth - rulerW);
    return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, visibleTimeWidth / duration));
  };
  const clampZoomToVisibleDuration = (duration: number): void => {
    const max = maxZoomForVisibleDuration(duration);
    if (timelineZoom > max) {
      timelineZoom = max;
      saveTimelineZoom(timelineZoom);
    }
  };

  // Shift + wheel = zoom in/out the timeline. Without Shift, the wheel
  // falls through to the default horizontal/vertical scroll of the
  // tracks container. We anchor the zoom to the cursor's time position:
  // the time under the cursor stays under the cursor after the zoom,
  // matching how the stage viewport's wheel handler works.
  tracks.addEventListener("wheel", (e: WheelEvent) => {
    if (!e.shiftKey) return;
    e.preventDefault();
    const rect = tracks.getBoundingClientRect();
    const cursorX = e.clientX - rect.left + tracks.scrollLeft;
    const timeUnderCursor = cursorX / timelineZoom;
    // Each wheel notch is a 1.15× step. Negative deltaY = zoom in.
    const factor = Math.exp(-e.deltaY * 0.0015);
    const anim = getActiveAnimation(state);
    const zoomMax = anim ? maxZoomForVisibleDuration(anim.duration) : ZOOM_MAX;
    const next = Math.max(ZOOM_MIN, Math.min(zoomMax, timelineZoom * factor));
    if (Math.abs(next - timelineZoom) < 0.0001) return;
    timelineZoom = next;
    saveTimelineZoom(timelineZoom);
    // Re-render the ruler/tracks/graph to reflect the new width, then
    // restore the cursor-anchored scroll position so the time under
    // the cursor doesn't jump.
    render();
    const newCursorX = timeUnderCursor * timelineZoom;
    tracks.scrollLeft = Math.max(0, newCursorX - (e.clientX - rect.left));
    rulerWrap.scrollLeft = tracks.scrollLeft;
     graph.scrollLeft = tracks.scrollLeft;
   }, { passive: false });

   // Same Shift + wheel zoom for the graph panel — shared timelineZoom
   // keeps the tracks and graph in sync.
   graph.addEventListener("wheel", (e: WheelEvent) => {
     if (!e.shiftKey) return;
     e.preventDefault();
     const rect = graph.getBoundingClientRect();
     const cursorX = e.clientX - rect.left + graph.scrollLeft;
     const timeUnderCursor = cursorX / timelineZoom;
     const factor = Math.exp(-e.deltaY * 0.0015);
     const anim = getActiveAnimation(state);
     const zoomMax = anim ? maxZoomForVisibleDuration(anim.duration) : ZOOM_MAX;
     const next = Math.max(ZOOM_MIN, Math.min(zoomMax, timelineZoom * factor));
     if (Math.abs(next - timelineZoom) < 0.0001) return;
     timelineZoom = next;
     saveTimelineZoom(timelineZoom);
     render();
     const newCursorX = timeUnderCursor * timelineZoom;
     tracks.scrollLeft = Math.max(0, newCursorX - (e.clientX - rect.left));
     rulerWrap.scrollLeft = tracks.scrollLeft;
     graph.scrollLeft = tracks.scrollLeft;
   }, { passive: false });

   // Drag the timeline to pan. Two gestures:
 //   - middle-mouse drag anywhere on the timeline body (mirrors the
 //     stage viewport's pan convention).
 //   - Shift + left-drag inside the tracks area (below the ruler). The
//     ruler keeps its scrub behaviour so we deliberately exclude it
//     here — Shift+drag on the ruler still scrubs the playhead.
  let panStart: { startX: number; scrollLeft: number } | null = null;
  const beginPan = (e: PointerEvent) => {
    if (e.button === 1) {
      e.preventDefault();
    } else if (e.button === 0 && e.shiftKey && e.target instanceof Node && tracks.contains(e.target) && !ruler.contains(e.target)) {
      e.preventDefault();
    } else {
      return;
    }
    panStart = { startX: e.clientX, scrollLeft: tracks.scrollLeft };
    const move = (ev: PointerEvent) => {
      if (!panStart) return;
      const dx = ev.clientX - panStart.startX;
      tracks.scrollLeft = Math.max(0, panStart.scrollLeft - dx);
    };
    const up = () => {
      panStart = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  body.addEventListener("pointerdown", beginPan);

  // Visual hint: when Shift is held, switch the tracks cursor to grab
  // so the user can see that Shift+drag will pan. We toggle a class on
  // the body rather than mutating each track's style — cheaper, and
  // clears automatically on blur / window defocus.
  const setShiftPan = (on: boolean) => body.classList.toggle("shift-pan", on);
  const onKeyDownHint = (e: KeyboardEvent) => {
    if (e.key === "Shift" && e.shiftKey) setShiftPan(true);
  };
  const onKeyUpHint = (e: KeyboardEvent) => {
    if (e.key === "Shift" || !e.shiftKey) setShiftPan(false);
  };
  window.addEventListener("keydown", onKeyDownHint);
  window.addEventListener("keyup", onKeyUpHint);
  window.addEventListener("blur", () => setShiftPan(false));

  const render = () => {
    const anim = getActiveAnimation(state);
    if (!anim) {
      timeInp.value = "0.00";
      durInp.value = "1.0";
      animSel.innerHTML = "";
      tracks.innerHTML = `<div class="tl-empty">No animation. Press + to add one.</div>`;
      graph.innerHTML = `<div class="tl-graph-empty">No animation</div>`;
      ruler.innerHTML = "";
      return;
    }
    clampZoomToVisibleDuration(anim.duration);
    // Don't clobber the user's in-progress edit. We only refresh the
    // input when it doesn't have focus, otherwise typing "2.5" would
    // snap back to whatever anim.duration is on every keystroke.
    if (document.activeElement !== timeInp) {
      timeInp.value = state.playback.currentTime.toFixed(2);
    }
    if (document.activeElement !== durInp) {
      durInp.value = anim.duration.toFixed(2);
    }
    // Animation switcher.
    animSel.innerHTML = state.project.animationOrder.map((id) => {
      const a = state.project.animations[id]!;
      return `<option value="${id}" ${id === state.project.activeAnimationId ? "selected" : ""}>${escapeHtml(a.name)}</option>`;
    }).join("");
    // Time ruler.
    renderRuler(ruler, state, anim.duration);
    renderPlayhead(ruler, state, anim.duration);
    // Tracks + graph editor.
    renderTracks(tracks, state, rulerWrap, anim.duration);
    renderGraph(graph, state, anim.duration);
    playBtn.textContent = state.playback.playing ? "⏸" : "▶";
    // Clipboard indicator.
    const clipLbl = parent.querySelector<HTMLSpanElement>("#tl-clip");
    if (clipLbl) {
      const n = state.clipboard?.entries.length ?? 0;
      clipLbl.textContent = n > 0 ? `clip: ${n} key${n === 1 ? "" : "s"}` : "clip: empty";
      clipLbl.className = "tl-clip" + (n > 0 ? " has" : "");
    }
  };
  render();
  bus.on(EV.PROJECT_CHANGED, render);
  bus.on(PLAYBACK_EV.TICK, render);
}

function seekFromEvent(e: PointerEvent, ruler: HTMLElement, state: EditorState): void {
  const anim = getActiveAnimation(state);
  if (!anim || anim.duration <= 0) return;
  const rect = ruler.getBoundingClientRect();
  const x = e.clientX - rect.left + ruler.scrollLeft;
  // The ruler scrolls horizontally with the tracks; we use a virtual
  // width proportional to the duration, with 8px per 0.1s step.
  const pxPerSec = timelineZoom;
  const t = Math.max(0, x / pxPerSec);
  seek(state, t);
}

function renderRuler(ruler: HTMLElement, state: EditorState, duration: number): void {
  ruler.innerHTML = "";
  const pxPerSec = timelineZoom;
  const totalW = timelineContentWidth(duration);
  ruler.style.width = `${totalW}px`;
  ruler.style.height = `${TIME_RULER_H}px`;
  // Generate tick marks every 0.1s with labels every 0.5s.
  const step = 0.1;
  for (let t = 0; t <= duration + 0.0001; t += step) {
    const x = Math.round(t * pxPerSec);
    const isMajor = Math.abs(t - Math.round(t * 2) / 2) < 1e-3;
    const tick = document.createElement("div");
    tick.className = "tl-tick" + (isMajor ? " major" : "");
    tick.style.left = `${x}px`;
    ruler.appendChild(tick);
    if (isMajor) {
      const lbl = document.createElement("div");
      lbl.className = "tl-tick-label";
      lbl.textContent = `${t.toFixed(1)}s`;
      lbl.style.left = `${x + 4}px`;
      ruler.appendChild(lbl);
    }
  }
  // Force ruler wrap to a known min-width so the scrollbar works.
  ruler.parentElement!.style.minWidth = `${totalW}px`;
}

let lastPlayhead: HTMLDivElement | null = null;
function renderPlayhead(ruler: HTMLElement, state: EditorState, duration: number): void {
  if (lastPlayhead && lastPlayhead.parentElement) {
    lastPlayhead.parentElement.removeChild(lastPlayhead);
    lastPlayhead = null;
  }
  const pxPerSec = timelineZoom;
  const x = state.playback.currentTime * pxPerSec;
  const ph = document.createElement("div");
  ph.className = "tl-playhead";
  ph.style.left = `${x}px`;
  ruler.appendChild(ph);
  lastPlayhead = ph;
}

function renderTracks(tracksEl: HTMLElement, state: EditorState, rulerWrap: HTMLElement, duration: number): void {
  const anim = getActiveAnimation(state);
  if (!anim) return;
  const pxPerSec = timelineZoom;
  const totalW = timelineContentWidth(duration);
  tracksEl.style.minWidth = `${totalW}px`;

  // Build a set of (bone,prop,time) strings that are currently
  // selected — used to apply a CSS class to those .tl-key divs.
  const selectedSet = new Set(state.keyframeSelection.map(kfKey));

  // Group tracks by bone. Each bone may have up to three bone tracks
  // (translate, rotation, scale) — we render them in that fixed order
  // so the column for a single bone always looks the same regardless
  // of which property the user happened to key first. Orphan tracks
  // (bone deleted) are kept in the data but skipped here. Slot tracks
  // are also skipped (P2.5.b — separate UI path).
  type BoneTrack = { property: "translate" | "rotation" | "scale"; trackIndex: number };
  const tracksByBone = new Map<Id, BoneTrack[]>();
  for (let i = 0; i < anim.tracks.length; i++) {
    const tr = anim.tracks[i]!;
    if (tr.kind === "slot") continue;
    if (!tr.boneId) continue;
    if (!state.project.bones[tr.boneId]) continue;
    if (tr.property !== "translate" && tr.property !== "rotation" && tr.property !== "scale") continue;
    const arr = tracksByBone.get(tr.boneId) ?? [];
    arr.push({ property: tr.property, trackIndex: i });
    tracksByBone.set(tr.boneId, arr);
  }
  // Sort each bone's tracks in a stable order: translate, rotation, scale.
  const ORDER: Record<"translate" | "rotation" | "scale", number> = { translate: 0, rotation: 1, scale: 2 };
  for (const arr of tracksByBone.values()) {
    arr.sort((a, b) => ORDER[a.property] - ORDER[b.property]);
  }

  // Walk the bone tree in DFS order so root bones appear first and
  // their children are visually nested under them via an indent. This
  // mirrors the hierarchy panel and makes the relationship between
  // parent and child tracks obvious at a glance.
  const renderTrackRow = (bone: Bone, depth: number, bt: BoneTrack): string => {
    const tr = anim.tracks[bt.trackIndex]!;
    const keyEls: string[] = [];
    for (let i = 0; i < tr.keyframes.length; i++) {
      const k = tr.keyframes[i]!;
      const x = k.time * pxPerSec;
      const refKey = `${tr.boneId}|${tr.property}|${k.time.toFixed(3)}`;
      const isSel = selectedSet.has(refKey);
      if (i < tr.keyframes.length - 1) {
        const kn = tr.keyframes[i + 1]!;
        const xn = kn.time * pxPerSec;
        keyEls.push(renderCurveSegment(x, xn, TRACK_H, k));
      }
      const curveIcon = k.curve === "stepped" ? "▣" : k.curve === "bezier" ? "~" : "/";
      keyEls.push(
        `<div class="tl-key ${isSel ? "selected" : ""}" ` +
          `data-bone="${tr.boneId}" data-prop="${tr.property}" data-time="${k.time.toFixed(3)}" ` +
          `style="left:${x}px" ` +
          `title="${tr.property} @ ${k.time.toFixed(2)}s — ${k.curve} — click to select, shift+click to add, right-click for menu">` +
          `<span class="tl-key-icon">${curveIcon}</span>` +
        `</div>`
      );
    }
    const propLbl = tr.property === "translate" ? "↔" : tr.property === "rotation" ? "↻" : tr.property === "scale" ? "⤢" : tr.property;
    // Indent by depth — each level adds 12px so a child of a child of
    // a root is clearly tucked under its parent. The label still uses
    // rulerW as the column width so the splitter handle stays aligned.
    const indent = 12 + depth * 12;
    return (
      `<div class="tl-row">` +
        `<div class="tl-row-label" style="width:${rulerW}px; padding-left:${indent}px">` +
          `<span class="tl-row-dot" style="background:${bone.color}"></span>` +
          `<span class="tl-row-name">${escapeHtml(bone.name)}</span>` +
          `<span class="tl-row-prop">${propLbl}</span>` +
          `<span class="tl-label-splitter" title="Drag to resize the track-name column">` +
            `<svg viewBox="0 0 6 18" width="6" height="18" aria-hidden="true">` +
              `<line x1="2" y1="3" x2="2" y2="15" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>` +
              `<line x1="4" y1="3" x2="4" y2="15" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>` +
            `</svg>` +
          `</span>` +
        `</div>` +
        `<div class="tl-row-track" style="height:${TRACK_H}px; width:${totalW}px">${keyEls.join("")}</div>` +
      `</div>`
    );
  };

  const trackRows: string[] = [];
  for (const { bone, depth } of walkTree(state.project)) {
    const bts = tracksByBone.get(bone.id);
    if (!bts || bts.length === 0) continue;
    for (const bt of bts) trackRows.push(renderTrackRow(bone, depth, bt));
  }
  tracksEl.innerHTML = trackRows.length > 0
    ? trackRows.join("")
    : `<div class="tl-empty">No keyframes yet. Scrub the playhead, then drag a bone to record a keyframe (auto-key).</div>`;

  // Click a keyframe to select. Shift-click adds. Right-click opens
  // the context menu. Double-click opens the ease popover.
  tracksEl.querySelectorAll<HTMLDivElement>(".tl-key").forEach((el) => {
    const ref: KeyframeRef = {
      boneId: el.dataset.bone as Id,
      property: el.dataset.prop as "translate" | "rotation" | "scale",
      time: parseFloat(el.dataset.time ?? "0"),
    };
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const additive = e.shiftKey;
      selectKeyframe(state, ref, additive);
      // Snap the playhead to the keyframe's time so the user sees
      // exactly what this keyframe looks like (the pose is sampled at
      // the keyframe's `time`, not interpolated between neighbours).
      // Don't disturb active playback — scrubbing while playing is
      // already handled by the ruler's pointerdown, and seeking
      // mid-play just causes a visible jump. Pause first.
      if (state.playback.playing) pause(state);
      seek(state, ref.time);
      bus.emit(EV.PROJECT_CHANGED);
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // If the right-clicked keyframe isn't in the selection, replace.
      const wasSelected = state.keyframeSelection.some(
        (s) => s.boneId === ref.boneId && s.property === ref.property && Math.abs(s.time - ref.time) < 0.005
      );
      if (!wasSelected) {
        selectKeyframe(state, ref, false);
      }
      openKeyframeContextMenu(e.clientX, e.clientY, state);
      bus.emit(EV.PROJECT_CHANGED);
    });
    el.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      e.preventDefault();
      openEasePopover(el, ref, state);
    });
  });

  // Click an empty area in the tracks to deselect.
  tracksEl.addEventListener("pointerdown", (e) => {
    if (!(e.target as HTMLElement).closest(".tl-key")) {
      // Initiate a drag-rect on the tracks surface.
      startDragRect(e, tracksEl, state);
    }
  });
}

/** Track-wide bezier graph editor (FR-TA-5 — P2.5.e). This is a
 *  compact overview of the active animation's selected track / selected
 *  keyframes. It doesn't replace the per-keyframe popover — clicking a
 *  segment opens that existing popover — but it finally gives users a
 *  graph-style view of easing across time rather than isolated diamonds. */
function renderGraph(parent: HTMLElement, state: EditorState, duration: number): void {
  const anim = getActiveAnimation(state);
  if (!anim) return;
  // Pick tracks to show: if the user has keyframes selected, show those
  // tracks; otherwise show all visible bone tracks. Slot tracks don't
  // have numeric curves yet (attachment is stepped by nature), so skip.
  const selectedKeys = new Set(state.keyframeSelection.map(kfKey));
  const showSelectedOnly = selectedKeys.size > 0;
  const tracks = anim.tracks.filter((tr) => {
    if (tr.kind === "slot" || !tr.boneId) return false;
    if (!showSelectedOnly) return true;
    return tr.keyframes.some((k) => selectedKeys.has(kfKey({ boneId: tr.boneId!, property: tr.property as "translate" | "rotation" | "scale", time: k.time })));
  });
  if (tracks.length === 0) {
    parent.innerHTML = `<div class="tl-graph-empty">Select keyframes to inspect curves</div>`;
    return;
  }
  const graphWidth = timelineContentWidth(duration);
  const W = rulerW + graphWidth;
  const H = graphH;
  const padL = rulerW, padR = 0, padT = 10, padB = 16;
  const graphInnerH = Math.max(1, H - padT - padB);
  const timeX = (t: number) => padL + Math.max(0, Math.min(duration, t)) * timelineZoom;
  const valueY = (v: number) => padT + (1 - Math.max(0, Math.min(1, v))) * graphInnerH;
  const paths: string[] = [];
  const markers: string[] = [];
  let colorIdx = 0;
  const colors = ["#7be39a", "#5b9cff", "#ff8a5b", "#cf6bff", "#f0d35b"];
  for (const tr of tracks) {
    const color = colors[colorIdx++ % colors.length]!;
    for (let i = 0; i < tr.keyframes.length - 1; i++) {
      const a = tr.keyframes[i]!;
      const b = tr.keyframes[i + 1]!;
      const x0 = timeX(a.time), x1 = timeX(b.time);
      // We render progress (0→1) rather than raw property value, so the
      // graph shows the interpolation curve independent of translate vs
      // rotate units.
      const y0 = valueY(0), y1 = valueY(1);
      let d: string;
      if (a.curve === "stepped") {
        d = `M ${x0} ${y0} H ${x1} V ${y1}`;
      } else if (a.curve === "bezier") {
        const cp1x = x0 + (x1 - x0) * (a.cp1x ?? 0);
        const cp1y = y0 + (y1 - y0) * (a.cp1y ?? 0);
        const cp2x = x0 + (x1 - x0) * (a.cp2x ?? 1);
        const cp2y = y0 + (y1 - y0) * (a.cp2y ?? 1);
        d = `M ${x0} ${y0} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${x1} ${y1}`;
      } else {
        d = `M ${x0} ${y0} L ${x1} ${y1}`;
      }
      const ref = `${tr.boneId}|${tr.property}|${a.time.toFixed(3)}`;
      paths.push(`<path class="tl-graph-path" data-kf="${ref}" d="${d}" stroke="${color}"/>`);
    }
    for (const k of tr.keyframes) {
      const ref = `${tr.boneId}|${tr.property}|${k.time.toFixed(3)}`;
      const selected = selectedKeys.has(ref);
      markers.push(`<circle class="tl-graph-dot ${selected ? "sel" : ""}" data-kf="${ref}" cx="${timeX(k.time)}" cy="${valueY(0)}" r="3" fill="${color}"/>`);
    }
  }
  parent.innerHTML = `
    <svg class="tl-graph-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <line x1="${padL}" y1="${valueY(0)}" x2="${W - padR}" y2="${valueY(0)}" class="tl-graph-axis"/>
      <line x1="${padL}" y1="${valueY(1)}" x2="${W - padR}" y2="${valueY(1)}" class="tl-graph-axis muted"/>
      <text x="8" y="${valueY(1) + 4}" class="tl-graph-label">1</text>
      <text x="8" y="${valueY(0) + 4}" class="tl-graph-label">0</text>
      ${paths.join("")}
      ${markers.join("")}
    </svg>`;
  // Click a graph path / dot to select that keyframe and open the
  // existing popover (where the user can edit the exact control points).
  parent.querySelectorAll<SVGElement>("[data-kf]").forEach((el) => {
    el.addEventListener("click", (ev) => {
      const raw = (el as SVGElement).dataset.kf;
      if (!raw) return;
      const [boneId, property, timeStr] = raw.split("|");
      if (!boneId || !property) return;
      const ref: KeyframeRef = { boneId, property: property as "translate" | "rotation" | "scale", time: parseFloat(timeStr ?? "0") };
      selectKeyframe(state, ref, false);
      const r = parent.getBoundingClientRect();
      openEasePopover(parent, ref, state);
      bus.emit(EV.PROJECT_CHANGED);
      ev.stopPropagation();
    });
  });
}

/** String key for a keyframe, used as a Map / Set lookup key. */
function kfKey(r: KeyframeRef): string {
  return `${r.boneId}|${r.property}|${r.time.toFixed(3)}`;
}

/** Replace (or extend) the keyframe selection. */
function selectKeyframe(state: EditorState, ref: KeyframeRef, additive: boolean): void {
  if (!additive) {
    state.keyframeSelection = [ref];
    return;
  }
  const ix = state.keyframeSelection.findIndex(
    (s) => s.boneId === ref.boneId && s.property === ref.property && Math.abs(s.time - ref.time) < 0.005
  );
  if (ix >= 0) {
    state.keyframeSelection.splice(ix, 1);
  } else {
    state.keyframeSelection.push(ref);
  }
}

/** Drag-rect selection: drag on empty area in tracks to box-select
 *  keyframes whose center is inside the rect. */
let dragRectEl: HTMLDivElement | null = null;
let dragRectStart: { x: number; y: number } | null = null;
function startDragRect(e: PointerEvent, tracksEl: HTMLElement, state: EditorState): void {
  if (e.button !== 0) return;
  const rect = tracksEl.getBoundingClientRect();
  const sx = e.clientX - rect.left + tracksEl.scrollLeft;
  const sy = e.clientY - rect.top + tracksEl.scrollTop;
  dragRectStart = { x: sx, y: sy };
  if (dragRectEl) { dragRectEl.remove(); dragRectEl = null; }
  dragRectEl = document.createElement("div");
  dragRectEl.className = "tl-drag-rect";
  dragRectEl.style.left = `${sx}px`;
  dragRectEl.style.top = `${sy}px`;
  dragRectEl.style.width = "0px";
  dragRectEl.style.height = "0px";
  tracksEl.appendChild(dragRectEl);

  const onMove = (ev: PointerEvent) => {
    if (!dragRectEl || !dragRectStart) return;
    const r = tracksEl.getBoundingClientRect();
    const cx = ev.clientX - r.left + tracksEl.scrollLeft;
    const cy = ev.clientY - r.top + tracksEl.scrollTop;
    const x = Math.min(dragRectStart.x, cx);
    const y = Math.min(dragRectStart.y, cy);
    const w = Math.abs(cx - dragRectStart.x);
    const h = Math.abs(cy - dragRectStart.y);
    dragRectEl.style.left = `${x}px`;
    dragRectEl.style.top = `${y}px`;
    dragRectEl.style.width = `${w}px`;
    dragRectEl.style.height = `${h}px`;
  };
  const onUp = (ev: PointerEvent) => {
    if (!dragRectEl || !dragRectStart) return;
    const r = tracksEl.getBoundingClientRect();
    const cx = ev.clientX - r.left + tracksEl.scrollLeft;
    const cy = ev.clientY - r.top + tracksEl.scrollTop;
    const x0 = Math.min(dragRectStart.x, cx);
    const y0 = Math.min(dragRectStart.y, cy);
    const x1 = Math.max(dragRectStart.x, cx);
    const y1 = Math.max(dragRectStart.y, cy);
    const additive = ev.shiftKey;
    // Find all keyframes whose pixel center is in the box.
    const pxPerSec = timelineZoom;
    const picked: KeyframeRef[] = [];
    const anim = getActiveAnimation(state);
    if (anim) {
      for (const tr of anim.tracks) {
        if (tr.kind === "slot" || !tr.boneId) continue;
        for (const k of tr.keyframes) {
          const kx = k.time * pxPerSec;
          // Center y in the row depends on row index; we don't know
          // it cheaply here, so just check x and treat all y in the
          // rect as a hit. (Good enough for box-select.)
          if (kx >= x0 && kx <= x1) {
            picked.push({ boneId: tr.boneId, property: tr.property as "translate" | "rotation" | "scale", time: k.time });
          }
        }
      }
    }
    if (additive) {
      // Merge with current selection.
      const seen = new Set(state.keyframeSelection.map(kfKey));
      for (const p of picked) if (!seen.has(kfKey(p))) state.keyframeSelection.push(p);
    } else {
      state.keyframeSelection = picked;
    }
    dragRectEl.remove();
    dragRectEl = null;
    dragRectStart = null;
    bus.emit(EV.PROJECT_CHANGED);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

/** Render the easing curve segment between two keyframes as a thin
 *  polyline SVG. For "linear" we draw a straight line; for "stepped"
 *  a step; for "bezier" we sample the cubic bezier. */
function renderCurveSegment(x0: number, x1: number, h: number, k: { curve: "linear" | "stepped" | "bezier"; cp1x?: number; cp1y?: number; cp2x?: number; cp2y?: number }): string {
  const w = x1 - x0;
  if (w <= 0) return "";
  const baseY = h / 2;
  let path = "";
  if (k.curve === "stepped") {
    path = `M${x0} ${baseY} L${x0 + 1} ${baseY} L${x0 + 1} ${baseY - h / 2 + 2} L${x1 - 1} ${baseY - h / 2 + 2} L${x1 - 1} ${baseY} L${x1} ${baseY}`;
  } else if (k.curve === "bezier") {
    // We have a 1D curve (progress y) over input x in [0, 1]. Draw
    // a 1D line mapping bezier y to vertical position. Sample ~12 points.
    const cp1x = k.cp1x ?? 0, cp1y = k.cp1y ?? 0, cp2x = k.cp2x ?? 1, cp2y = k.cp2y ?? 1;
    const N = 16;
    let d = `M${x0} ${baseY}`;
    for (let i = 1; i <= N; i++) {
      const x = i / N;
      // Solve bezier x → t (Newton).
      const t = solveBezierX(x, cp1x, cp2x);
      const y = 3 * (1 - t) * (1 - t) * t * cp1y + 3 * (1 - t) * t * t * cp2y + t * t * t;
      const px = x0 + x * w;
      const py = baseY - (y - 0.5) * (h - 6);
      d += ` L${px.toFixed(1)} ${py.toFixed(1)}`;
    }
    path = d;
  } else {
    // Linear.
    path = `M${x0} ${baseY} L${x1} ${baseY}`;
  }
  return `<svg class="tl-curve" width="${w}" height="${h}" style="left:${x0}px;position:absolute;top:0;pointer-events:none"><path d="${path}" stroke="var(--bone-color,#888)" stroke-width="1" fill="none" opacity="0.7"/></svg>`;
}

/** Local copy of the bezier solver for the curve visual. (Duplicate
 *  of solveBezierX in eval.ts — kept inline to avoid a TS import
 *  cycle from the timeline render path.) */
function solveBezierX(x: number, x1: number, x2: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let t = x;
  for (let i = 0; i < 8; i++) {
    const u = 1 - t;
    const fx = 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t - x;
    if (Math.abs(fx) < 1e-6) return t;
    const dfx = 3 * u * u * x1 + 6 * u * t * (x2 - x1) + 3 * t * t * (1 - x2);
    if (Math.abs(dfx) < 1e-9) break;
    t -= fx / dfx;
    if (t < 0) t = 0; if (t > 1) t = 1;
  }
  let lo = 0, hi = 1;
  for (let i = 0; i < 30; i++) {
    t = (lo + hi) / 2;
    const u = 1 - t;
    const fx = 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t - x;
    if (Math.abs(fx) < 1e-6) return t;
    if (fx < 0) lo = t; else hi = t;
  }
  return t;
}

/* ---------- Keyframe context menu ---------- */

let contextMenuEl: HTMLDivElement | null = null;
function openKeyframeContextMenu(x: number, y: number, state: EditorState): void {
  closeKeyframeContextMenu();
  const m = document.createElement("div");
  m.className = "tl-ctxmenu";
  // Initial position at the cursor. The viewport-clamp below may
  // shift the menu up/left if it would otherwise be cropped.
  m.style.left = `${x}px`;
  m.style.top = `${y}px`;
  const items: Array<{ label: string; shortcut?: string; action?: () => void; submenu?: boolean; sub?: typeof items; disabled?: boolean }> = [
    {
      label: "Cut", shortcut: "⌘X",
      action: () => {
        cutKeyframes(state, state.keyframeSelection.slice());
        state.keyframeSelection = [];
        bus.emit(EV.PROJECT_CHANGED);
      },
      disabled: state.keyframeSelection.length === 0,
    },
    {
      label: "Copy", shortcut: "⌘C",
      action: () => {
        copyKeyframes(state, state.keyframeSelection.slice());
        bus.emit(EV.PROJECT_CHANGED);
      },
      disabled: state.keyframeSelection.length === 0,
    },
    {
      label: "Paste", shortcut: "⌘V",
      action: () => {
        pasteKeyframes(state);
        bus.emit(EV.PROJECT_CHANGED);
      },
      disabled: !state.clipboard || state.clipboard.entries.length === 0,
    },
    {
      label: "Duplicate", shortcut: "⌘D",
      action: () => {
        duplicateKeyframes(state, state.keyframeSelection.slice());
        bus.emit(EV.PROJECT_CHANGED);
      },
      disabled: state.keyframeSelection.length === 0,
    },
    { label: "—", action: () => {} },
    {
      label: "Delete keyframe(s)",
      action: () => {
        for (const r of state.keyframeSelection) {
          deleteKeyframeAt(state, r.boneId, r.property, r.time);
        }
        state.keyframeSelection = [];
        bus.emit(EV.PROJECT_CHANGED);
      },
      disabled: state.keyframeSelection.length === 0,
    },
    { label: "—", action: () => {} },
    {
      label: "Easing →",
      submenu: true,
      sub: [
        { label: "Linear",      action: () => applyEaseToSelection(state, "linear") },
        { label: "Stepped",     action: () => applyEaseToSelection(state, "stepped") },
        { label: "Ease In",     action: () => applyEaseToSelection(state, "easeIn") },
        { label: "Ease Out",    action: () => applyEaseToSelection(state, "easeOut") },
        { label: "Ease In-Out", action: () => applyEaseToSelection(state, "easeInOut") },
      ],
      disabled: state.keyframeSelection.length === 0,
    },
  ];
  // Render.
  const buildRow = (it: { label: string; shortcut?: string; action?: () => void; submenu?: boolean; sub?: typeof items; disabled?: boolean }): HTMLDivElement => {
    const row = document.createElement("div");
    row.className = "tl-ctxmenu-row" + (it.disabled ? " disabled" : "");
    if (it.label === "—") {
      row.className = "tl-ctxmenu-sep";
      return row;
    }
    row.innerHTML = `<span class="tl-ctxmenu-label">${escapeHtml(it.label)}</span>` +
      (it.shortcut ? `<span class="tl-ctxmenu-sc">${escapeHtml(it.shortcut)}</span>` : "") +
      (it.submenu ? `<span class="tl-ctxmenu-arrow">▸</span>` : "");
    if (!it.disabled) {
      if (it.sub) {
        // Hover shows submenu.
        const sub = document.createElement("div");
        sub.className = "tl-ctxmenu tl-ctxmenu-sub";
        for (const c of it.sub) sub.appendChild(buildRow(c));
        row.appendChild(sub);
      } else {
        row.addEventListener("click", () => {
          it.action?.();
          closeKeyframeContextMenu();
        });
      }
    }
    return row;
  };
  for (const it of items) m.appendChild(buildRow(it));
  document.body.appendChild(m);
  // Clamp to the viewport so the menu isn't cropped when the user
  // right-clicks a keyframe near the bottom or right edge of the
  // window. Match the bone-context-menu behaviour: measure after
  // append, then shift left/up as needed.
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const r = m.getBoundingClientRect();
  if (x + r.width > vw) m.style.left = `${Math.max(4, vw - r.width - 4)}px`;
  if (y + r.height > vh) m.style.top = `${Math.max(4, vh - r.height - 4)}px`;
  contextMenuEl = m;
  // Close on outside click or Escape.
  const closeOnOutside = (ev: MouseEvent) => {
    if (m.contains(ev.target as Node)) return;
    closeKeyframeContextMenu();
    document.removeEventListener("mousedown", closeOnOutside, true);
  };
  const closeOnEsc = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      closeKeyframeContextMenu();
      document.removeEventListener("keydown", closeOnEsc, true);
    }
  };
  setTimeout(() => {
    document.addEventListener("mousedown", closeOnOutside, true);
    document.addEventListener("keydown", closeOnEsc, true);
  }, 0);
}
function closeKeyframeContextMenu(): void {
  if (contextMenuEl) { contextMenuEl.remove(); contextMenuEl = null; }
}

function applyEaseToSelection(state: EditorState, preset: EasingPreset): void {
  for (const r of state.keyframeSelection) {
    setKeyframeEasing(state, r, preset);
  }
  bus.emit(EV.PROJECT_CHANGED);
}

/* ---------- Easing popover (double-click on a keyframe) ---------- */

// Where the user last left the easing popover. Persisted across page
// loads via localStorage so the popover reopens at the same screen
// position it was closed at. We only remember position — size, content
// and which keyframe is being edited all live in the project state.
const EASEPOP_POS_KEY = "sf.easepop.pos.v1";

function loadEasePopoverPos(): { left: number; top: number } | null {
  try {
    const raw = localStorage.getItem(EASEPOP_POS_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (typeof v?.left === "number" && typeof v?.top === "number") {
      return { left: v.left, top: v.top };
    }
  } catch { /* corrupted blob — ignore, start fresh */ }
  return null;
}

function saveEasePopoverPos(left: number, top: number): void {
  try { localStorage.setItem(EASEPOP_POS_KEY, JSON.stringify({ left, top })); }
  catch { /* quota / disabled storage — non-fatal */ }
}

let easePopoverEl: HTMLDivElement | null = null;
function openEasePopover(anchor: HTMLElement, ref: KeyframeRef, state: EditorState): void {
  closeEasePopover();
  const anim = getActiveAnimation(state);
  if (!anim) return;
  const track = anim.tracks.find((t) => t.boneId === ref.boneId && t.property === ref.property);
  if (!track) return;
  const ix = track.keyframes.findIndex((k) => Math.abs(k.time - ref.time) < 0.005);
  if (ix < 0) return;
  const k = track.keyframes[ix]!;

  const pop = document.createElement("div");
  pop.className = "tl-easepop";
  pop.innerHTML = `
    <div class="tl-easepop-title">Easing — outgoing</div>
    <div class="tl-easepop-presets">
      ${(["linear", "stepped", "easeIn", "easeOut", "easeInOut"] as EasingPreset[]).map(
        (p) => `<button class="tl-easepop-btn ${curveMatchesPreset(k, p) ? "active" : ""}" data-preset="${p}">${presetLabel(p)}</button>`
      ).join("")}
    </div>
    <div class="tl-easepop-stage" id="tl-easepop-stage"></div>
    <div class="tl-easepop-row">
      <label>cp1.x <input type="number" min="-0.5" max="1.5" step="0.01" id="tl-easepop-cp1x" value="${k.cp1x ?? 0.42}"></label>
      <label>cp1.y <input type="number" min="-1"   max="2"   step="0.01" id="tl-easepop-cp1y" value="${k.cp1y ?? 0}"></label>
      <label>cp2.x <input type="number" min="-0.5" max="1.5" step="0.01" id="tl-easepop-cp2x" value="${k.cp2x ?? 0.58}"></label>
      <label>cp2.y <input type="number" min="-1"   max="2"   step="0.01" id="tl-easepop-cp2y" value="${k.cp2y ?? 1}"></label>
    </div>
  `;
  // Append first so we can accurately measure actual rendered dimensions
  document.body.appendChild(pop);
  easePopoverEl = pop;

  // Position next to the anchor, fitting completely inside the window boundaries.
  // If the user has previously moved the popover, reopen at that position
  // instead — see EASEPOP_POS_KEY.
  const r = anchor.getBoundingClientRect();
  const popWidth = pop.offsetWidth || 280;
  const popHeight = pop.offsetHeight || 350;
  const saved = loadEasePopoverPos();
  let initialLeft: number;
  let initialTop: number;
  if (saved) {
    // Clamp to the current viewport so a saved position from a larger
    // monitor doesn't open off-screen.
    initialLeft = Math.max(0, Math.min(window.innerWidth - popWidth, saved.left));
    initialTop  = Math.max(0, Math.min(window.innerHeight - popHeight, saved.top));
  } else {
    initialLeft = Math.max(10, Math.min(window.innerWidth - popWidth - 10, r.right + 6));
    initialTop  = Math.max(10, Math.min(window.innerHeight - popHeight - 10, r.top));
  }
  pop.style.left = `${initialLeft}px`;
  pop.style.top = `${initialTop}px`;

  // Make the ease popover draggable by dragging its title bar.
  const titleBar = pop.querySelector<HTMLDivElement>(".tl-easepop-title")!;
  titleBar.addEventListener("pointerdown", (dragEv) => {
    dragEv.preventDefault();
    titleBar.style.cursor = "grabbing";
    
    const startLeft = parseFloat(pop.style.left) || pop.offsetLeft;
    const startTop = parseFloat(pop.style.top) || pop.offsetTop;
    const startX = dragEv.clientX;
    const startY = dragEv.clientY;
    
    const onDragMove = (moveEv: PointerEvent) => {
      const dx = moveEv.clientX - startX;
      const dy = moveEv.clientY - startY;
      const newLeft = startLeft + dx;
      const newTop = startTop + dy;
      
      // Keep it within the viewport boundary with at least 50px visible
      pop.style.left = `${Math.max(0, Math.min(window.innerWidth - 100, newLeft))}px`;
      pop.style.top = `${Math.max(0, Math.min(window.innerHeight - 50, newTop))}px`;
    };
    
    const onDragUp = () => {
      titleBar.style.cursor = "";
      // Persist the new position so the popover reopens here next time.
      const left = parseFloat(pop.style.left);
      const top = parseFloat(pop.style.top);
      if (Number.isFinite(left) && Number.isFinite(top)) {
        saveEasePopoverPos(left, top);
      }
      window.removeEventListener("pointermove", onDragMove);
      window.removeEventListener("pointerup", onDragUp);
    };
    
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragUp);
  });

  const stage = pop.querySelector<HTMLDivElement>("#tl-easepop-stage")!;
  const inputs = {
    cp1x: pop.querySelector<HTMLInputElement>("#tl-easepop-cp1x")!,
    cp1y: pop.querySelector<HTMLInputElement>("#tl-easepop-cp1y")!,
    cp2x: pop.querySelector<HTMLInputElement>("#tl-easepop-cp2x")!,
    cp2y: pop.querySelector<HTMLInputElement>("#tl-easepop-cp2y")!,
  };
  const redraw = () => {
    const cp1x = parseFloat(inputs.cp1x.value);
    const cp1y = parseFloat(inputs.cp1y.value);
    const cp2x = parseFloat(inputs.cp2x.value);
    const cp2y = parseFloat(inputs.cp2y.value);
    stage.innerHTML = renderBezierEditor(cp1x, cp1y, cp2x, cp2y);
    // Wire drag handles. The clickable region is the 14px transparent
    // "hit" circle so the user has a generous target even though the
    // visible handle is only 7px. Drag updates the underlying value
    // (unbounded) and clamps the visual to the SVG edges.
    const dragHandle = (cp: "cp1" | "cp2") => {
      const handle = stage.querySelector<SVGCircleElement>(`circle[data-cp="${cp}-hit"]`)!;
      const onMove = (ev: PointerEvent) => {
        const r = stage.getBoundingClientRect();
        // Unbounded — drag past the edges to overshoot / anticipate.
        const x = (ev.clientX - r.left) / r.width;
        const y = 1 - (ev.clientY - r.top) / r.height;
        if (cp === "cp1") { inputs.cp1x.value = x.toFixed(3); inputs.cp1y.value = y.toFixed(3); }
        else { inputs.cp2x.value = x.toFixed(3); inputs.cp2y.value = y.toFixed(3); }
        redraw();
        commit();
      };
      handle.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        // Bracket the bezier-handle drag as one undo step. Without this,
        // a single user drag emits PROJECT_CHANGED on every pointermove
        // and would create one history entry per frame.
        beginTransaction(state);
        window.addEventListener("pointermove", onMove);
        const onUp = () => {
          endTransaction(state);
          // Force a final emit so the post-drag snapshot is captured.
          bus.emit(EV.PROJECT_CHANGED);
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointerup", onUp);
      });
    };
    dragHandle("cp1");
    dragHandle("cp2");
  };
  const commit = () => {
    // Set the keyframe to a custom bezier with the current control points.
    const cp1x = parseFloat(inputs.cp1x.value);
    const cp1y = parseFloat(inputs.cp1y.value);
    const cp2x = parseFloat(inputs.cp2x.value);
    const cp2y = parseFloat(inputs.cp2y.value);
    setKeyframeCurveCustom(state, ref, cp1x, cp1y, cp2x, cp2y);
  };
  // Preset buttons.
  pop.querySelectorAll<HTMLButtonElement>(".tl-easepop-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const preset = btn.dataset.preset as EasingPreset;
      setKeyframeEasing(state, ref, preset);
      // Update the input boxes to reflect the preset.
      const p = EASING_PRESETS[preset];
      inputs.cp1x.value = p.cp1x.toString();
      inputs.cp1y.value = p.cp1y.toString();
      inputs.cp2x.value = p.cp2x.toString();
      inputs.cp2y.value = p.cp2y.toString();
      redraw();
      bus.emit(EV.PROJECT_CHANGED);
    });
  });
  // Number-input edits commit live.
  for (const inp of Object.values(inputs)) {
    inp.addEventListener("input", () => { redraw(); commit(); });
  }
  // Hover-preview playhead. The playhead reads the current control
  // points from the inputs (so it updates live as the user types)
  // and shows the user exactly which (t, eased-value) the curve
  // produces at the cursor's x position. A small readout in the
  // popover's title bar shows the t/value as numbers too.
  // We attach the listeners to the stage div rather than the SVG so
  // moving past the SVG edge still hides the playhead.
  const playhead = pop.querySelector<SVGLineElement>("#tl-easepop-playhead")!;
  const playheadDot = pop.querySelector<SVGCircleElement>("#tl-easepop-playhead-dot")!;
  // Reuse a small <span> inside the title for the readout. We patch
  // the title's content once to add the span, then update its text.
  const titleEl = pop.querySelector<HTMLElement>(".tl-easepop-title")!;
  // Preserve any pre-existing leading text by walking children.
  let titleText = "";
  for (const node of Array.from(titleEl.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) titleText += node.textContent ?? "";
  }
  titleEl.innerHTML = "";
  const titleLabel = document.createElement("span");
  titleLabel.textContent = titleText;
  const titleReadout = document.createElement("span");
  titleReadout.className = "tl-easepop-readout";
  titleReadout.style.cssText = "float:right;color:#7be39a;font-family:monospace;font-size:11px;";
  titleEl.appendChild(titleLabel);
  titleEl.appendChild(titleReadout);
  const showPlayhead = (clientX: number, clientY: number): void => {
    const cp1x = parseFloat(inputs.cp1x.value) || 0;
    const cp1y = parseFloat(inputs.cp1y.value) || 0;
    const cp2x = parseFloat(inputs.cp2x.value) || 1;
    const cp2y = parseFloat(inputs.cp2y.value) || 1;
    const svg = stage.querySelector("svg") as SVGSVGElement | null;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const u = (clientX - r.left) / r.width;
    const t = Math.max(0, Math.min(1, u));
    const easedT = bezierTForX(t, cp1x, cp2x);
    const sampled = sampleBezierAtT(easedT, cp1x, cp1y, cp2x, cp2y);
    const xPx = r.left + t * r.width - svg.getBoundingClientRect().left;
    const yPx = (svg.getBoundingClientRect().height - sampled.y * r.height);
    // We draw the playhead in the SVG's local coord space. The SVG
    // uses px = x0 + clamp(t)*W, py = y1 - clamp(y)*H. For the
    // playhead we use the same mapping but with the *real* (unclamped)
    // sampled value so it tracks the visual curve.
    const w = 200, hh = 200, p = 12;
    const x0 = p, y0 = p, x1 = w - p, y1 = hh - p;
    const px = (x: number) => x0 + Math.max(-0.5, Math.min(1.5, x)) * (x1 - x0);
    const py = (y: number) => y1 - Math.max(-1, Math.min(2, y)) * (y1 - y0);
    playhead.setAttribute("x1", String(px(t)));
    playhead.setAttribute("x2", String(px(t)));
    playheadDot.setAttribute("cx", String(px(t)));
    playheadDot.setAttribute("cy", String(py(sampled.y)));
    playhead.setAttribute("opacity", "1");
    playheadDot.setAttribute("opacity", "1");
    titleReadout.textContent = `t=${t.toFixed(2)} v=${sampled.y.toFixed(2)}`;
    // yPx is unused (we set positions in SVG local coords). Silence
    // the unused-var lint to keep the function readable.
    void yPx;
  };
  const hidePlayhead = (): void => {
    playhead.setAttribute("opacity", "0");
    playheadDot.setAttribute("opacity", "0");
    titleReadout.textContent = "";
  };
  stage.addEventListener("mousemove", (e) => showPlayhead(e.clientX, e.clientY));
  stage.addEventListener("mouseleave", hidePlayhead);
  // Close on outside click or Escape.
  const closeOnOutside = (ev: MouseEvent) => {
    if (pop.contains(ev.target as Node)) return;
    closeEasePopover();
    document.removeEventListener("mousedown", closeOnOutside, true);
  };
  const closeOnEsc = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") { closeEasePopover(); document.removeEventListener("keydown", closeOnEsc, true); }
  };
  setTimeout(() => {
    document.addEventListener("mousedown", closeOnOutside, true);
    document.addEventListener("keydown", closeOnEsc, true);
  }, 0);

  redraw();
}

function closeEasePopover(): void {
  if (easePopoverEl) {
    // Persist wherever the user closed the popover from, even if they
    // didn't drag it (e.g. closed via Escape / outside-click). Reading
    // style.left/top here means we capture the last position they saw.
    const left = parseFloat(easePopoverEl.style.left);
    const top = parseFloat(easePopoverEl.style.top);
    if (Number.isFinite(left) && Number.isFinite(top)) {
      saveEasePopoverPos(left, top);
    }
    easePopoverEl.remove();
    easePopoverEl = null;
  }
}

function presetLabel(p: EasingPreset): string {
  switch (p) {
    case "linear": return "Linear";
    case "stepped": return "Stepped";
    case "easeIn": return "Ease In";
    case "easeOut": return "Ease Out";
    case "easeInOut": return "Ease In-Out";
  }
}

function curveMatchesPreset(k: { curve: "linear" | "stepped" | "bezier"; cp1x?: number; cp1y?: number; cp2x?: number; cp2y?: number }, p: EasingPreset): boolean {
  if (k.curve !== EASING_PRESETS[p].curve) return false;
  const eps = 1e-3;
  const e = EASING_PRESETS[p];
  return Math.abs((k.cp1x ?? -999) - e.cp1x) < eps
      && Math.abs((k.cp1y ?? -999) - e.cp1y) < eps
      && Math.abs((k.cp2x ?? -999) - e.cp2x) < eps
      && Math.abs((k.cp2y ?? -999) - e.cp2y) < eps;
}

/** Render a 200x200 SVG with a draggable bezier curve. The layout:
 *  - axis frame (faint) on the bottom and left
 *  - diagonal reference (dashed) from start to end
 *  - cp1 / cp2 tangent "rails" — these are the lines from the curve's
 *    endpoints to their respective control points, and they show the
 *    direction the curve heads off in. Color-matched to the handle.
 *  - the bezier curve itself
 *  - two endpoint markers (start = bottom-left, end = top-right)
 *  - two control handles (cp1 = blue, cp2 = orange) with a 14px
 *    transparent hit area each
 *  - a preview playhead (vertical line + dot) that follows the
 *    mouse when hovering, showing the user exactly which `(t, value)`
 *    their curve produces at that point. Hidden by default. */
function renderBezierEditor(cp1x: number, cp1y: number, cp2x: number, cp2y: number): string {
  const w = 200, h = 200, p = 12;
  const x0 = p, y0 = p, x1 = w - p, y1 = h - p;
  // Map cp1x in [0,1] to x0..x1, cp1y in [0,1] to y1..y0 (y inverted).
  // We deliberately don't clamp the visual position to [0,1] so the
  // user can drag a handle ABOVE 1 or BELOW 0 to overshoot the
  // segment's value (this is how Spine animators get recoil / anticipation
  // motion). The X axis is likewise unbounded for ease in/out timing.
  // The number-input boxes below the SVG still enforce the same
  // reasonable input range; the visual just shows the real position.
  const px = (x: number) => x0 + Math.max(-0.5, Math.min(1.5, x)) * (x1 - x0);
  const py = (y: number) => y1 - Math.max(-1, Math.min(2, y)) * (y1 - y0);
  const c1x = px(cp1x), c1y = py(cp1y);
  const c2x = px(cp2x), c2y = py(cp2y);
  // Curve path.
  const curve = `M${x0} ${y1} C${c1x} ${c1y}, ${c2x} ${c2y}, ${x1} ${y0}`;
  return `
    <svg width="${w}" height="${h}" style="background:#1c1f26;border-radius:4px;touch-action:none">
      <line x1="${x0}" y1="${y1}" x2="${x1}" y2="${y0}" stroke="#3a3f4a" stroke-dasharray="2 2"/>
      <line x1="${x0}" y1="${y1}" x2="${x1}" y2="${y1}" stroke="#3a3f4a"/>
      <line x1="${x0}" y1="${y1}" x2="${x0}" y2="${y0}" stroke="#3a3f4a"/>
      <line x1="${x0}" y1="${y1}" x2="${c1x}" y2="${c1y}" stroke="#5b9cff" stroke-width="1.25" stroke-dasharray="3 2" opacity="0.7"/>
      <line x1="${x1}" y1="${y0}" x2="${c2x}" y2="${c2y}" stroke="#ff8a5b" stroke-width="1.25" stroke-dasharray="3 2" opacity="0.7"/>
      <path d="${curve}" stroke="#7be39a" stroke-width="2" fill="none"/>
      <line id="tl-easepop-playhead" x1="0" y1="${y0}" x2="0" y2="${y1}" stroke="#fff" stroke-width="1" opacity="0" pointer-events="none"/>
      <circle id="tl-easepop-playhead-dot" cx="0" cy="0" r="3" fill="#fff" opacity="0" pointer-events="none"/>
      <circle cx="${x0}" cy="${y1}" r="3" fill="#888"/>
      <circle cx="${x1}" cy="${y0}" r="3" fill="#888"/>
      <circle data-cp="cp1-hit" cx="${c1x}" cy="${c1y}" r="14" fill="transparent" style="cursor:grab"/>
      <circle data-cp="cp1"      cx="${c1x}" cy="${c1y}" r="7"  fill="#5b9cff" stroke="#fff" stroke-width="1.5" style="cursor:grab;pointer-events:none"/>
      <circle data-cp="cp2-hit" cx="${c2x}" cy="${c2y}" r="14" fill="transparent" style="cursor:grab"/>
      <circle data-cp="cp2"      cx="${c2x}" cy="${c2y}" r="7"  fill="#ff8a5b" stroke="#fff" stroke-width="1.5" style="cursor:grab;pointer-events:none"/>
    </svg>
  `;
}

/** Sample a 1D cubic bezier at parameter t (0..1) along the time axis.
 *  We use Newton-Raphson to invert x = bezier(t) so we can answer
 *  "given a target time, what's the eased value?" — needed for the
 *  hover preview. */
function sampleBezierAtT(
  t: number,
  cp1x: number, cp1y: number, cp2x: number, cp2y: number,
): { x: number; y: number } {
  // Standard cubic Bezier (P0=0, P3=1 on x axis; arbitrary y on y axis).
  // x(s) = 3*s*(1-s)^2*cp1x + 3*s^2*(1-s)*cp2x + s^3
  // y(s) = 3*s*(1-s)^2*cp1y + 3*s^2*(1-s)*cp2y + s^3
  const u = 1 - t;
  return {
    x: 3 * t * u * u * cp1x + 3 * t * t * u * cp2x + t * t * t,
    y: 3 * t * u * u * cp1y + 3 * t * t * u * cp2y + t * t * t,
  };
}

/** Given a target x in [0,1], find the parameter t that produces it
 *  on the x-axis of the bezier. Newton-Raphson, 8 iterations — more
 *  than enough for a smooth interactive result. */
function bezierTForX(
  targetX: number,
  cp1x: number, cp2x: number,
): number {
  if (targetX <= 0) return 0;
  if (targetX >= 1) return 1;
  let t = targetX;
  for (let i = 0; i < 8; i++) {
    const u = 1 - t;
    const x = 3 * t * u * u * cp1x + 3 * t * t * u * cp2x + t * t * t;
    // dx/dt = 3(1-t)^2 cp1x + 6(1-t)t (cp2x - cp1x) + 3t^2 (1 - cp2x)
    const dx = 3 * u * u * cp1x + 6 * u * t * (cp2x - cp1x) + 3 * t * t * (1 - cp2x);
    if (Math.abs(dx) < 1e-6) break;
    t = Math.max(0, Math.min(1, t - (x - targetX) / dx));
  }
  return t;
}

function setKeyframeCurveCustom(state: EditorState, ref: KeyframeRef, cp1x: number, cp1y: number, cp2x: number, cp2y: number): void {
  const anim = getActiveAnimation(state);
  if (!anim) return;
  const track = anim.tracks.find((t) => t.boneId === ref.boneId && t.property === ref.property);
  if (!track) return;
  const ix = track.keyframes.findIndex((k) => Math.abs(k.time - ref.time) < 0.005);
  if (ix < 0) return;
  track.keyframes[ix] = { ...track.keyframes[ix]!, curve: "bezier", cp1x, cp1y, cp2x, cp2y };
  bus.emit(EV.PROJECT_CHANGED);
}

/** Add a new animation to the project and return its id. */
function addAnimation(state: EditorState, baseName: string): Id {
  const id = uniqueNameForAnim(state, baseName);
  state.project.animations[id] = {
    id,
    name: id,
    duration: 1.0,
    looping: true,
    tracks: [],
  };
  state.project.animationOrder.push(id);
  return id;
}

/** Show a small modal asking the user for an animation name.
 *  - Pre-fills the input with `defaultName` and selects it.
 *  - Validates non-empty + unique against existing animation names.
 *  - Resolves with the trimmed name on confirm, or `null` if cancelled. */
function promptForAnimName(defaultName: string, state: EditorState, title = "New animation"): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "sf-modal-overlay";
    overlay.innerHTML = `
      <div class="sf-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
        <div class="sf-modal-title">${escapeHtml(title)}</div>
        <input type="text" class="sf-modal-input" id="sf-modal-input" value="${escapeHtml(defaultName)}" maxlength="64">
        <div class="sf-modal-err" id="sf-modal-err"></div>
        <div class="sf-modal-actions">
          <button class="sf-modal-btn" data-act="cancel">Cancel</button>
          <button class="sf-modal-btn primary" data-act="ok">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const input = overlay.querySelector<HTMLInputElement>("#sf-modal-input")!;
    const err = overlay.querySelector<HTMLDivElement>("#sf-modal-err")!;
    input.focus();
    input.select();

    const close = (result: string | null) => {
      window.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(result);
    };
    const submit = () => {
      const v = input.value.trim();
      if (v.length === 0) { err.textContent = "Name can't be empty."; return; }
      const taken = Object.values(state.project.animations).some(
        (a) => a.name === v && a.id !== state.project.activeAnimationId,
      );
      if (taken) { err.textContent = `An animation named "${v}" already exists.`; return; }
      close(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
      else if (e.key === "Escape") { e.preventDefault(); close(null); }
    };
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(null);  // click outside the box
    });
    overlay.querySelector<HTMLButtonElement>("[data-act='cancel']")!.addEventListener("click", () => close(null));
    overlay.querySelector<HTMLButtonElement>("[data-act='ok']")!.addEventListener("click", submit);
    window.addEventListener("keydown", onKey, true);
  });
}

function uniqueNameForAnim(state: EditorState, base: string): Id {
  // Use the same uniqueness helper but scoped to animations.
  const taken = new Set<string>();
  for (const id of state.project.animationOrder) {
    const a = state.project.animations[id];
    if (a) taken.add(a.name);
  }
  if (!taken.has(base)) {
    // We want the id to be unique too — use the model's newId to avoid
    // collisions when the name happens to be the same as a bone's.
    return makeUniqueAnimId(state, base);
  }
  for (let i = 2; i < 1000; i++) {
    if (!taken.has(`${base}-${i}`)) {
      return makeUniqueAnimId(state, `${base}-${i}`);
    }
  }
  return makeUniqueAnimId(state, base);
}

function makeUniqueAnimId(state: EditorState, name: string): Id {
  // Reuse the model id generator via a 6-char string.
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  do {
    id = "";
    for (let i = 0; i < 6; i++) id += a[Math.floor(Math.random() * a.length)];
  } while (state.project.animations[id]);
  // We store name on the animation, not the id.
  state.project.animations[id] ||= {
    id,
    name,
    duration: 1.0,
    looping: true,
    tracks: [],
  };
  return id;
}



/* ---------- Auto-key hook (called by tools after a transform) ---------- */

/** When auto-key is on and a transform happens on a selected bone,
 *  record a keyframe for the affected property at the current
 *  playhead time. The caller decides which property was changed.
 *
 *  As of P2.B, the autoKey toggle is *gated by the editor mode*: only
 *  `mode === "animate"` records keyframes. Edit mode is bind-pose-only
 *  and Pose mode is preview-only — they should never produce a track
 *  side effect, regardless of the autoKey checkbox. */
export function autoKeyRecord(
  state: EditorState,
  boneId: Id,
  property: "translate" | "rotation" | "scale",
): void {
  if (state.mode !== "animate") return;
  if (!autoKey) return;
  if (state.playback.scrubbing) return; // don't record during scrub
  const bone = state.project.bones[boneId];
  if (!bone) return;
  if (property === "translate") {
    setKeyframe(state, boneId, "translate", state.playback.currentTime, { x: bone.x, y: bone.y });
  } else if (property === "rotation") {
    setKeyframe(state, boneId, "rotation", state.playback.currentTime, bone.rotation);
  } else {
    setKeyframe(state, boneId, "scale", state.playback.currentTime, { x: bone.scaleX, y: bone.scaleY });
  }
  bus.emit(EV.PROJECT_CHANGED);
}

/* ---------- Helpers re-exported for tests ---------- */
export { setKeyframe, deleteKeyframeAt, getActiveAnimation };
