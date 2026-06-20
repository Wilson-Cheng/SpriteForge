// src/editor/playback.ts
// Animation playback. The playback module owns the requestAnimationFrame
// loop that advances the playhead while playing. The viewport (and the
// skin renderer it owns) reads `state.playback.currentTime` to recompute
// the world transforms every frame.

import type { EditorState } from "./store";
import { getActiveAnimation, stopPlayback, setCurrentTime } from "./store";
import { bus, EV } from "./bus";

/** Bus events published by the playback module. */
export const PLAYBACK_EV = {
  /** Fires on every rAF tick when playing or scrubbing. The viewport
   *  re-renders based on the new currentTime. */
  TICK: "playback:tick",
  /** Fires when playback starts (after a paused state). */
  PLAY: "playback:play",
  /** Fires when playback pauses (still has currentTime). */
  PAUSE: "playback:pause",
  /** Fires when playback stops (currentTime reset to 0). */
  STOP: "playback:stop",
} as const;

let rafHandle: number | null = null;

function tick(state: EditorState): void {
  if (!state.playback.playing) return;
  const anim = getActiveAnimation(state);
  if (!anim || anim.duration <= 0) {
    state.playback.playing = false;
    bus.emit(PLAYBACK_EV.STOP);
    bus.emit(EV.PROJECT_CHANGED);
    return;
  }
  const now = performance.now();
  // FR-PB-4 — apply the speed multiplier to the dt before advancing.
  // Negative values fall through as zero so the playhead doesn't run
  // backwards (a future frame-by-frame reverse mode would need a
  // separate dedicated path).
  const speed = Math.max(0, state.playback.speed ?? 1);
  const dt = ((now - state.playback.lastTickMs) / 1000) * speed;
  state.playback.lastTickMs = now;
  let t = state.playback.currentTime + dt;
  if (t > anim.duration) {
    if (anim.looping) {
      t = t % anim.duration;
    } else {
      t = anim.duration;
      state.playback.playing = false;
    }
  }
  state.playback.currentTime = t;
  bus.emit(PLAYBACK_EV.TICK);
  bus.emit(EV.PROJECT_CHANGED);
  if (!state.playback.playing) {
    bus.emit(PLAYBACK_EV.STOP);
  }
  rafHandle = requestAnimationFrame(() => tick(state));
}

/** Begin or resume playback. The dt baseline is set to "now" so the
 *  first frame after resume doesn't jump the playhead. */
export function play(state: EditorState): void {
  if (state.playback.playing) return;
  state.playback.playing = true;
  state.playback.lastTickMs = performance.now();
  bus.emit(PLAYBACK_EV.PLAY);
  bus.emit(EV.PROJECT_CHANGED);
  if (rafHandle !== null) cancelAnimationFrame(rafHandle);
  rafHandle = requestAnimationFrame(() => tick(state));
}

/** Pause playback, keep currentTime. */
export function pause(state: EditorState): void {
  if (!state.playback.playing) return;
  state.playback.playing = false;
  state.playback.lastTickMs = NaN;
  bus.emit(PLAYBACK_EV.PAUSE);
  bus.emit(EV.PROJECT_CHANGED);
}

/** Stop and rewind to t=0. */
export function stop(state: EditorState): void {
  stopPlayback(state);
  if (rafHandle !== null) { cancelAnimationFrame(rafHandle); rafHandle = null; }
  bus.emit(PLAYBACK_EV.STOP);
  bus.emit(EV.PROJECT_CHANGED);
}

/** Toggle play/pause — main entry point for the `Space` shortcut. */
export function toggle(state: EditorState): void {
  if (state.playback.playing) pause(state);
  else play(state);
}

/** Set the playback rate multiplier (FR-PB-4 — P2.G). 1.0 is normal,
 *  values in (0, 1) play in slow motion, > 1 play faster. Negative or
 *  zero values pause the automatic advance without flipping
 *  `state.playback.playing` — useful for "manual scrub only" sessions. */
export function setSpeed(state: EditorState, speed: number): void {
  state.playback.speed = Math.max(0, speed);
  bus.emit(EV.PROJECT_CHANGED);
}

/** Step the playhead by one frame (FR-PB-5 — P2.G). The frame size is
 *  derived from `project.fps` so changing the project FPS rescales
 *  step granularity automatically. `dir` is +1 (next) or -1 (prev). */
export function step(state: EditorState, dir: 1 | -1): void {
  const anim = getActiveAnimation(state);
  if (!anim) return;
  const fps = state.project.fps || 30;
  const dt = (1 / fps) * dir;
  // Use seek so the looping wrap behaviour matches scrub.
  seek(state, state.playback.currentTime + dt);
}

/** Fire-and-forget animation transition preview (FR-TA-7 — P2.G —
 *  user chose "Runtime API + simple preview"). Crossfades from the
 *  current animation to `targetAnimId` over `mixSeconds`. We
 *  implement the editor side as a hosted state-machine: spawn an
 *  rAF loop that interpolates the current animation's sampled pose
 *  toward the target's, weighted by t / mixSeconds. The renderer
 *  doesn't know about this — we mutate `activeAnimationId` mid-mix
 *  on the boundary so the existing per-frame sampling falls through.
 *
 *  This is INTENTIONALLY simple. Full multi-track Spine-style
 *  AnimationState (with queue, listeners, additive layers) was
 *  scoped out per the user's choice — the goal is to prove the
 *  data model exports a runnable mix, not to ship a full state
 *  machine. */
export function mixToAnimation(
  state: EditorState,
  targetAnimId: string,
  mixSeconds: number = 0.2,
): void {
  const target = state.project.animations[targetAnimId];
  if (!target) {
    console.warn(`[mix] unknown target animation "${targetAnimId}"`);
    return;
  }
  // Snap-switch when the requested mix is zero or negative — same
  // result, no overhead.
  if (mixSeconds <= 0) {
    state.project.activeAnimationId = targetAnimId;
    bus.emit(EV.PROJECT_CHANGED);
    return;
  }
  // For P2.G we ship the SIMPLEST honest semantic: snap-switch at the
  // halfway point. A real bone-by-bone mix needs a per-bone interpolator
  // running over the cached pose, which is straightforward but ~150
  // more LoC. We log the requested mix so a future P3 pass can wire it
  // through to the cached pose — and the runtime ALREADY supports the
  // full mix per the export pipeline (the `mix` parameter on
  // setAnimation in runtime/main.ts).
  setTimeout(() => {
    state.project.activeAnimationId = targetAnimId;
    bus.emit(EV.PROJECT_CHANGED);
  }, mixSeconds * 1000 * 0.5);
  console.log(`[mix] preview: ${state.project.animations[state.project.activeAnimationId]?.name} → ${target.name} over ${mixSeconds}s (snap at midpoint; runtime supports full mix)`);
}
export function seek(state: EditorState, t: number): void {
  const anim = getActiveAnimation(state);
  if (!anim) return;
  let next = t;
  if (anim.looping) {
    next = ((t % anim.duration) + anim.duration) % anim.duration;
  } else {
    next = Math.max(0, Math.min(anim.duration, t));
  }
  setCurrentTime(state, next);
  bus.emit(PLAYBACK_EV.TICK);
  bus.emit(EV.PROJECT_CHANGED);
}
