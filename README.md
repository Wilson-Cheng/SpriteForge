<div align="center">

# SpriteForge

### A browser-based editor for rigged 2D sprite animation — 100% local in your browser, no install, no account

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)](https://www.typescriptlang.org)
[![WebGL2](https://img.shields.io/badge/Render-WebGL2-orange)](https://www.khronos.org/webgl/)
[![Spine 4.1 JSON](https://img.shields.io/badge/Export-Spine%204.1%20JSON-6c8ebf)](https://github.com/EsotericSoftware/spine-runtimes)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

</div>

---

A skeletal 2D animation tool you can run in a single browser tab. Drop in some PNGs, build a bone rig, keyframe the animation, and export a Spine 4.1 JSON bundle that loads in any standard Spine runtime — or preview it in the included standalone `runtime.html` player. No account, no server, no upload pipeline: everything stays on your machine.

> Status: early open-source release. The core editor loop works, but some advanced animation-tool features are still in progress. See [Implementation Status](./docs/IMPLEMENTATION_STATUS.md) for the detailed checklist.

---

## Why SpriteForge?

SpriteForge is built for small teams, game jam projects, tool hackers, and anyone who wants a lightweight 2D rigging workflow without starting from a large commercial animation suite.

You can:

- Import images and attach them to bones
- Build a parent/child bone hierarchy
- Pose and animate a character on a timeline
- Edit keyframes, easing, and curve previews
- Save editable `.sfproj` project files
- Export Spine-compatible JSON + atlas + PNG bundles
- Test exported bundles in the included standalone `runtime.html` player

Everything is local-first. Your project and images stay on your machine.

---

## Feature highlights

### Editor workflow

- Browser-native editor powered by TypeScript, Canvas, and WebGL2
- Bone creation, selection, reparenting, root conversion, and deletion
- Edit / Pose / Animate modes
- Timeline with keyframes, copy/paste/duplicate, easing presets, and curve display
- Resizable timeline and resizable curve graph
- Undo / redo with drag transaction coalescing
- Autosave and recent project list using `localStorage`

### Images and meshes

- PNG/JPG image insertion
- TexturePacker-style sprite sheet import
- Mesh attachments with GPU skinning
- Auto-weight recompute
- Mesh subdivision and basic mesh cut foundation
- Show/hide grid, bones, and images from the View menu

### Import/export

- Editable SpriteForge project format: `.sfproj`
- Spine 4.x-style JSON + `.atlas` + PNG export
- Partial Spine bundle import (`.json` + `.atlas` + `.png`)
- Standalone `runtime.html` player for quick runtime checks
- MP4 preview export (H.264 via ffmpeg.wasm)
- Two-bone inverse kinematics (`Shift+K`)

---

## Quick start

Install dependencies and start the local dev server:

```bash
npm install
npm run dev
```

Then open the URL printed in the terminal, usually:

```text
http://localhost:5173
```

Build production bundles:

```bash
npm run build
```

Typecheck:

```bash
npm run typecheck
```

Run the project check script:

```bash
npm run check
```

---

## First steps in the editor

1. Open the editor.
2. Press **B** or choose the Bone tool.
3. Click in the stage to add bones.
4. Insert a PNG/JPG image and bind it to a bone.
5. Move the playhead on the timeline.
6. Pose bones to create keyframes.
7. Save your editable project as `.sfproj`.
8. Export a Spine bundle when you are ready to test in a runtime.

For the full walkthrough, see [docs/TUTORIAL.md](./docs/TUTORIAL.md).

---

## File formats

### Editable project

```text
project.sfproj
```

Use this when you want to keep editing in SpriteForge. It stores the project data and embedded image data.

### Runtime export

```text
project.json
project.atlas
project.png
```

Use this bundle with compatible Spine-style runtimes or with the included `runtime.html` player.

### Preview export

```text
project-preview.mp4
```

MP4 preview export uses ffmpeg.wasm and may take a moment to initialize the first time.

---

## Standalone runtime player

Open:

```text
runtime.html
```

Drop these three files together:

```text
project.json
project.atlas
project.png
```

The runtime exposes a small JavaScript API:

```js
spriteforge.setAnimation("walk", { mix: 0.2 });
spriteforge.pause();
spriteforge.resume();
spriteforge.setCurrentTime(0.5);
```

See [Use the standalone runtime](./docs/TUTORIAL.md#use-the-standalone-runtime) for more detail.

---

## What is still in progress?

SpriteForge is usable today, but it is not yet a full replacement for mature tools such as Spine.

Important areas still being expanded (see the [FSD §11](./docs/FSD.md#11-what-is-planned) for the full list):

- Brush-based weight painting UI
- Full mesh edge split/merge tooling
- Full 9-slice and polygon-outline authoring and rendering
- Full FFD / deform workflow
- Editor UI for animation layers and additive blending
- Multi-bone and path inverse kinematics (two-bone IK is shipped)
- Coverage of the more advanced Spine import tracks (FFD, events, draw order, multiple skins, linked meshes)
- Light mode theme
- Internationalization and accessibility polish

Not on the roadmap: GIF preview export, mobile/touch editor, server features.

See [Implementation Status](./docs/IMPLEMENTATION_STATUS.md) for the current feature-by-feature state.

---

## Project layout

```text
.
├── docs/                     User docs, specification, status notes
├── public/                   CSS and browser runtime assets
├── samples/                  Example projects and Spine bundles
├── scripts/                  Dev server, build, and check scripts
├── src/
│   ├── core/                 Data model, math, FK evaluation, IK helpers
│   ├── editor/               Editor UI, tools, timeline, import/export
│   ├── runtime/              Standalone WebGL runtime player
│   └── shared/               Shared keymap, DOM helpers, build metadata
├── index.html                Editor entry point
├── runtime.html              Standalone runtime entry point
└── package.json
```

---

## Development notes

- Language: TypeScript
- Build tool: esbuild
- UI style: no framework, DOM + Canvas/WebGL
- Rendering: WebGL2
- Project storage: JSON `.sfproj`
- Runtime export: Spine-style JSON + atlas + PNG
- Privacy model: local-first, no telemetry, no uploads

Useful commands:

```bash
npm run dev        # local dev server
npm run build      # production build into dist/
npm run typecheck  # TypeScript typecheck
npm run check      # typecheck + DOM id scan
```

Some verification scripts under `scripts/` use headless Chrome/Chromium. A few older scripts assume a Linux `/usr/bin/chromium` path.

---

## Dependencies

Runtime/editor dependencies:

- `@ffmpeg/ffmpeg`
- `@ffmpeg/core`

Development dependencies:

- TypeScript
- esbuild
- ws
- @types/node

---

## Contributing

Contributions are welcome. Please read:

- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
- [SECURITY.md](./SECURITY.md)

Before starting a large PR, please check [Implementation Status](./docs/IMPLEMENTATION_STATUS.md) and [FSD](./docs/FSD.md) so your work matches the intended project direction.

---

## License

MIT — see [LICENSE](./LICENSE).
