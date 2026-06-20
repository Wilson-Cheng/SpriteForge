// src/core/model.ts
// Project data model — the in-memory representation of a SpriteForge document.
// Mirrors the schema in FSD §7. Kept minimal for P1; later slices add slots,
// meshes, animations, and skins without breaking the existing structure.

export type Id = string;

/** A 2D bone in the rig hierarchy. FK only for P1. */
export interface Bone {
  id: Id;
  name: string;
  parent: Id | null;
  /** Pose position (world, when the bone is unparented). For parented bones
   *  we treat x/y as *local* relative to the parent. */
  x: number;
  y: number;
  /** Degrees. */
  rotation: number;
  /** Uniform-ish scale factors. Non-uniform (sx ≠ sy) is supported and
   *  matches the Spine scale-track shape ({x, y}). Defaults to 1. */
  scaleX: number;
  scaleY: number;
  /** Bone length — used for the visual gizmo and for IK targets later. */
  length: number;
  /** Display color (hex string). */
  color: string;
  /** Visibility toggle (FR-RB-6). Hidden bones are skipped by the
   *  viewport drawing and the skin renderer (the latter hides any
   *  attachment whose bind bone is hidden). Defaults to `true`; older
   *  projects loaded without this field are coerced to visible by
   *  save-load.ts. */
  visible?: boolean;
  /** Spine inheritance mode. P1 only uses "normal" (the default, all
   *  transforms inherited from parent) and "noRotationOrReflection"
   *  (Spine 4.x: rotation / scale / reflection NOT inherited from
   *  parent — only the position offset is). Used by the foot and
   *  weapon bones in the official hero example so the foot stays
   *  world-aligned when the shin rotates. Older projects without
   *  this field default to "normal". */
  inherit?: "normal" | "noRotationOrReflection";
}

/** A single vertex on a mesh. The four bone influences are summed to 1.0
 *  by the skinning code (weights are normalized at attachment time). */
export interface Vertex {
  /** Bind position, in stage world units. */
  x: number;
  y: number;
  /** Up to 4 bone indices into Project.bones. Indices are local to the
   *  attachment (see MeshAttachment.boneRefs). */
  bones: [Id, Id, Id, Id];
  /** Per-vertex weights for the 4 bones. Sum to 1.0. */
  weights: [number, number, number, number];
}

/** A triangle, indices into the mesh's vertex array. */
export interface Triangle {
  a: number;
  b: number;
  c: number;
}

/** A mesh + an image, attached to a bone. The mesh is always parented
 *  to ONE root bone (its `boneRefs[0]`); the remaining slots in each
 *  vertex's `bones` tuple are *deform* influences — the parent bone
 *  becomes the bind origin, and the deform bones warp the mesh
 *  relative to it.
 *
 *  As of P2.5.a, the vertex / triangle counts are **variable**. P1
 *  shipped quad-only attachments (4 verts, 2 tris) and the types were
 *  TS tuples; that hardcoded the deformation grid to a single quad,
 *  which made FR-MS-5 (mesh edge split / merge) impossible without a
 *  refactor. The relaxed shape lets `subdivideMeshAttachment` insert
 *  midpoint vertices and lets Spine importers bring in N-vertex meshes
 *  natively. The skin renderer + spine exporter now read
 *  `vertices.length` instead of trusting `4`. */
export interface MeshAttachment {
  id: Id;
  name: string;
  /** PNG/JPG image data, embedded as a data URL. P1 keeps it inline. */
  imageDataUrl: string;
  /** Image pixel dimensions, captured at load time. */
  imageWidth: number;
  imageHeight: number;
  /** Vertices in stage world units, before skinning. The first 4 are
   *  the quad corners in BL → BR → TR → TL order; subsequent vertices
   *  (added by subdivide / mesh edge split) are interior or edge
   *  points. */
  vertices: Vertex[];
  /** Triangles forming the mesh (CCW winding). Length is always at
   *  least 2 (the bind quad). */
  triangles: Triangle[];
  /** Per-vertex UVs in [0, 1] image space, paired with `vertices` by
   *  index. Optional for backward compat: when absent, the renderer
   *  falls back to the legacy quad mapping (BL=(0,1), BR=(1,1),
   *  TR=(1,0), TL=(0,0)) so older `.sfproj` files keep working. */
  uvs?: Array<{ u: number; v: number }>;
  /** Bone id used as the *bind origin* (vertex positions are stored in
   *  this bone's local space). Always one of `boneRefs`. */
  bindBone: Id;
  /** All bones that influence this mesh. Indices into Project.bones.
   *  vertex.bones entries are local indices into this array. */
  boneRefs: Id[];
  /** 9-slice insets (FR-AI-4 — P2.5.d). When set, the renderer treats
   *  the attachment as a stretchable 9-patch: corner regions stay
   *  fixed, edge regions stretch in one axis, the center stretches
   *  in both. Values are in image pixels measured from the
   *  corresponding edge. Data-model only as of P2.5.d; renderer
   *  support is queued behind a wider deformation pass. */
  nineSlice?: {
    left: number;
    right: number;
    top: number;
    bottom: number;
  };
  /** Polygon outline (FR-AI-4 — P2.5.d). Used for tight atlas region
   *  fitting at export time: when present, the atlas packer can
   *  shrink the region to this polygon's bounding box and the runtime
   *  treats anything outside the polygon as transparent. Stored as
   *  flattened [x, y, x, y, ...] in image pixels. Data-model only as
   *  of P2.5.d. */
  outlinePoints?: number[];
}

/** A draw-order slot — for P1 we only have one mesh per project, so this
 *  is just an ordered list of attachment ids. P2 will generalize. */
export interface Slot {
  id: Id;
  name: string;
  /** Attachment id, or null to hide. */
  attachment: Id | null;
  /** Bone that this slot follows (its transform is applied on top). */
  bone: Id;
  /** Per-slot tint applied as `texColor * tint` in the shader (FR-SA-5
   *  — P2.D). 6- or 8-char hex (`#RRGGBB` or `#RRGGBBAA`). When omitted
   *  / "#ffffff" / "#ffffffff" the multiplication is a no-op so older
   *  projects render identically. */
  tint?: string;
  /** Alternative attachments available on this slot (FR-SA-4 — P2.D).
   *  The active attachment id is `attachment`; an animation track of
   *  property `"attachment"` can swap to any id in `alts` (or back to
   *  `attachment`) at a given keyframe time. The list does NOT include
   *  the default `attachment`; the runtime treats it as the implicit
   *  bind value. */
  alts?: Id[];
}

/** A single keyframe for a bone property. P1 supports translate (x,y) and
 *  rotation only. The `value` shape depends on the property:
 *  - `translate`: { x, y }
 *  - `rotation`: number (degrees, additive on top of bone.local rotation)
 *  - `scale`:    { x, y } (P3)
 *  - `color`:    string  (P2) */
export interface Keyframe {
  /** Time in seconds from the start of the animation. */
  time: number;
  /** Property value — shape depends on the property. */
  value: number | { x: number; y: number } | string;
  /** Interpolation between this keyframe and the NEXT one. `linear` and
   *  `stepped` ignore the control points. `bezier` uses the four
   *  control-point fields below (CSS-style cubic-bezier).
   *  Spine 4.1 stores the same control points in its JSON. */
  curve: "linear" | "stepped" | "bezier";
  /** Cubic-bezier control point 1, x in [0, 1]. y may exceed [0, 1] for
   *  overshoot. Unused unless curve === "bezier". */
  cp1x?: number;
  cp1y?: number;
  /** Cubic-bezier control point 2. */
  cp2x?: number;
  cp2y?: number;
}

/** Named preset curves — convenient for the UI and for round-tripping
 *  Spine JSON. Each preset expands to a `(cp1x, cp1y, cp2x, cp2y)` tuple
 *  applied to a keyframe's outgoing interpolation. The "linear" and
 *  "stepped" presets don't use control points; the others all set
 *  `curve: "bezier"` with the given control points. */
export type EasingPreset =
  | "linear"
  | "stepped"
  | "easeIn"
  | "easeOut"
  | "easeInOut";

export const EASING_PRESETS: Record<EasingPreset, { curve: Keyframe["curve"]; cp1x: number; cp1y: number; cp2x: number; cp2y: number }> = {
  linear:     { curve: "linear",  cp1x: 0,    cp1y: 0,    cp2x: 1,    cp2y: 1    },
  stepped:    { curve: "stepped", cp1x: 0,    cp1y: 0,    cp2x: 1,    cp2y: 1    },
  // CSS "ease-in" = cubic-bezier(0.42, 0, 1, 1)
  easeIn:     { curve: "bezier",  cp1x: 0.42, cp1y: 0,    cp2x: 1,    cp2y: 1    },
  // CSS "ease-out" = cubic-bezier(0, 0, 0.58, 1)
  easeOut:    { curve: "bezier",  cp1x: 0,    cp1y: 0,    cp2x: 0.58, cp2y: 1    },
  // CSS "ease-in-out" = cubic-bezier(0.42, 0, 0.58, 1)
  easeInOut:  { curve: "bezier",  cp1x: 0.42, cp1y: 0,    cp2x: 0.58, cp2y: 1    },
};

/** A track animates a single property of a single target (bone or slot).
 *  Spine's data model uses one track per (target, property) pair.
 *
 *  As of P2.5.b the Track type covers BOTH bone tracks (the original
 *  P1 case) and slot tracks (new for FR-SA-4 — keyframed attachment
 *  swap). Slot tracks set `slotId` and use property === "attachment"
 *  (value: attachment id string, or null to hide) or "color" (value:
 *  RRGGBBAA string). Bone tracks set `boneId` and keep the existing
 *  "translate" | "rotation" | "scale" properties. The `kind` field is
 *  the discriminant; older `.sfproj` files that lack `kind` are
 *  treated as bone tracks (`save-load` migration adds it on load). */
export interface Track {
  /** Discriminant. Defaults to "bone" when missing for back-compat. */
  kind?: "bone" | "slot";
  /** Bone target — required when kind === "bone" (or absent). */
  boneId?: Id;
  /** Slot target — required when kind === "slot". */
  slotId?: Id;
  /** Which property this track animates. */
  property: "translate" | "rotation" | "scale" | "attachment" | "color" | "deform";
  /** Animation layer index (FR-TA-8 — P3). Layer 0 is the base track;
   *  higher layers may be additive. */
  layer?: number;
  /** Additive layer flag (FR-TA-8 — P3). When true, translate/rotation
   *  values add on top of the lower-layer sampled value instead of
   *  replacing it. */
  additive?: boolean;
  /** Keyframes sorted by `time` (insertion order — the playback code
   *  relies on this; new keyframes are inserted in the right place). */
  keyframes: Keyframe[];
}

/** A named animation. P1 has one default animation ("idle") pre-seeded.
 *  Later slices add the ability to add/rename/switch between multiple
 *  animations in the project. */
export interface Animation {
  id: Id;
  name: string;
  /** Total duration in seconds. The last keyframe's `time` should be ≤
   *  duration; we allow small overshoot but warn at > 1.0s past. */
  duration: number;
  /** Whether the playback loops back to 0 when reaching `duration`. */
  looping: boolean;
  /** Per-(bone, property) keyframe tracks. */
  tracks: Track[];
}

export interface IkConstraint {
  id: Id;
  name: string;
  /** The child/end-effector bone in a two-bone chain. The parent of
   *  this bone is the "upper" bone. */
  targetBone: Id;
  /** Target point in world/stage space. */
  target: { x: number; y: number };
  /** Bend direction. 1 = clockwise-ish, -1 = counter-clockwise-ish. */
  bend: 1 | -1;
  /** Mix in [0,1]. 1 = full IK, 0 = no effect. */
  mix: number;
}

export interface Project {
  /** Schema version. Bump when shape changes. */
  version: number;
  name: string;
  /** Stage dimensions, in world units. FSD default 512x512. */
  width: number;
  height: number;
  /** Playback FPS. FSD default 30. */
  fps: number;
  /** Background color of the stage. */
  background: string;
  bones: Record<Id, Bone>;
  /** Insertion-order list of bone ids (record preserves order in JS but
   *  we keep an explicit list for export stability). */
  boneOrder: Id[];
  rootIds: Id[];   // bones with parent === null, in display order
  attachments: Record<Id, MeshAttachment>;
  attachmentOrder: Id[];
  slots: Record<Id, Slot>;
  slotOrder: Id[];
  /** Two-bone IK constraints (P3). Kept separate from animations; the
   *  solver applies them after FK sampling and before skin rendering. */
  ik: Record<Id, IkConstraint>;
  ikOrder: Id[];
  /** Named animations. P1 ships with one default ("idle"). */
  animations: Record<Id, Animation>;
  animationOrder: Id[];
  /** Which animation is currently active for editing / playback. */
  activeAnimationId: Id;
}

export const CURRENT_PROJECT_VERSION = 4;

/** Default palette for new bones — cycles through these as the user adds them. */
export const BONE_PALETTE = [
  "#5b9cff",  // blue
  "#ff8a5b",  // orange
  "#7be39a",  // green
  "#f0d35b",  // yellow
  "#cf6bff",  // purple
  "#ff6b9a",  // pink
] as const;

/** Generate a short random id. Not cryptographically strong — just unique
 *  within a single project. Format: 6 lowercase alphanumerics. */
export function newId(): Id {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += a[Math.floor(Math.random() * a.length)];
  return out;
}

/** A safe, project-unique name. If `base` is taken, append "-2", "-3", etc. */
export function uniqueName(project: Project, base: string, excludeId?: Id): string {
  const taken = new Set<string>();
  for (const id of project.boneOrder) {
    if (id === excludeId) continue;
    const b = project.bones[id];
    if (b) taken.add(b.name);
  }
  for (const id of project.attachmentOrder) {
    const a = project.attachments[id];
    if (a && a.id !== excludeId) taken.add(a.name);
  }
  for (const id of project.slotOrder) {
    const s = project.slots[id];
    if (s && s.id !== excludeId) taken.add(s.name);
  }
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const cand = `${base}-${i}`;
    if (!taken.has(cand)) return cand;
  }
  return `${base}-${Date.now()}`;
}

/** Build an empty project with sensible defaults. */
export function createDefaultProject(name = "untitled"): Project {
  const animId = newId();
  return {
    version: CURRENT_PROJECT_VERSION,
    name,
    width: 512,
    height: 512,
    fps: 30,
    background: "#2a2f3a",
    bones: {},
    boneOrder: [],
    rootIds: [],
    attachments: {},
    attachmentOrder: [],
    slots: {},
    slotOrder: [],
    ik: {},
    ikOrder: [],
    animations: {
      [animId]: {
        id: animId,
        name: "idle",
        duration: 1.0,
        looping: true,
        tracks: [],
      },
    },
    animationOrder: [animId],
    activeAnimationId: animId,
  };
}
