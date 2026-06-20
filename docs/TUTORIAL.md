# SpriteForge Tutorial and User Guide

This guide is written for new users who want to create, animate, save, export, import, and use SpriteForge characters in a game.

SpriteForge is a browser-based 2D skeletal sprite animation editor. It is inspired by Spine-style workflows: you import images, create bones, bind images to bones, keyframe animation, then export a Spine-compatible JSON/atlas bundle or a standalone web runtime.

> Current status: see [Implementation Status](./IMPLEMENTATION_STATUS.md). Most core workflows are available, but some advanced features are still partial.

---

## Table of contents

1. [Start the app](#start-the-app)
2. [Editor layout](#editor-layout)
3. [Keyboard shortcuts](#keyboard-shortcuts)
4. [Build a simple sprite](#build-a-simple-sprite)
5. [Animate a sprite with images](#animate-a-sprite-with-images)
6. [Save, load, autosave, and recent files](#save-load-autosave-and-recent-files)
7. [Export Spine files](#export-spine-files)
8. [Export MP4 preview video](#export-mp4-preview-video)
9. [Import a sprite sheet](#import-a-sprite-sheet)
10. [Open Spine JSON files from the internet](#open-spine-json-files-from-the-internet)
11. [Convert SpriteForge output to other formats](#convert-spriteforge-output-to-other-formats)
12. [Use exported sprites in game engines](#use-exported-sprites-in-game-engines)
13. [Use the standalone runtime](#use-the-standalone-runtime)
14. [Troubleshooting](#troubleshooting)
15. [Recommended workflow](#recommended-workflow)

---

## Start the app

### From source

```bash
npm install
npm run dev
```

Open the printed local URL, usually:

```text
http://localhost:5173
```

### Production build

```bash
npm run build
```

This produces minified JavaScript in `dist/`.

Because SpriteForge is fully static, it can be hosted by any static web server.

---

## Editor layout

SpriteForge has four main regions:

```text
┌───────────────────────────────────────────────────────────┐
│ Title bar                                                  │
├──────────────┬───────────────────────────────┬────────────┤
│ Left tools   │ Viewport / canvas             │ Right pane │
│              │                               │ Hierarchy  │
│              │                               │ Inspector  │
├──────────────┴───────────────────────────────┴────────────┤
│ Timeline + graph editor                                    │
└───────────────────────────────────────────────────────────┘
```

### Left sidebar

Contains common tools and file actions:

- **Select** — select/move bones and attachments
- **Bone** — create bones
- **Child** — create a child bone under the selected bone
- **Root** — make the selected bone a root bone
- **New** — create a new project
- **Save** — save `.sfproj`
- **Open** — open `.sfproj`
- **Insert** — insert a PNG/JPG as an attachment
- **Spine** — import a Spine 4.1 bundle (`.json` + `.atlas` + `.png`)
- **Export** — export Spine JSON + atlas + PNG
- **MP4** — export MP4 preview of the active animation

### Viewport

The center canvas shows:

- The stage background
- Sprite images / meshes
- Bones
- Selection handles
- Grid

You can zoom, pan, select sprites, select bones, and preview animation.

### Right pane

Contains:

- **Hierarchy** — bone tree and attachment list
- **Inspector** — selected bone values and attached images

### Timeline

Contains:

- Playback controls
- Animation selector
- Auto-key toggle
- Timeline tracks
- Keyframe diamonds
- Bezier graph preview

---

## Keyboard shortcuts

Open the in-app help with `?`.

Common shortcuts:

| Shortcut | Action |
| --- | --- |
| `V` | Select tool |
| `B` | Bone tool |
| `N` | Add child bone |
| `1` | Edit mode |
| `2` | Pose mode |
| `3` | Animate mode |
| `Space` | Play / pause |
| `S` | Stop and rewind |
| `K` | Add keyframe |
| `Cmd/Ctrl+N` | New project |
| `Cmd/Ctrl+S` | Save project |
| `Cmd/Ctrl+O` | Open project |
| `Cmd/Ctrl+I` | Insert image |
| `Cmd/Ctrl+Z` | Undo |
| `Cmd/Ctrl+Shift+Z` | Redo |
| `F` | Frame all |
| `Shift+F` | Frame selection |
| `Shift+G` | Toggle grid |
| `.` | Step forward one frame |
| `,` | Step backward one frame |
| `Shift+.` | Increase playback speed |
| `Shift+,` | Decrease playback speed |
| `Shift+O` | Toggle onion skin |
| `Shift+W` | Recompute mesh auto-weights |
| `Shift+U` | Subdivide selected mesh |
| `Shift+X` | Cut selected mesh |
| `Shift+K` | Create two-bone IK on selected child bone |

---

## Build a simple sprite

This is the simplest possible workflow: one image, one root bone, one animation.

### 1. Create a new project

Click **New** in the left sidebar or press `Cmd/Ctrl+N`.

If you have unsaved work, SpriteForge asks for confirmation before clearing the project.

### 2. Create a root bone

1. Select the **Bone** tool (`B`).
2. Click in the viewport near the center of the stage.
3. A bone appears.
4. The bone is selected automatically.

You can also use the default sample rig when the app first opens.

### 3. Insert an image

Use one of these methods:

- Click **Insert** in the left sidebar
- Press `Cmd/Ctrl+I`
- Drag a PNG/JPG onto the viewport

If exactly one bone is selected, the image binds to that bone.

If no bone exists, SpriteForge creates a default root bone and binds the image to it.

### 4. Select and move the sprite

SpriteForge follows a bone-based workflow:

- Images are attached to bones.
- You move the bone to move the image.
- Clicking the image selects its bind bone.

So if an image appears but you cannot drag it directly, click the image first. The bind bone becomes selected, then drag the bone.

### 5. Check the Inspector

Select the bone. The Inspector shows:

- Name
- Local X/Y
- Rotation
- Length
- World position
- Parent
- Children
- Attachments bound to the bone

The attachment section has a thumbnail and a delete button.

---

## Animate a sprite with images

SpriteForge has three modes:

| Mode | Shortcut | Meaning |
| --- | --- | --- |
| Edit | `1` | Edit bind pose and rig structure. No animation keyframes are created. |
| Pose | `2` | Try a temporary pose. Leaving Pose restores the previous transforms. |
| Animate | `3` | Moving bones records keyframes at the playhead when auto-key is on. |

### 1. Switch to Animate mode

Press `3` or use the mode controls if available.

Make sure **auto-key** is enabled in the timeline toolbar.

### 2. Set the playhead to frame 0

Click the timeline near `0.00` or press Stop (`S`) to rewind.

### 3. Pose the sprite

Select a bone or click an image to select its bind bone.

Move or rotate the bone. With auto-key enabled, SpriteForge records a keyframe.

You can also press `K` to manually keyframe selected bones.

### 4. Move to another time

Scrub the timeline to another time, for example `0.5s`.

Move or rotate the bone again. A second keyframe is created.

### 5. Play the animation

Press `Space`.

Use:

- `.` to step forward one frame
- `,` to step backward one frame
- `Shift+.` / `Shift+,` to change speed
- `Shift+O` to toggle onion skinning

### 6. Edit easing

Select a keyframe and open its easing popover. You can choose:

- Linear
- Stepped
- Ease in
- Ease out
- Ease in/out
- Custom cubic bezier handles

The graph panel below the toolbar shows selected curves across the animation.

---

## Save, load, autosave, and recent files

### Save `.sfproj`

Click **Save** or press `Cmd/Ctrl+S`.

This downloads a `.sfproj` file.

`.sfproj` is SpriteForge's editable project format. Use it when you want to keep working on a project later.

### Load `.sfproj`

Click **Open** or press `Cmd/Ctrl+O`, then pick a `.sfproj` file.

You can also drag a `.sfproj` file onto the viewport.

### Autosave

SpriteForge autosaves to `localStorage` every 30 seconds.

If the browser tab crashes or is closed, SpriteForge asks whether to restore the autosave next time.

Autosave is local to your browser. It is not uploaded.

### Recent files

SpriteForge keeps an informational recent-files list. Browsers do not allow web apps to reopen arbitrary local files by path, so the list helps you identify recent filenames, then you still pick the file manually.

---

## Export Spine files

Click **Export** in the left sidebar.

SpriteForge downloads:

```text
<project>.json
<project>.atlas
<project>.png
```

These are the normal files used by Spine-compatible game runtimes.

### What each file is

| File | Purpose |
| --- | --- |
| `.json` | Spine 4.x skeleton, slots, skins, meshes, animations |
| `.atlas` | Texture atlas metadata |
| `.png` | Texture atlas image |

### Can these files be used in a game engine?

Yes. The exported `.json + .atlas + .png` bundle is the intended runtime format for engines that support Spine data.

Do **not** expect the Esoteric Spine editor's project files — SpriteForge works with the JSON + atlas runtime interchange format only.

---

## Export MP4 preview video

SpriteForge can export a short MP4 preview of the active animation.

### MP4

Click **MP4** in the left sidebar, or use **File → Export MP4 preview**.

The MP4 exporter captures frames from the editor's WebGL preview and encodes them with [`@ffmpeg/ffmpeg`](https://github.com/ffmpegwasm/ffmpeg.wasm) (H.264, `libx264`, `yuv420p`, `faststart`).

The ffmpeg wasm bundle is large, so the **first** MP4 export is slow while it loads. Subsequent exports in the same session are much faster. There is no GIF export.

If the encoder fails, the failure message includes the ffmpeg log tail to help you diagnose the issue.

### Preview export limitations

Preview export captures the clean sprite animation from the WebGL preview. It intentionally does not include editor gizmos, panels, or bone overlays.

---

## Import a sprite sheet

SpriteForge supports sprite-sheet import in two ways.

### TexturePacker JSON

Drag these files into the viewport together:

```text
sheet.png
sheet.json
```

Supported JSON shapes:

- TexturePacker JSON Hash
- TexturePacker JSON Array

SpriteForge slices the sheet and creates one attachment per frame.

### Grid metadata

The internal importer supports grid metadata too, but the UI is currently focused on JSON-based import. Future UI can expose columns/rows directly.

---

## Open Spine JSON files from the internet

Many free/paid game art packs include Spine exports.

Usually you need three files:

```text
character.json
character.atlas
character.png
```

Drag all three into the viewport together.

SpriteForge imports a **partial** version of the Spine project.

### Supported import data

- Bones
- Slots
- Default skin
- Region attachments
- Mesh attachments
- Translate/rotate/scale animation tracks
- Slot attachment/color animation tracks

### Dropped with warnings

- IK constraints
- Transform/path constraints
- Multiple skins beyond `default`
- FFD/deform tracks
- Events
- Draw-order timelines
- Linked meshes
- Some weighted mesh data is coerced to simpler single-bone binding

The import is designed to get common FK Spine characters editable, not to perfectly round-trip every advanced Spine project.

---

## Convert SpriteForge output to other formats

SpriteForge's main export format is Spine JSON + atlas.

From there, you can convert/use the asset in several ways.

### To game engines

Use the engine's Spine runtime or plugin. See [Use exported sprites in game engines](#use-exported-sprites-in-game-engines).

### To MP4

Use SpriteForge's **MP4** preview button (File → Export MP4 preview). GIF export is not supported.

### To PNG frame sequence

SpriteForge does not currently expose a PNG-sequence button, but internally preview export captures frames. This is a good future export target if you want maximum compatibility.

### To DragonBones / other skeletal formats

Not implemented. A converter would need a dedicated mapping layer because each tool has different concepts for bones, slots, skins, meshes, constraints, and timelines.

---

## Use exported sprites in game engines

After export, you have:

```text
character.json
character.atlas
character.png
```

Use these with a Spine-compatible runtime.

### Phaser

Use the official Spine Phaser runtime/plugin from Esoteric.

Conceptually:

```js
this.load.spineJson('hero-json', 'character.json');
this.load.spineAtlas('hero-atlas', 'character.atlas');

// later, after preload:
const hero = this.add.spine(400, 300, 'hero-json', 'hero-atlas');
hero.animationState.setAnimation(0, 'idle', true);
```

Exact API depends on the Spine Phaser package version.

### PixiJS

Use the official Spine Pixi runtime.

Conceptually:

```js
// Load .json, .atlas, and .png through your asset loader.
// Create a Spine object from the loaded skeleton data.
// Then:
spine.state.setAnimation(0, 'idle', true);
```

### Unity

Use `spine-unity`.

Import the JSON, atlas, and PNG into the Unity project using Spine's Unity import pipeline.

### Godot

Use the Spine Godot runtime/addon. Import the JSON, atlas, and PNG according to that addon.

### Custom engine

Use SpriteForge's standalone runtime as a reference implementation.

---

## Use the standalone runtime

SpriteForge includes `runtime.html`, a minimal WebGL player.

### Run it locally

Start the dev server:

```bash
npm run dev
```

Open:

```text
http://localhost:5173/runtime.html
```

Drag these three files onto the page:

```text
character.json
character.atlas
character.png
```

The runtime loads and plays the first animation.

### Runtime JavaScript API

After loading a bundle, the runtime exposes:

```js
window.spriteforge.setAnimation('walk', { mix: 0.2 });
window.spriteforge.pause();
window.spriteforge.resume();
window.spriteforge.setCurrentTime(0.5);
window.spriteforge.getActiveAnimation();
window.spriteforge.getCurrentTime();
```

Example:

```js
spriteforge.setAnimation('idle');

// Crossfade to walk over 0.2 seconds:
spriteforge.setAnimation('walk', { mix: 0.2 });
```

### Embedding idea

You can copy the runtime code into your game or use it as a reference for loading exported Spine JSON + atlas + PNG in WebGL.

---

## Troubleshooting

### I inserted an image but cannot drag it

Click the image. SpriteForge selects the image's bind bone. Drag the bone to move the image.

### I inserted an image and it does not appear

Try:

1. Press `F` to frame all.
2. Check that a bone exists.
3. Select the bone and check the Inspector attachment list.
4. Make sure the bone is visible in the hierarchy.

This was a known bug after clearing seed bones and has been fixed.

### My Spine JSON import loses features

SpriteForge currently imports common FK projects. It drops advanced Spine features such as IK constraints, multiple skins, events, draw order, and FFD. Warnings are printed in the console.

### MP4 export does not work

The first export in a session downloads and initializes the ffmpeg.wasm bundle; this can take a few seconds to a minute on a slow connection. If the actual encoding step fails, the failure message includes the ffmpeg log tail. There is no GIF fallback.

### Exported JSON does not load in my engine

Check:

- The engine supports Spine 4.x JSON.
- The `.json`, `.atlas`, and `.png` filenames match.
- The atlas file references the correct PNG filename.
- You exported all three files together.

---

## Recommended workflow

For a small game character:

1. Create a new project.
2. Add a root bone.
3. Add child bones for torso, head, arms, and legs.
4. Insert body-part PNGs.
5. Click each image to select its bind bone and position the bones.
6. Use Edit mode for bind pose.
7. Switch to Animate mode.
8. Set keyframes on the timeline.
9. Preview with play / scrub / onion skin.
10. Save `.sfproj` often.
11. Export Spine JSON + atlas + PNG.
12. Test the export in `runtime.html`.
13. Integrate the export into your game engine.

---

## What to read next

- [README](../README.md) — project overview and development setup
- [Implementation Status](./IMPLEMENTATION_STATUS.md) — exact FSD coverage
- [Functional Specification](./FSD.md) — original feature plan
