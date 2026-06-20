// src/runtime/spine-types.ts
// Type definitions for the Spine 4.1 JSON format. We only define the
// subset we use, plus a few fields Spine can add that we ignore
// gracefully.

export interface SpineJson {
  skeleton: { hash: string; spine: string; x?: number; y?: number; width?: number; height?: number };
  /** Spine 4.1 puts width/height at the top level; Spine 4.x sometimes
   *  only puts them inside `skeleton`. Either is accepted at load time. */
  width?: number;
  height?: number;
  fps?: number;
  images?: string;
  audio?: string;
  bones: SpineBone[];
  slots: SpineSlot[];
  /** Skins can be an object map (Spine 4.1 editor export) or an array
   *  of `{ name, attachments }` records (the official Spine editor and
   *  the `samples/hero.json` sample). The runtime normalises both
   *  forms into the same nested object. */
  skins: { [skinName: string]: { [slotName: string]: { [attachmentName: string]: SpineAttachment } } } | Array<{ name: string; attachments?: { [slotName: string]: { [attachmentName: string]: SpineAttachment } } }>;
  meshes?: SpineMeshEntry[];
  animations?: { [animName: string]: SpineAnimation };
  events?: { [name: string]: unknown };
}

export interface SpineBone {
  name: string;
  parent?: string;
  length?: number;
  x?: number;
  y?: number;
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  shearX?: number;
  shearY?: number;
  color?: string;
  transform?: string;
  skin?: boolean;
  /** Spine inheritance mode. `"noRotationOrReflection"` (used by the
   *  official `hero` sample's foot bones) means the bone keeps its
   *  own rotation/scale and does NOT inherit them from the parent
   *  — only the parent's position is inherited. The runtime models
   *  the three documented values: "normal" (everything inherited —
   *  the default), "noRotationOrReflection", and "noScaleOrReflection". */
  inherit?: "normal" | "noRotationOrReflection" | "noScaleOrReflection" | "onlyTranslation";
}

export interface SpineSlot {
  name: string;
  bone: string;
  color?: string;
  dark?: string;
  attachment?: string;
  blend?: string;
}

export type SpineAttachment =
  | SpineMeshAttachment
  | SpineRegionAttachment
  | SpineBoundingBoxAttachment
  | SpinePathAttachment;

export interface SpineMeshAttachment {
  type: "mesh";
  name: string;
  parent: string;
  width: number;
  height: number;
  vertices: number[];
  uvs: number[];
  triangles: number[];
  edges?: number[];
  hull?: number;
  color?: string;
}

export interface SpineRegionAttachment {
  type?: "region";
  name: string;
  x?: number;
  y?: number;
  scaleX?: number;
  scaleY?: number;
  rotation?: number;
  width?: number;
  height?: number;
  color?: string;
  /** Spine attaches the atlas region by `path` if set, else by `name`. */
  path?: string;
}

export interface SpineBoundingBoxAttachment {
  type: "boundingbox";
  name: string;
  vertexCount: number;
  vertices: number[];
  color?: string;
}

export interface SpinePathAttachment {
  type: "path";
  name: string;
  closed: boolean;
  constantSpeed: boolean;
  vertexCount: number;
  vertices: number[];
  lengths: number[];
  color?: string;
}

export interface SpineMeshEntry {
  name: string;
  parent?: string;
  bones: string[];
  vertices: number[];
  hull?: number;
  edges?: number[];
  width?: number;
  height?: number;
  color?: string;
}

export type Curve = "linear" | "stepped" | number[];

export interface SpineTranslateKey { time: number; x: number; y: number; curve?: Curve; }
export interface SpineRotateKey    { time: number; angle: number; curve?: Curve; }
export interface SpineScaleKey     { time: number; x: number; y: number; curve?: Curve; }
export interface SpineShearKey     { time: number; x: number; y: number; curve?: Curve; }

export interface SpineAnimation {
  bones?: { [boneName: string]: {
    translate?: SpineTranslateKey[];
    rotate?: SpineRotateKey[];
    scale?: SpineScaleKey[];
    shear?: SpineShearKey[];
  } };
  slots?: { [slotName: string]: {
    attachment?: Array<{ time: number; name: string | null }>;
    color?: Array<{ time: number; color: string; curve?: Curve }>;
  } };
  events?: { [name: string]: Array<{ time: number; int?: number; float?: number; string?: string; volume?: number; balance?: number }> };
  draworder?: Array<{ time: number; offsets: Array<{ slot: string; offset: number }> }>;
}

export interface Atlas {
  pages: AtlasPage[];
  regions: AtlasRegion[];
  texture?: WebGLTexture;
}

export interface AtlasPage {
  name: string;
  size: { w: number; h: number };
}

export interface AtlasRegion {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotate?: boolean;
  index?: number;
}
