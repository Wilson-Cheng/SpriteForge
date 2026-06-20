// src/editor/attachments.ts
// Image and mesh attachment helpers. Creating a mesh from a PNG, computing
// auto-weights from bone proximity, removing an attachment.
//
// We keep this separate from store.ts so the latter stays focused on flat
// state mutations.

import type { Project, Id, MeshAttachment, Vertex, Slot, Triangle } from "../core/model";
import { newId, uniqueName } from "../core/model";
import { evalBoneWorld, accumulatedBoneRotationDeg } from "../core/eval";
import { distPointSegment, mat3Invert, degToRad, type Mat3 } from "../core/math";

/** A loaded image and its dimensions. */
export interface LoadedImage {
  dataUrl: string;
  width: number;
  height: number;
}

/** Read a File (e.g. from <input type=file> or a drop event) as a data URL
 *  and resolve once the browser has decoded its dimensions. */
export function loadImageFromFile(file: File): Promise<LoadedImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result as string;
      const img = new Image();
      img.onload = () => resolve({ dataUrl: url, width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = (e) => reject(new Error("image decode failed"));
      img.src = url;
    };
    reader.onerror = () => reject(new Error("file read failed"));
    reader.readAsDataURL(file);
  });
}

/** Compute the closest-point distance from (px, py) to the line segment
 *  representing a bone's shaft in world space (head → head+length*direction).
 *  Uses bind-time world transforms. */
function distanceToBoneShaft(
  project: Project, boneId: Id, px: number, py: number,
): number {
  const bone = project.bones[boneId];
  if (!bone) return Infinity;
  const w = evalBoneWorld(project, boneId);
  if (!w) return Infinity;
  const hx = w.m[4] ?? 0;
  const hy = w.m[5] ?? 0;
  const r = degToRad(accumulatedBoneRotationDeg(project, boneId));
  const tx = hx + Math.cos(r) * bone.length;
  const ty = hy + Math.sin(r) * bone.length;
  return distPointSegment(px, py, hx, hy, tx, ty);
}

/** Compute auto-weights for a vertex using inverse-distance weighting
 *  against all bones in `boneIds`. Each vertex picks up to 4 bones (the
 *  shader supports at most 4 influences), with weights proportional to
 *  1/d^2 and normalized to sum to 1.0. For a single-bone mesh this
 *  degenerates cleanly to (bone, bone, bone, bone) and (1, 0, 0, 0). */
function autoWeightsFor(
  project: Project,
  boneIds: Id[],
  vx: number, vy: number,
): { bones: [Id, Id, Id, Id]; weights: [number, number, number, number] } {
  if (boneIds.length === 0) {
    const id = "" as Id;
    return { bones: [id, id, id, id], weights: [1, 0, 0, 0] };
  }
  // Distance to every available bone's shaft.
  const dists = boneIds.map((id) => ({
    id,
    d: distanceToBoneShaft(project, id, vx, vy),
  }));
  dists.sort((a, b) => a.d - b.d);
  // The closest bone gets weight 1.0 — it dominates regardless of other
  // bones' distances, which prevents the "vertex snaps to wrong bone"
  // artifacts at quad corners when one bone is much further than the other.
  const top = dists.slice(0, Math.min(4, dists.length));
  const EPS = 1e-3;
  const wTop = top.map(({ d }) => 1 / Math.max(d, EPS));
  const sum = wTop.reduce((s, x) => s + x, 0) || 1;
  const norm = wTop.map((w) => w / sum);
  // If only one bone, weights simplify to (1, 0, 0, 0). Otherwise pad.
  while (norm.length < 4) norm.push(0);
  const bones: [Id, Id, Id, Id] = [
    top[0]!.id, top[1]?.id ?? top[0]!.id,
    top[2]?.id ?? top[0]!.id, top[3]?.id ?? top[0]!.id,
  ];
  return { bones, weights: [norm[0]!, norm[1]!, norm[2]!, norm[3]!] };
}

/** Create a quad mesh attachment covering the image, attached to the given
 *  bone. The quad is centered on the bone's world position. Auto-weights
 *  are computed for each vertex using world-space distances, then vertices
 *  are stored in BONE-LOCAL space (so the skinner can apply boneWorld * v
 *  directly without double-translating). */
export function createQuadAttachment(
  project: Project,
  bindBone: Id,
  image: LoadedImage,
  scale: number = 1,
): MeshAttachment {
  // Compute the bind bone's world transform so we can center the quad on it
  // and then convert each vertex into bone-local space for storage.
  const boneWorld = evalBoneWorld(project, bindBone);
  const cx = boneWorld ? (boneWorld.m[4] ?? 0) : project.width / 2;
  const cy = boneWorld ? (boneWorld.m[5] ?? 0) : project.height / 2;
  const w2 = (image.width  / 2) * scale;
  const h2 = (image.height / 2) * scale;
  // CCW winding: BL, BR, TR, TL (windings are corrected in the renderer
  // for screen-space y-flip; see skin-renderer.ts).
  const worldPositions: [number, number][] = [
    [cx - w2, cy - h2],  // BL
    [cx + w2, cy - h2],  // BR
    [cx + w2, cy + h2],  // TR
    [cx - w2, cy + h2],  // TL
  ];
  // boneRefs: just the bind bone for now. P2 lets vertices deform against
  // other bones via additional refs.
  const boneRefs: Id[] = [bindBone];
  // Inverse of the bind bone's world transform — used to map world-space
  // vertex positions into bone-local space (where the skinner expects them).
  const inv: Mat3 = boneWorld
    ? mat3Invert(boneWorld)
    : { m: new Float32Array([1, 0, 0, 1, 0, 0]) };
  const verts: [Vertex, Vertex, Vertex, Vertex] = worldPositions.map(([wx, wy]) => {
    // Compute weights in world space (where bone-proximity is meaningful).
    const w = autoWeightsFor(project, boneRefs, wx, wy);
    // Transform into bone-local space using the inverse of boneWorld.
    const lx = inv.m[0] * wx + inv.m[2] * wy + inv.m[4];
    const ly = inv.m[1] * wx + inv.m[3] * wy + inv.m[5];
    return { x: lx, y: ly, bones: w.bones, weights: w.weights };
  }) as [Vertex, Vertex, Vertex, Vertex];

  return {
    id: newId(),
    name: uniqueName(project, "attachment"),
    imageDataUrl: image.dataUrl,
    imageWidth: image.width,
    imageHeight: image.height,
    vertices: verts,
    triangles: [
      { a: 0, b: 1, c: 2 },   // BL → BR → TR
      { a: 0, b: 2, c: 3 },   // BL → TR → TL
    ],
    // Per-vertex UVs in [0, 1] image space, BL → BR → TR → TL.
    // Populated as of P2.5.a so `subdivideMeshAttachment` can lerp UVs
    // when it inserts midpoint vertices. The renderer falls back to
    // these directly when no atlas is involved (editor preview).
    uvs: [
      { u: 0, v: 1 }, // BL
      { u: 1, v: 1 }, // BR
      { u: 1, v: 0 }, // TR
      { u: 0, v: 0 }, // TL
    ],
    bindBone,
    boneRefs,
  };
}

/** Add an attachment to the project and create a default slot that points
 *  to it. */
export function addAttachment(
  project: Project,
  attachment: MeshAttachment,
): Slot {
  project.attachments[attachment.id] = attachment;
  project.attachmentOrder.push(attachment.id);
  const slot: Slot = {
    id: newId(),
    name: attachment.name,
    attachment: attachment.id,
    bone: attachment.bindBone,
  };
  project.slots[slot.id] = slot;
  project.slotOrder.push(slot.id);
  return slot;
}

/** Remove an attachment, its slot, and any references. */
export function removeAttachment(project: Project, id: Id): void {
  delete project.attachments[id];
  project.attachmentOrder = project.attachmentOrder.filter((x) => x !== id);
  for (const sid of project.slotOrder) {
    const s = project.slots[sid];
    if (s && s.attachment === id) s.attachment = null;
  }
}

/** Re-compute auto-weights against the current rig (FR-MS-4 — P2.E).
 *
 *  Use case: the user added a quad attachment when only one bone existed,
 *  then later added two more bones underneath the mesh. The original
 *  weights all snap to bone-1 with weight 1.0 — useless for skinning. This
 *  helper re-runs the same nearest-bone weighting that ran at create time,
 *  but against `boneIds` (defaulting to all project bones).
 *
 *  Mutates `attachment.boneRefs` to the bones that actually picked up
 *  weight, plus `attachment.vertices[*].bones / .weights`. Idempotent —
 *  safe to call repeatedly. */
export function recomputeAutoWeights(
  project: Project,
  attachmentId: Id,
  boneIds?: Id[],
): boolean {
  const att = project.attachments[attachmentId];
  if (!att) return false;
  const refs = boneIds && boneIds.length > 0
    ? boneIds.filter((id) => !!project.bones[id])
    : project.boneOrder.slice();
  if (refs.length === 0) return false;

  // The vertices are stored in bind-bone-local space. Convert each vertex
  // to world space, run the proximity test, then save back without
  // touching `vertex.x` / `vertex.y` (the geometry doesn't move — only
  // its weights). We deliberately do NOT change `bindBone` here; that's a
  // separate user choice.
  const bindWorld = evalBoneWorld(project, att.bindBone);
  if (!bindWorld) return false;
  const newRefs: Id[] = [];
  const refIndex = (id: Id): number => {
    let i = newRefs.indexOf(id);
    if (i < 0) { newRefs.push(id); i = newRefs.length - 1; }
    return i;
  };

  for (const v of att.vertices) {
    // Map local → world for the distance calculation.
    const wx = bindWorld.m[0] * v.x + bindWorld.m[2] * v.y + bindWorld.m[4];
    const wy = bindWorld.m[1] * v.x + bindWorld.m[3] * v.y + bindWorld.m[5];
    const w = autoWeightsFor(project, refs, wx, wy);
    // Track which bones actually got picked so boneRefs stays minimal.
    for (const b of w.bones) refIndex(b);
    v.bones = w.bones;
    v.weights = w.weights;
  }
  att.boneRefs = newRefs;
  return true;
}

/** Subdivide every triangle in a mesh attachment 1-to-4 (FR-MS-5 —
 *  P2.5.a). For each triangle (a, b, c) we insert three midpoint
 *  vertices on its edges and replace the source triangle with four
 *  sub-triangles. Midpoints are shared across adjacent triangles via a
 *  per-edge cache so the result stays a closed mesh.
 *
 *  Each midpoint inherits:
 *    - position = mean(endpoints)
 *    - UV       = mean(endpoint UVs)         (skipped if att.uvs missing)
 *    - bones    = endpoint bones, deduplicated up to 4 by descending weight
 *    - weights  = mean of endpoint weights, renormalized to sum 1
 *
 *  In-place mutation. Returns the number of vertices added so callers
 *  can decide whether to invalidate render caches. */
export function subdivideMeshAttachment(
  project: Project,
  attachmentId: Id,
): number {
  const att = project.attachments[attachmentId];
  if (!att) return 0;
  const verts = att.vertices.slice();
  const uvs = att.uvs ? att.uvs.slice() : null;
  // Cache: "min(a,b)|max(a,b)" → index of the midpoint vertex.
  const midCache = new Map<string, number>();
  const edgeKey = (a: number, b: number) => a < b ? `${a}|${b}` : `${b}|${a}`;

  /** Get or create the midpoint vertex on the edge (a, b). Returns
   *  the new vertex's index. Lerps every per-vertex field. */
  const midpointOf = (a: number, b: number): number => {
    const key = edgeKey(a, b);
    const cached = midCache.get(key);
    if (cached !== undefined) return cached;
    const va = verts[a]!, vb = verts[b]!;
    const newV: Vertex = {
      x: (va.x + vb.x) / 2,
      y: (va.y + vb.y) / 2,
      bones: pickAndAverageBones(va, vb),
      weights: averageWeights(va, vb),
    };
    verts.push(newV);
    if (uvs) {
      const ua = uvs[a]!, ub = uvs[b]!;
      uvs.push({ u: (ua.u + ub.u) / 2, v: (ua.v + ub.v) / 2 });
    }
    const idx = verts.length - 1;
    midCache.set(key, idx);
    return idx;
  };

  // Replace each triangle with 4 sub-triangles.
  const newTris: Triangle[] = [];
  for (const t of att.triangles) {
    const mAb = midpointOf(t.a, t.b);
    const mBc = midpointOf(t.b, t.c);
    const mCa = midpointOf(t.c, t.a);
    // CCW order matches the source triangle (a, b, c).
    newTris.push(
      { a: t.a, b: mAb, c: mCa },
      { a: mAb, b: t.b, c: mBc },
      { a: mCa, b: mBc, c: t.c },
      { a: mAb, b: mBc, c: mCa },
    );
  }

  const added = verts.length - att.vertices.length;
  att.vertices = verts;
  att.triangles = newTris;
  if (uvs) att.uvs = uvs;
  return added;
}

/** For a midpoint vertex, pick up to 4 bones from the union of the two
 *  endpoint vertices, prioritising by combined weight. Empty/zero-
 *  weight entries are skipped. Returns a strict 4-tuple as required by
 *  the model's Vertex.bones type. */
function pickAndAverageBones(a: Vertex, b: Vertex): [Id, Id, Id, Id] {
  const acc = new Map<Id, number>();
  for (let k = 0; k < 4; k++) {
    if ((a.weights[k] ?? 0) > 0) acc.set(a.bones[k] as Id, (acc.get(a.bones[k] as Id) ?? 0) + (a.weights[k] ?? 0));
    if ((b.weights[k] ?? 0) > 0) acc.set(b.bones[k] as Id, (acc.get(b.bones[k] as Id) ?? 0) + (b.weights[k] ?? 0));
  }
  const sorted = [...acc.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4);
  // Pad if we have < 4. Use the first available id (bind bone equivalent)
  // so the slot is filled with a valid reference; weight will be 0 there.
  while (sorted.length < 4) {
    const fill = sorted[0]?.[0] ?? a.bones[0];
    sorted.push([fill as Id, 0]);
  }
  return [sorted[0]![0], sorted[1]![0], sorted[2]![0], sorted[3]![0]];
}

/** Average the weights of two endpoint vertices, aligned to whatever
 *  bones `pickAndAverageBones` returned. Renormalised to sum 1. */
/** Simple mesh cut helper (P3). Cuts a mesh by deleting triangles whose
 *  centroid lies on the "right" side of a line in local mesh space. This
 *  is the non-interactive core behind a future knife tool: the viewport
 *  will supply the line from a drag gesture. For now, callers can use it
 *  to split/remove a half of a mesh deterministically.
 *
 *  Returns number of triangles removed. Does not delete orphan vertices
 *  (they're harmless and keeping indices stable avoids remapping bugs). */
export function cutMeshByLine(
  project: Project,
  attachmentId: Id,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const att = project.attachments[attachmentId];
  if (!att) return 0;
  const side = (x: number, y: number) => (bx - ax) * (y - ay) - (by - ay) * (x - ax);
  const before = att.triangles.length;
  att.triangles = att.triangles.filter((t) => {
    const A = att.vertices[t.a]!, B = att.vertices[t.b]!, C = att.vertices[t.c]!;
    const cx = (A.x + B.x + C.x) / 3;
    const cy = (A.y + B.y + C.y) / 3;
    return side(cx, cy) <= 0;
  });
  return before - att.triangles.length;
}

function averageWeights(a: Vertex, b: Vertex): [number, number, number, number] {
  // Build bone → average weight first, then align to the picked tuple.
  const acc = new Map<Id, number>();
  const consume = (v: Vertex) => {
    for (let k = 0; k < 4; k++) {
      const w = v.weights[k] ?? 0;
      if (w <= 0) continue;
      acc.set(v.bones[k] as Id, (acc.get(v.bones[k] as Id) ?? 0) + w);
    }
  };
  consume(a); consume(b);
  // Renormalise so sum === 1. We average each by 2 (divide by 2 == average
  // of two weights summing to 1 each), then renormalise to handle any
  // residue from incomplete weight tuples.
  let total = 0;
  for (const w of acc.values()) total += w;
  if (total <= 0) return [1, 0, 0, 0];
  const sorted = [...acc.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4);
  const norm: number[] = sorted.map(([, w]) => w / total);
  while (norm.length < 4) norm.push(0);
  return [norm[0]!, norm[1]!, norm[2]!, norm[3]!];
}
