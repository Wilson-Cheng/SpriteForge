// src/editor/history.ts
// Undo / redo for all editor actions (FR-UR-1, FR-UR-2 — P2.A).
//
// Strategy: full-project snapshots, captured after each PROJECT_CHANGED emit.
// We chose snapshot-and-restore over a per-mutation command pattern because:
//
//   1. Zero retrofit. Every existing mutation function in store.ts /
//      timeline.ts / panels.ts already emits PROJECT_CHANGED. Wiring history
//      into the bus means we capture all of them automatically — and any new
//      P2 feature gets undo "for free" as long as it follows the same emit
//      convention.
//
//   2. Trivial correctness. The post-undo state is byte-for-byte identical
//      to the pre-mutation state, including selection, playhead, animation
//      tracks, keyframe selection, and the keyframe clipboard contents
//      (everything except viewport pan/zoom and transient drag flags). No
//      bug class around "I forgot to invert THIS field in the inverse op."
//
//   3. Cheap. A typical project (a few bones, a few attachments, an idle
//      anim) serializes to 5–20 KB. Cap the stack at 100 entries → ~2 MB
//      worst case. Indistinguishable from background browser allocation.
//
// What's intentionally NOT in the snapshot, so undo doesn't fight UX:
//   - viewport.panX / panY / zoom              (view state — Spine convention)
//   - viewport.showGrid                        (toggle, not a project mutation)
//   - playback.playing / lastTickMs            (transient)
//   - playback.scrubbing                       (transient)
//   - dragging                                 (transient flag)
//   - tool                                     (mode, not data)
//   - transactionDepth                         (history-internal)
//   - clipboard                                (user expects it to persist
//                                                across undo)
//
// Coalescing: the inspector fires PROJECT_CHANGED on every keystroke as the
// user types into a numeric field. Without coalescing, typing "12.345" would
// create five undo entries. We debounce captures by 150 ms — the next
// capture call within that window resets the timer, so a burst becomes one
// entry. Force-flushing happens before any undo() / redo() so the user
// can't lose an in-progress edit by hitting Cmd+Z mid-typing.
//
// Transactions: drag operations (viewport bone drag, timeline keyframe
// drag, ruler scrub, future inspector slider scrubs) bump
// `state.transactionDepth` while interactive, and decrement it on release.
// Captures during transactionDepth > 0 are suppressed entirely — we only
// snapshot the *final* state after the user lets go. Without this, a
// 0.3-second mouse drag at 60 Hz would burn 18 undo entries on a single
// gesture.

import type { EditorState, KeyframeRef } from "./store";
import type { Project, Id } from "../core/model";

/** What we serialize. Anything not listed here is preserved as-is across
 *  an undo/redo (because we only mutate these fields on restore). */
interface Snapshot {
  project: Project;
  selection: Id[];
  currentTime: number;
  keyframeSelection: KeyframeRef[];
}

/** Default cap on undo depth. 100 actions ≈ a typical session's worth. */
const DEFAULT_CAPACITY = 100;

/** Coalesce rapid mutations into one undo step. 150 ms is roughly two
 *  keystrokes at fast typing — long enough to absorb a numeric edit
 *  burst, short enough that the user never *waits* for a capture. */
const DEBOUNCE_MS = 150;

export class History {
  /** Snapshots, oldest first. The top of the stack is the current state's
   *  most recent capture. Length 1 after init() means "nothing to undo." */
  private snapshots: string[] = [];
  /** Snapshots peeled off by undo, ready to be redone. Cleared on any
   *  fresh capture (the standard branching-undo behaviour: editing past
   *  an undo discards the future). */
  private redoStack: string[] = [];
  /** Pending debounced capture, or null when no capture is queued. */
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  /** Maximum stack size. Configurable for tests. */
  readonly capacity: number;

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.capacity = capacity;
  }

  /** Initialise the history with the current state as the baseline. Call
   *  once after the editor's initial state is fully constructed (sample
   *  rig seeded, sample sprite inserted, etc.) so the first undo lands on
   *  a meaningful starting point rather than a half-built state. */
  init(state: EditorState): void {
    this.cancelPending();
    this.snapshots = [serialize(state)];
    this.redoStack = [];
  }

  /** Schedule a capture. Coalesces rapid calls via a debounce timer, and
   *  is a no-op while the user is mid-transaction (drag), scrubbing, or
   *  during animation playback (the playhead advances every frame). */
  scheduleCapture(state: EditorState): void {
    if (state.transactionDepth > 0) return;
    if (state.playback.scrubbing) return;
    if (state.playback.playing) return;
    if (this.pendingTimer !== null) clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      this.captureNow(state);
    }, DEBOUNCE_MS);
  }

  /** Force-capture immediately, bypassing the debounce. Used by undo()
   *  and redo() so the user's in-flight typing isn't silently dropped
   *  when they hit Cmd+Z. */
  flush(state: EditorState): void {
    if (this.pendingTimer === null) return;
    clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.captureNow(state);
  }

  /** Cancel any queued capture without writing it. */
  cancelPending(): void {
    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
  }

  private captureNow(state: EditorState): void {
    const next = serialize(state);
    const top = this.snapshots[this.snapshots.length - 1];
    if (top === next) return; // dedupe identical adjacent states
    this.snapshots.push(next);
    // Cap. We allow capacity+1 because position 0 is the baseline (init)
    // and shifting it off would leave us unable to undo all the way back
    // to "fresh start". Trimming keeps the most recent `capacity` actions.
    while (this.snapshots.length > this.capacity + 1) this.snapshots.shift();
    this.redoStack = [];
  }

  canUndo(): boolean { return this.snapshots.length > 1; }
  canRedo(): boolean { return this.redoStack.length > 0; }

  /** Restore the state to the snapshot one step back. Returns true if
   *  the state changed. The current top is moved onto the redo stack so
   *  redo() can come back to it. */
  undo(state: EditorState): boolean {
    this.flush(state);
    if (!this.canUndo()) return false;
    const current = this.snapshots.pop()!;
    this.redoStack.push(current);
    const prev = this.snapshots[this.snapshots.length - 1]!;
    deserialize(state, prev);
    return true;
  }

  /** Re-apply the most recently undone snapshot. */
  redo(state: EditorState): boolean {
    this.flush(state);
    if (!this.canRedo()) return false;
    const next = this.redoStack.pop()!;
    this.snapshots.push(next);
    deserialize(state, next);
    return true;
  }

  /** For diagnostics / tests. */
  size(): { undo: number; redo: number } {
    // -1 because the top slot is the current state, not an undo target.
    return { undo: Math.max(0, this.snapshots.length - 1), redo: this.redoStack.length };
  }
}

/* ---------- Serialization (exported for tests / save-load reuse) ---------- */

export function serialize(state: EditorState): string {
  const snap: Snapshot = {
    project: state.project,
    selection: Array.from(state.selection.boneIds),
    currentTime: state.playback.currentTime,
    keyframeSelection: state.keyframeSelection.slice(),
  };
  return JSON.stringify(snap);
}

/** Restore the snapshot fields onto the existing state object IN PLACE.
 *  We never reassign top-level references (state.project, state.selection)
 *  because panels and the viewport hold the original references — they
 *  re-render on PROJECT_CHANGED but they read through the same handles. */
export function deserialize(state: EditorState, json: string): void {
  const snap: Snapshot = JSON.parse(json);
  // Replace the project's *contents*, not its identity.
  replaceInPlace(state.project as unknown as Record<string, unknown>, snap.project as unknown as Record<string, unknown>);
  state.selection.boneIds.clear();
  for (const id of snap.selection) state.selection.boneIds.add(id);
  state.playback.currentTime = snap.currentTime;
  state.keyframeSelection = snap.keyframeSelection;
}

/** Erase every own enumerable key on `target`, then copy from `source`.
 *  Necessary because plain Object.assign leaves keys-not-in-source intact,
 *  which would resurrect e.g. a bone that was deleted in the snapshot
 *  we're restoring to. */
function replaceInPlace<T extends Record<string, unknown>>(target: T, source: T): void {
  for (const k of Object.keys(target)) delete (target as Record<string, unknown>)[k];
  Object.assign(target, source);
}

/* ---------- Transaction helpers (used by tool / timeline drag handlers) ---------- */

/** Open a transaction window. Captures during the window are suppressed;
 *  one capture runs after `endTransaction` (via the bus's PROJECT_CHANGED
 *  hook). Reentrant — drag handlers that nest call sites still work. */
export function beginTransaction(state: EditorState): void {
  state.transactionDepth++;
}

/** Close a transaction window opened by beginTransaction. Always paired,
 *  even on early-return paths, or the editor will silently lose undo on
 *  every subsequent action. */
export function endTransaction(state: EditorState): void {
  state.transactionDepth = Math.max(0, state.transactionDepth - 1);
}
