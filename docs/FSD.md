# SpriteForge — Functional Specification Document (FSD)

**Version:** 0.3
**Date:** 2026-06-20
**Status:** P2.5 shipped; P3 partially started. See [IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md) for the feature-by-feature state.
**Working name:** *SpriteForge* (final)

> This document describes **what the application is**, **what it does today**, and **what is planned**. The role of this FSD is to define the **target surface** and let the implementation status document track progress against it.

---

## 0. Document Info

| Field | Value |
|---|---|
| **Project** | SpriteForge |
| **Purpose** | Web-based authoring tool for skeletal / rigged 2D sprite animation |
| **Primary deliverable** | In-browser editor + Spine 4.1 JSON export + standalone runtime player (`runtime.html`) |
| **Target user** | Indie web-game developer who wants Spine-style workflow without subscription or platform lock-in |
| **Compatibility target** | Spine 4.1.x JSON (round-trip clean; no spriteforge-specific superset) |
| **Out of scope (this doc)** | 3D rigging, physics simulation, server-side features, account system |

---

## 1. What SpriteForge Is

SpriteForge is a single-page web app that lets a game developer:

1. Import a sprite sheet or set of body-part PNGs.
2. Create a bone hierarchy (root → hip → torso → head, etc.).
3. Bind images to bones, optionally as deformable meshes with auto / inferred weights.
4. Animate by keyframing bone transforms on a timeline with linear / stepped / cubic-bezier easing.
5. Preview the deformed sprite in real time in WebGL2.
6. Export a **Spine 4.1 JSON** project + single-page atlas + atlas PNG that loads in any standard Spine runtime (Phaser, PixiJS, Unity, Godot, custom).
7. Drop the export into the included **standalone player** (`runtime.html`) to embed the sprite in any web game, with a small JavaScript animation API.
8. *(Partial)* Import an existing Spine 4.1 JSON + atlas + PNG bundle for round-trip editing — FK, single-skin, basic tracks only.
9. *(Partial)* Export an MP4 preview of the animation for sharing or review.

The app is fully **local-first**: no account, no server, no upload pipeline.

---

## 2. Vision & Scope

### 2.1 Long-term vision
A **free, open, browser-native** alternative to Spine that runs anywhere a browser does, exports to a format the entire game industry already understands, and feels good for indie-scale projects (1–10 animated characters per game).

### 2.2 In scope
- 2D skeletal animation (FK with optional two-bone IK)
- Mesh skinning (linear blend skinning) on GPU (WebGL2)
- Timeline-based keyframe animation with bezier curves
- Real-time WebGL preview
- Spine 4.1 JSON export
- Standalone HTML/JS player for the web target
- Single-page atlas export
- MP4 preview export
- Partial Spine 4.1 import (FK + default skin)
- Edit / Pose / Animate modes
- Local-first project storage (`.sfproj` JSON + `localStorage` autosave)

### 2.3 Out of scope (all versions)
- 3D bone rigging
- Server accounts, cloud storage, collaboration
- Mobile-native player / mobile editor
- Audio mixing inside the tool
- Physics simulation (cloth, ragdoll)
- Vector / Lottie output
- Native game engine export (consumers load Spine JSON through existing runtimes)

---

## 3. User Personas

| # | Persona | Win condition |
|---|---|---|
| 1 | **Indie Web-Game Dev** — building a 2D browser game (Phaser, PixiJS, Kaboom, custom). Has art but no Spine license. | Drop in PNGs, drag some bones, set keyframes, export JSON, load in the game. Done. |
| 2 | **Hobbyist / Learner** — curious about skeletal animation, learning the technique. | Open the tutorial in one tab, the tool in the other. Inspect the JSON to see how bones / meshes / keyframes work. |
| 3 | **Game-Jam Dev** — 48–72h deadline, needs *some* animation, fast, zero install. | Pure URL → drag images → animate → drop JSON into the game engine. Zero install. |

### 3.1 Primary use cases

| # | Use case | Outcome |
|---|---|---|
| UC-1 | Set up a 2D character (head + torso + 2 arms + 2 legs) for a walk cycle | Functional rig ready to animate |
| UC-2 | Animate a simple loop (idle bob, walk cycle, attack swing) | Exported JSON the runtime can play |
| UC-3 | Embed the result in a web game via the runtime player | Character appears and animates in-game |
| UC-4 | Edit an existing Spine 4.1 character downloaded from the web | Partially-imported project that can be tweaked and re-exported |

---

## 4. Glossary

| Term | Meaning |
|---|---|
| **Bone** | A transform node in a parent-child hierarchy. Has position, rotation, scale, length, visibility, and an inheritance mode. |
| **Slot** | An attachment point bound to a bone. Holds one active attachment, an optional list of alternates, and a per-slot tint. |
| **Attachment** | A visual element (image, mesh) bound to a slot. |
| **Mesh** | A polygon defined by vertices, edges, and triangles. Skinned to up to 4 bones per vertex. |
| **Skin weight** | Per-vertex influence value (0..1) of a bone. Vertices are typically influenced by 1–4 bones. |
| **Bind pose** | The reference pose used to compute skinning transforms. |
| **Keyframe** | A time-stamped snapshot of a bone's transform or a slot property, with an interpolation curve (linear / stepped / cubic-bezier). |
| **Timeline** | A horizontal track per (target, property) pair containing keyframes. |
| **Linear blend skinning (LBS)** | The deformation algorithm: each vertex is a weighted sum of bone transforms. |
| **Two-bone IK** | Inverse kinematics on a 3-bone chain (parent, middle, child end-effector) with a target point. |
| **Spine JSON** | The Spine 4.1.x project file format. Industry standard for 2D skeletal animation runtime interchange. |
| **Project file (`.sfproj`)** | The editor's own project format (richer than Spine JSON, includes editor state). |
| **Runtime player** | The standalone `runtime.html` that loads a `.json` + `.atlas` + `.png` and animates it. |

---

## 5. Functional Requirements

Each requirement has a stable ID, a status, and a one-line description. The **authoritative** status is [IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md). The summary below mirrors that doc; if they disagree, the status doc wins.

Legend used in this FSD: **Shipped** · **Partial** · **Planned**

### 5.1 Project management

| ID | Requirement | Status | Notes |
|---|---|---|---|
| FR-PM-1 | Create, save, load `.sfproj` (JSON) | Shipped | JSON download/load, including embedded image data. |
| FR-PM-2 | Autosave to `localStorage` | Shipped | Restore prompt on next load. |
| FR-PM-3 | Recent files | Shipped | Informational only — browsers cannot reopen local files by path. |
| FR-PM-4 | Spine 4.1 import (`.json` + `.atlas` + page PNG) | Partial | FK bones, slots, default skin, region + mesh attachments, translate/rotate/scale/color/attachment animation tracks. Constraints, non-default skins, FFD, events, draw order, linked meshes are dropped with warnings. |

### 5.2 Asset import

| ID | Requirement | Status | Notes |
|---|---|---|---|
| FR-AI-1 | Drag-and-drop or file-picker import of PNG, JPG | Shipped | |
| FR-AI-2 | Asset panel with thumbnails | Shipped | |
| FR-AI-3 | Sprite sheet import (TexturePacker JSON hash / array, plus grid metadata) | Shipped | |
| FR-AI-4 | 9-slice and polygon-outline authoring | Partial | Data model exists; full UI / renderer is not yet complete. |

### 5.3 Rigging (bones)

| ID | Requirement | Status | Notes |
|---|---|---|---|
| FR-RB-1 | Create bones (bone tool) | Shipped | |
| FR-RB-2 | Reparent bones (drag / make-root) | Shipped | |
| FR-RB-3 | Select, translate, rotate, scale bones | Partial | Full scale UI is limited. |
| FR-RB-4 | Delete bones (cascades attachments) | Shipped | |
| FR-RB-5 | Bone properties panel | Partial | Name, position, rotation, length, parent, color, visibility. Inherit modes ("normal" / "noRotationOrReflection") exist in the model and round-trip. |
| FR-RB-6 | Bone visibility toggle | Shipped | Hidden bones also hide bound attachments. |
| FR-RB-7 | Edit / Pose / Animate modes | Shipped | |

### 5.4 Slots and attachments

| ID | Requirement | Status | Notes |
|---|---|---|---|
| FR-SA-1 | Create slots bound to bones | Shipped | Created when an attachment is inserted. |
| FR-SA-2 | Assign image attachments (insert sample, drag/drop, file picker, sprite sheet import) | Shipped | |
| FR-SA-3 | Attachment placement (offset, rotation) | Partial | Attachment follows bind bone; direct per-attachment transform controls are limited. |
| FR-SA-4 | Multiple attachments per slot with keyframe swap | Shipped | Model, export, and editor support exist. |
| FR-SA-5 | Per-slot color tinting | Shipped | Shader tint + Spine color export. |

### 5.5 Meshes and skinning

| ID | Requirement | Status | Notes |
|---|---|---|---|
| FR-MS-1 | Quad mesh per attachment (auto-generated) | Shipped | |
| FR-MS-2 | Subdivide mesh (1-to-4 per triangle) | Shipped | `Shift+U`. |
| FR-MS-3 | Weight painting (brush UI) | Planned | Auto / inferred weights exist; brush-based painting UI is not complete. |
| FR-MS-4 | Auto-weights from nearest bone | Shipped | `Shift+W`. |
| FR-MS-5 | Mesh edge split / merge | Partial | Variable mesh foundation + subdivision exist; full edge split / merge UI is incomplete. |
| FR-MS-6 | FFD / deform bones | Planned | Deform track foundation exists; full FFD authoring / render workflow is not complete. |
| FR-MS-7 | Mesh cutting | Partial | Core cut helper + `Shift+X` diagonal cut exist; full knife UI is not complete. |

### 5.6 Timeline and animation

| ID | Requirement | Status | Notes |
|---|---|---|---|
| FR-TA-1 | Timeline panel with horizontal time axis | Shipped | |
| FR-TA-2 | Keyframes per bone / slot property | Shipped | Add / select / delete / copy / paste / duplicate. |
| FR-TA-3 | Multiple named animations | Shipped | |
| FR-TA-4 | Linear + stepped interpolation | Shipped | |
| FR-TA-5 | Bezier graph editor | Shipped | Per-keyframe popover and track-wide graph overview. |
| FR-TA-6 | Onion skinning | Shipped | Bone ghost frames at t ± 1 frame. |
| FR-TA-7 | Animation blending (crossfade) | Shipped | Runtime `spriteforge.setAnimation(name, { mix })`. Editor preview is simplified. |
| FR-TA-8 | Animation layers (additive) | Partial | Additive track flags and additive sampling exist; full editor UI is limited. |

### 5.7 Playback

| ID | Requirement | Status | Notes |
|---|---|---|---|
| FR-PB-1 | Play / pause / stop / loop | Shipped | |
| FR-PB-2 | Scrub timeline | Shipped | |
| FR-PB-3 | Real-time WebGL preview | Shipped | WebGL2 with a single LBS shader. |
| FR-PB-4 | Variable playback speed | Shipped | |
| FR-PB-5 | Step forward / back one frame | Shipped | |

### 5.8 Export

| ID | Requirement | Status | Notes |
|---|---|---|---|
| FR-EX-1 | Spine 4.1 JSON | Shipped | Exporter writes `spine: "4.1.0"`. |
| FR-EX-2 | Atlas PNG + `.atlas` text | Shipped | Single-page atlas. |
| FR-EX-3 | Self-contained HTML demo (`runtime.html`) | Shipped | Standalone WebGL player. |
| FR-EX-4 | *(reserved, not used)* | — | — |
| FR-EX-5 | MP4 preview | Shipped (with caveat) | Uses `@ffmpeg/ffmpeg` (ffmpeg.wasm) to encode H.264 libx264. First export is slow while the wasm bundle loads. |
| FR-EX-6 | GIF preview | Out of scope | Not implemented. MP4 is the supported preview format. |

### 5.9 Viewport

| ID | Requirement | Status | Notes |
|---|---|---|---|
| FR-VP-1 | Pan (middle-drag) and zoom (wheel) | Shipped | |
| FR-VP-2 | Toggle background grid | Shipped | `Shift+G`. |
| FR-VP-3 | Canvas background color / checkerboard | Partial | Background color in model; full UI / checkerboard controls are limited. |
| FR-VP-4 | Camera frame / fit selection | Shipped | `F` frames all, `Shift+F` frames selection. |

### 5.10 Inverse kinematics

| ID | Requirement | Status | Notes |
|---|---|---|---|
| FR-IK-1 | Two-bone IK constraint | Shipped | `Shift+K` creates a constraint on the selected child bone. Editable target / bend / mix. |
| FR-IK-2 | Multi-bone / path IK | Planned | Not implemented. |

### 5.11 Undo / redo

| ID | Requirement | Status | Notes |
|---|---|---|---|
| FR-UR-1 | Undo / redo stack | Shipped | Snapshot history with debounce and drag transactions. |
| FR-UR-2 | Shortcuts | Shipped | `Cmd/Ctrl+Z`, `Cmd/Ctrl+Shift+Z`. |

---

## 6. Non-Functional Requirements

| ID | Category | Requirement | Status |
|---|---|---|---|
| NFR-1 | Performance | Preview viewport maintains ≥ 30 FPS with one rigged character (≤ 500 vertices) on a 2020-era laptop. | Shipped |
| NFR-2 | Performance | File load time ≤ 500 ms for a 5 MB project. | Shipped |
| NFR-3 | Browser support | Latest 2 versions of Chrome, Firefox, Safari, Edge on **desktop only**. Mobile / touch editor is not supported. | Shipped (desktop) |
| NFR-4 | Privacy | All processing client-side. No upload, no telemetry. | Shipped |
| NFR-5 | Portability | Output JSON must load in official Spine 4.1 runtimes without modification. | Shipped |
| NFR-6 | File size | Runtime player ≤ 30 KB minified. Editor bundle is intentionally larger because it bundles ffmpeg.wasm for MP4 export. | Runtime shipped; editor larger than the original budget by design. |
| NFR-7 | Accessibility | All actions reachable via keyboard. Color-blind-safe default bone colors. | Partial — keyboard coverage is broad (`?` shows the full list). i18n is not implemented. |
| NFR-8 | Determinism | Same project + same time = same rendered frame. | Shipped |
| NFR-9 | Forward compatibility | Old `.sfproj` files must load in newer versions of the editor. | Shipped (`save-load` migrations). |
| NFR-10 | Internationalization | UI strings in external JSON, ready for translation (English first). | Planned |

---

## 7. Data Model

The in-memory data model lives in `src/core/model.ts`. The shape is the source of truth; the TypeScript interfaces below are a stable summary.

### 7.1 Core entities

```ts
// 7.1.1 Project (the root)
interface Project {
  version: number;          // CURRENT_PROJECT_VERSION
  name: string;
  width: number; height: number;  // stage size in world units
  fps: number;              // playback FPS
  background: string;       // hex
  bones: Record<Id, Bone>;
  boneOrder: Id[];          // insertion order
  rootIds: Id[];            // bones with parent === null
  attachments: Record<Id, MeshAttachment>;
  attachmentOrder: Id[];
  slots: Record<Id, Slot>;
  slotOrder: Id[];
  ik: Record<Id, IkConstraint>;
  ikOrder: Id[];
  animations: Record<Id, Animation>;
  animationOrder: Id[];
  activeAnimationId: Id;
}

interface Bone {
  id: Id;
  name: string;
  parent: Id | null;        // local transform
  x: number; y: number;
  rotation: number;         // degrees
  scaleX: number; scaleY: number;
  length: number;           // gizmo length
  color: string;            // hex
  visible?: boolean;        // FR-RB-6
  inherit?: "normal" | "noRotationOrReflection";  // Spine 4.x semantics
}

interface Slot {
  id: Id;
  name: string;
  attachment: Id | null;    // active attachment id
  bone: Id;
  tint?: string;            // FR-SA-5; "#RRGGBB" or "#RRGGBBAA"
  alts?: Id[];              // FR-SA-4 alternate attachments for keyframed swap
}

interface MeshAttachment {
  id: Id;
  name: string;
  imageDataUrl: string;     // PNG/JPG data URL
  imageWidth: number;
  imageHeight: number;
  vertices: Vertex[];       // variable length since P2.5.a
  triangles: Triangle[];    // CCW winding, ≥ 2
  uvs?: Array<{ u: number; v: number }>;
  bindBone: Id;             // bind origin
  boneRefs: Id[];           // all influencing bones
  nineSlice?: { left: number; right: number; top: number; bottom: number };  // P2.5.d data model
  outlinePoints?: number[]; // P2.5.d data model
}

interface Vertex {
  x: number; y: number;     // bind-pose position in world units
  bones: [Id, Id, Id, Id];  // up to 4
  weights: [number, number, number, number];  // sum to 1
}

interface IkConstraint {
  id: Id;
  name: string;
  targetBone: Id;           // end-effector (child)
  target: { x: number; y: number };
  bend: 1 | -1;
  mix: number;              // 0..1
}

interface Animation {
  id: Id;
  name: string;
  duration: number;         // seconds
  looping: boolean;
  tracks: Track[];
}

interface Track {
  kind?: "bone" | "slot";   // discriminant; default "bone" for back-compat
  boneId?: Id;              // for bone tracks
  slotId?: Id;              // for slot tracks
  property: "translate" | "rotation" | "scale" | "attachment" | "color" | "deform";
  layer?: number;           // FR-TA-8
  additive?: boolean;       // FR-TA-8
  keyframes: Keyframe[];    // sorted by time
}

interface Keyframe {
  time: number;             // seconds from animation start
  value: number | { x: number; y: number } | string;
  curve: "linear" | "stepped" | "bezier";
  cp1x?: number; cp1y?: number;  // bezier only
  cp2x?: number; cp2y?: number;
}
```

### 7.2 Scene-graph traversal (runtime)

FK evaluation walks `boneOrder`, accumulating world transforms via parent chain. IK is applied as a post-pass in `core/ik.ts` after FK sampling and before skinning.

### 7.3 Deformation (linear blend skinning)

Per vertex, weighted sum of bone transforms applied to the bind-pose position. Implemented as a single WebGL2 vertex shader (`src/runtime/main.ts`, `src/editor/viewport.ts`); the JS fallback lives in `core/eval.ts`.

---

## 8. File Format Spec

### 8.1 Project file (`.sfproj`)
- **Format:** JSON (UTF-8), schema `version` field is bumped on data-model changes.
- **Shape:** the `Project` interface in §7. Image data is embedded as data URLs.
- **Loading:** editor imports project JSON; `save-load.ts` migrates older versions on load.
- **Forward-compatibility:** unknown fields are ignored; missing fields fall back to defaults. Old `.sfproj` files always load in newer editor versions.

### 8.2 Runtime export — Spine 4.1 JSON (target)
- Exporter writes `spine: "4.1.0"`.
- Round-trips through the official Spine 4.1 runtimes (Phaser, PixiJS, Unity, Godot).
- One mesh + one atlas page is the supported baseline; multi-page atlas is not generated.

### 8.3 Runtime export — atlas
- Single-page PNG + `.atlas` text in the Spine 4.1 format.

### 8.4 Runtime export — MP4 preview
- Captured from the editor's WebGL preview, encoded with ffmpeg.wasm (H.264, yuv420p, faststart).

### 8.5 Runtime export — embedded demo HTML
- `runtime.html` is a self-contained WebGL player that loads a `.json` + `.atlas` + `.png` bundle dropped on the page.

---

## 9. User Experience & Workflow

### 9.1 Editor layout

```
┌──────────────────────────────────────────────────────────────┐
│  Menu bar: File · Edit · View · Tools · Hierarchy · Help    │
├──────────────┬───────────────────────────────────┬───────────┤
│              │                                   │           │
│  Tool        │        Viewport                   │ Hierarchy │
│  palette     │   (WebGL2 underlay + Canvas 2D    │ +         │
│  + actions   │    overlay for bones / gizmos)    │ Inspector │
│              │                                   │           │
├──────────────┴───────────────────────────────────┴───────────┤
│  Timeline panel: tracks per (bone, property), keyframes,     │
│  scrubber, bezier graph                                      │
└──────────────────────────────────────────────────────────────┘
```

Keyboard shortcuts mirror Spine's conventions (`V` select, `B` bone, `1/2/3` modes, `K` keyframe, etc.). The in-app `?` panel shows the full list.

### 9.2 Core workflow

```
1. New project (or use the seed rig) → 512×512 @ 30 FPS default
2. Drag images into the viewport / use Insert
3. Switch to Bone tool (B) → click to add bones, N to add child
4. Switch to Pose mode (2) or Animate mode (3) → pose the rig
5. Animate mode records keyframes automatically when bones move
6. Press Space to play; . and , to step; Shift+O for onion skin
7. Save as .sfproj
8. Export → Spine 4.1 JSON + atlas + PNG → drop into runtime.html
```

### 9.3 Keyboard shortcuts (summary)
The complete, current list lives in the in-app `?` panel and in `src/shared/keymap.ts`. Common entries:

| Key | Action |
|---|---|
| `V` | Select tool |
| `B` | Bone tool |
| `N` | Add child bone |
| `1` / `2` / `3` | Edit / Pose / Animate mode |
| `Space` | Play / pause |
| `S` | Stop and rewind |
| `K` | Add keyframe |
| `Cmd/Ctrl+N/S/O/I` | New / Save / Open / Insert image |
| `Cmd/Ctrl+Z` / `Cmd/Ctrl+Shift+Z` | Undo / Redo |
| `F` / `Shift+F` | Frame all / Frame selection |
| `Shift+G` | Toggle grid |
| `Shift+O` | Toggle onion skin |
| `Shift+W` | Recompute auto-weights |
| `Shift+U` | Subdivide mesh |
| `Shift+X` | Cut mesh |
| `Shift+K` | Create two-bone IK on selected child bone |
| `?` | Open the full shortcut panel |

---

## 10. Technical Architecture

### 10.1 High-level modules

```
┌─────────────────────────────────────────────────────────┐
│                  index.html (editor)                    │
├─────────────────────────────────────────────────────────┤
│  Editor layer (DOM + Canvas 2D overlay)                 │
│  ├── main.ts            (app boot, bus wiring)           │
│  ├── menu-bar.ts        (top menus)                     │
│  ├── tools.ts           (select / bone / rotate / scale)│
│  ├── panels.ts          (tool palette, hierarchy,       │
│  │                       inspector, attach thumbs)       │
│  ├── timeline.ts        (tracks, keyframes, bezier      │
│  │                       graph, easing popover)         │
│  ├── viewport.ts        (WebGL2 + Canvas 2D overlay,    │
│  │                       pan, zoom, gizmos)             │
│  ├── attachments.ts     (mesh, subdivide, cut, weights)  │
│  ├── hierarchy-ops.ts   (add child, make root, ...)     │
│  ├── history.ts         (undo/redo snapshot stack)      │
│  ├── persistence.ts     (autosave, recent files)        │
│  ├── save-load.ts       (.sfproj read/write + migrate)  │
│  ├── spine-export.ts    (Project → Spine 4.1 JSON)      │
│  ├── spine-import.ts    (Spine 4.1 bundle → Project)    │
│  ├── atlas-export.ts    (PNG + .atlas packing)          │
│  ├── preview-export.ts  (MP4 via ffmpeg.wasm)           │
│  ├── sprite-sheet.ts    (TexturePacker / grid import)   │
│  ├── store.ts           (editor state, bus, reducers)   │
│  ├── playback.ts        (play / scrub / step)           │
│  └── modal.ts           (file pickers, dialogs)         │
├─────────────────────────────────────────────────────────┤
│  Core (pure TS, no DOM)                                 │
│  ├── model.ts   (data types + defaults)                 │
│  ├── math.ts    (Vec2 / Mat3 helpers)                   │
│  ├── eval.ts    (FK sampling, easing, slot sampling)    │
│  ├── ik.ts      (two-bone IK solver)                    │
│  └── color.ts   (color helpers)                         │
├─────────────────────────────────────────────────────────┤
│  Runtime (used by editor preview + standalone)          │
│  ├── main.ts    (loader, player, WebGL renderer)        │
│  └── spine-types.ts   (Spine 4.1 JSON types)            │
├─────────────────────────────────────────────────────────┤
│  Shared                                                 │
│  ├── bus.ts, events.ts   (typed event bus)              │
│  ├── keymap.ts           (shortcut table)               │
│  ├── dom.ts              (DOM helpers)                  │
│  ├── build-info.ts       (VERSION / BUILD_ID)           │
│  └── vendor.d.ts         (third-party type stubs)       │
└─────────────────────────────────────────────────────────┘
```

### 10.2 Stack
- **Language:** TypeScript (strict mode)
- **Build:** esbuild
- **Editor UI:** Plain HTML + CSS
- **Preview render:** WebGL2, single LBS shader
- **MP4 encoder:** `@ffmpeg/ffmpeg` + `@ffmpeg/core` (lazy-loaded)
- **Dev server:** custom Node script (`scripts/dev.mjs`) using `ws`
- **No runtime UI framework**

### 10.3 Folder layout
```
spriteforge/
├── docs/                     FSD, IMPLEMENTATION_STATUS, TUTORIAL
├── public/                   CSS and runtime assets
├── samples/                  Example projects and Spine bundles
├── scripts/                  Dev server, build, verification
├── src/
│   ├── core/                 model, math, FK eval, IK
│   ├── editor/               all editor UI / IO / tools
│   ├── runtime/              standalone WebGL player
│   └── shared/               bus, keymap, DOM helpers
├── index.html                editor entry
├── runtime.html              standalone player entry
└── package.json
```

---

## 11. What is Planned

The following items are **not yet shipped** but are within the current FSD scope. They are tracked against the requirement IDs above. Cross-reference [IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md) for the live status of each one.

### 11.1 Mesh and deformation (P2.5+)
- **FR-MS-3** — Brush-based weight painting UI (auto / inferred weights already work).
- **FR-MS-5** — Full mesh edge split / merge UI (subdivision already works).
- **FR-MS-6** — FFD / deform-bone authoring and rendering.
- **FR-MS-7** — Full knife / multi-cut mesh editing UI (a single-axis diagonal cut already works).
- **FR-AI-4** — 9-slice and polygon-outline authoring UI and renderer (data model exists).

### 11.2 Animation (P3)
- **FR-TA-8** — Editor UI for animation layers and additive blending (flags + sampling exist).
- **FR-IK-2** — Multi-bone and path IK (two-bone IK is shipped).
- Bone scale authoring UI (sampling exists, editor control is limited — FR-RB-3).
- Multi-page atlas export.
- Per-attachment transform controls (FR-SA-3).

### 11.3 Viewport polish
- **FR-VP-3** — Checkerboard background UI and full background-color controls.
- Light mode theme (dark is the only theme today; originally earmarked as a P3 nice-to-have).

### 11.4 Import coverage (P3+)
- **FR-PM-4** completeness: FFD, events, draw order, multiple skins, linked meshes, and the advanced Spine track types. Today these are dropped with warnings at import time.
- DragonBones / other skeletal formats: each would need a dedicated mapping layer.

### 11.5 Internationalization and accessibility
- **NFR-7** accessibility audit.
- **NFR-10** externalized UI strings for translation.

### 11.6 Explicit non-goals (do not implement)

- GIF preview export.
- Mobile / touch editor.
- Server, account, cloud sync, collaboration.
- 3D rigging.
- Audio mixing / physics / particle systems.
- AI-assisted rig generation.

---

## 12. Risks & Open Questions

### 12.1 Risks
| # | Risk | Mitigation |
|---|---|---|
| R1 | MP4 export first-run latency (ffmpeg.wasm is large) | Lazy-load via dynamic import; show a loading indicator; do not block editor startup. |
| R2 | Spine 4.1 import drops advanced features | Document the dropped list in the import dialog and the TUTORIAL. |
| R3 | Browser tab killed → project lost | `localStorage` autosave + restore prompt on next load. |
| R4 | FFD and brush weight painting are UX-hard features | Plan iterations behind user feedback; auto-weights as the escape hatch. |
| R5 | Scope creep into P3 features | FSD is the gate; new requirements must reference or amend this document. |

### 12.2 Open questions
- Should multi-page atlas export ship, or is the single-page model good enough for indie use?
- Should DragonBones import ever be added, or is the Spine-4.1-JSON surface enough?
- Should the in-app help panel localize first, or are the current English strings stable enough?

---

## 13. Out of Scope (this document)

- Audio integration
- Particle / VFX system
- Physics (ragdoll, cloth)
- Account system, cloud sync, collaboration
- Versioning / git integration
- Mobile-native packaging (Capacitor, etc.)
- AI-assisted rig generation
- Sprite atlas packing for upload to consoles

---

## 14. Appendix

### 14.1 References
- **Spine runtimes & JSON spec:** https://github.com/EsotericSoftware/spine-runtimes
- **LBS algorithm:** Lewis et al., "Pose Space Deformation" (historical background, not required reading)
- **WebGL2 fundamentals:** https://webgl2fundamentals.org

### 14.2 Competitive landscape
| Tool | License | Notes |
|---|---|---|
| **Spine** | Subscription | Industry leader; our compatibility target |
| **DragonBones** | Free | Capable but dated UX, fewer runtimes |
| **Creature** | Subscription | Strong effects, Windows-only editor |
| **Rive** | Free tier | Browser-native, but different data model |
| **Sprite Fusion** | Subscription | Web-based, but 2D frame-based, not skeletal |
| **Aseprite** | One-time | Pixel art + frame-by-frame, not skeletal |

SpriteForge's positioning: **free, open, browser-native, Spine 4.1-compatible, indie-scale**.

### 14.3 Decision log (current, living)
- **Spine compatibility level:** Spine 4.1.0 JSON exactly. No spriteforge-specific superset — round-trip with official Spine 4.1 runtimes must work.
- **Default canvas size:** 512 × 512 @ 30 FPS (configurable per project).
- **Keyboard shortcuts:** mirror Spine (`V`/`B`/`P`/`K` etc.).
- **Theme:** dark mode default.
- **Atlas packer:** in-house (single-page).
- **Editor scope:** desktop only.
- **Preview export format:** MP4 (H.264 via ffmpeg.wasm). GIF is not supported.
- **Import scope:** Spine 4.1 JSON bundle (`.json` + `.atlas` + page PNG), partial coverage (FK, default skin, common tracks). Advanced features are dropped with warnings.

---

**End of FSD v0.3** — Replaces v0.2. Maintained in lockstep with `IMPLEMENTATION_STATUS.md`.
