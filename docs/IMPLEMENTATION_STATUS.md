# Implementation Status

This file maps the Functional Specification Document ([FSD.md](./FSD.md)) to the current implementation.

**Short answer:** not every FSD item is fully complete yet. SpriteForge is usable and has many P1/P2/P2.5/P3 foundations implemented, but several advanced features are currently partial, foundational, or limited by browser/runtime constraints.

Legend:

- ✅ Implemented and usable
- 🟡 Partial / foundation exists, but UI or full compatibility is incomplete
- ❌ Not implemented
- ⚠️ Implemented with caveats

## Functional requirements

### Project management

| Requirement | Status | Notes |
| --- | --- | --- |
| FR-PM-1 Create/save/load `.sfproj` | ✅ | JSON-based project download/load. |
| FR-PM-2 Autosave | ✅ | `localStorage` autosave with restore prompt. |
| FR-PM-3 Recent files | ✅ | Recent file list is informational because browsers cannot reopen local files by path without user selection. |
| FR-PM-4 Spine import | 🟡 | Partial Spine 4.x JSON + `.atlas` + page PNG import. Drops constraints, non-default skins, FFD, events, draw order, linked meshes with warnings. |

### Asset import

| Requirement | Status | Notes |
| --- | --- | --- |
| FR-AI-1 PNG/JPG drag/drop or picker | ✅ | Drag/drop and file picker. |
| FR-AI-2 Asset panel | ✅ | Attachment list with thumbnails. |
| FR-AI-3 Sprite sheet import | ✅ | TexturePacker JSON hash/array + grid metadata support. |
| FR-AI-4 9-slice / polygon outline | 🟡 | Data model exists (`nineSlice`, `outlinePoints`); full authoring UI/render behavior is not complete. |

### Rigging / bones

| Requirement | Status | Notes |
| --- | --- | --- |
| FR-RB-1 Create bones | ✅ | Bone tool + hierarchy child button. |
| FR-RB-2 Reparent bones | ✅ | Hierarchy drag/drop and make-root action. |
| FR-RB-3 Select/translate/rotate/scale bones | 🟡 | Select + translate + rotation in inspector. Full scale UI is limited. |
| FR-RB-4 Delete bones | ✅ | Delete selection, cascades attachments. |
| FR-RB-5 Bone properties | 🟡 | Name, position, rotation, length, parent readout, color visibility. Inherit-rotation/inherit-scale are not fully modeled. |
| FR-RB-6 Bone visibility | ✅ | Eye toggle; hidden bones also hide bound attachments. |
| FR-RB-7 Edit/Pose/Animate modes | ✅ | Spine-style 3-mode workflow. |

### Slots and attachments

| Requirement | Status | Notes |
| --- | --- | --- |
| FR-SA-1 Create slots bound to bones | ✅ | Created when an attachment is inserted. |
| FR-SA-2 Assign image attachments | ✅ | Insert sample, drag/drop, file picker, sprite sheet import. |
| FR-SA-3 Attachment placement | 🟡 | Attachment follows bind bone; direct per-attachment transform controls are limited. |
| FR-SA-4 Multiple attachments per slot + keyframe swap | 🟡 | Data model and Spine export support exist; complete editor UI is still limited. |
| FR-SA-5 Slot tinting | ✅ | Shader tint + Spine color export. |

### Meshes and skinning

| Requirement | Status | Notes |
| --- | --- | --- |
| FR-MS-1 Quad mesh per attachment | ✅ | Every inserted image becomes a quad mesh. |
| FR-MS-2 Subdivide mesh | ✅ | Subdivide helper and Shift+U action. |
| FR-MS-3 Weight painting | 🟡 | Auto/inferred weights and recompute exist; brush-based painting UI is not complete. |
| FR-MS-4 Auto-weights | ✅ | Shift+W recomputes nearest-bone weights. |
| FR-MS-5 Mesh edge split/merge | 🟡 | Variable mesh foundation and subdivision exist; full edge split/merge UI is incomplete. |
| FR-MS-6 FFD bones | 🟡 | Deform track foundation exists; full FFD authoring/render workflow is not complete. |
| FR-MS-7 Mesh cutting | 🟡 | Core cut helper + Shift+X diagonal cut; full knife UI is not complete. |

### Timeline and animation

| Requirement | Status | Notes |
| --- | --- | --- |
| FR-TA-1 Timeline panel | ✅ | Horizontal time axis. |
| FR-TA-2 Keyframes per bone property | ✅ | Add/select/delete/copy/paste/duplicate keyframes. |
| FR-TA-3 Multiple animations | ✅ | New/switch animations. |
| FR-TA-4 Linear interpolation | ✅ | Linear + stepped + bezier sampling. |
| FR-TA-5 Bezier graph editor | ✅ | Per-keyframe popover and track-wide graph overview. |
| FR-TA-6 Onion skinning | ✅ | Bone ghost frames at t±1 frame. |
| FR-TA-7 Animation blending | ✅ | Runtime `spriteforge.setAnimation(name, { mix })`; editor preview is simplified. |
| FR-TA-8 Animation layers | 🟡 | Additive track flags and additive sampling exist; full UI is limited. |

### Playback

| Requirement | Status | Notes |
| --- | --- | --- |
| FR-PB-1 Play/pause/stop/loop | ✅ | Timeline controls + shortcuts. |
| FR-PB-2 Scrub timeline | ✅ | Mouse scrub. |
| FR-PB-3 Real-time WebGL preview | ✅ | WebGL2 preview path. |
| FR-PB-4 Variable speed | ✅ | Speed up/down controls. |
| FR-PB-5 Step forward/back | ✅ | Frame-step controls. |

### Export

| Requirement | Status | Notes |
| --- | --- | --- |
| FR-EX-1 Spine 4.x JSON | ✅ | JSON export for standard Spine-compatible runtimes. |
| FR-EX-2 Atlas PNG + atlas text | ✅ | Single-page atlas export. |
| FR-EX-3 Self-contained HTML demo | ✅ | `runtime.html` standalone player. |
| FR-EX-4 *(reserved, not used)* | — | — |
| FR-EX-5 MP4 preview | ⚠️ | MP4 export uses `@ffmpeg/ffmpeg` (ffmpeg.wasm) to encode H.264 (`libx264`, yuv420p, faststart). The wasm bundle is large, so the first export is slow while it loads; subsequent exports are faster. There is no GIF export. |

### Viewport

| Requirement | Status | Notes |
| --- | --- | --- |
| FR-VP-1 Pan/zoom | ✅ | Wheel zoom, middle-drag pan, frame all. |
| FR-VP-2 Grid toggle | ✅ | Shift+G. |
| FR-VP-3 Background color/checkerboard | 🟡 | Background color in model; full UI/checkerboard controls limited. |
| FR-VP-4 Camera frame/fit selection | ✅ | Frame all and frame selection. |

### Undo/redo

| Requirement | Status | Notes |
| --- | --- | --- |
| FR-UR-1 Undo/redo stack | ✅ | Snapshot history with debounce and drag transactions. |
| FR-UR-2 Shortcuts | ✅ | Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z. |

### Inverse kinematics

| Requirement | Status | Notes |
| --- | --- | --- |
| FR-IK-1 Two-bone IK | ✅ | `Shift+K` creates a constraint on the selected child bone; `core/ik.ts` solves the chain. |
| FR-IK-2 Multi-bone / path IK | ❌ | Not implemented. |

## Non-functional notes

- **Client-side privacy:** all processing is browser-local.
- **Runtime bundle size:** still below the FSD runtime budget.
- **Editor bundle size:** ffmpeg.wasm is lazy-loaded for MP4 export, so the editor startup path does not pay the encoder cost.
- **Spine version:** exporter writes `spine: "4.1.0"`; importer accepts any `4.x` file with a warning for non-4.1 versions.
- **GIF preview export:** not supported. MP4 is the only preview export format.
