// src/core/ik.ts
// Two-bone IK solver (P3). Applies constraints to a Project by mutating
// bone rotations in-place. Designed for editor preview / authoring; the
// export path can later bake the resulting rotations into keyframes.
//
// Constraint model: targetBone is the child/end-effector bone. Its
// parent is the upper bone. Target is a world-space point. We solve the
// chain (upper → child) so the child's tail gets as close as possible to
// target.

import type { Project, Id } from "./model";
import { evalPose } from "./eval";
import { clamp, radToDeg } from "./math";

/** Apply every IK constraint in project.ikOrder in order. Mutates bone
 *  rotations. Returns number of constraints actually applied. */
export function applyIk(project: Project): number {
  if (!project.ikOrder || project.ikOrder.length === 0) return 0;
  let applied = 0;
  for (const id of project.ikOrder) {
    const c = project.ik[id];
    if (!c || c.mix <= 0) continue;
    if (solveTwoBoneIk(project, c.targetBone, c.target.x, c.target.y, c.bend, c.mix)) {
      applied++;
    }
  }
  return applied;
}

/** Solve one two-bone chain. Returns false when the target bone doesn't
 *  have a parent, or either bone is missing / zero-length. */
export function solveTwoBoneIk(
  project: Project,
  targetBoneId: Id,
  targetX: number,
  targetY: number,
  bend: 1 | -1 = 1,
  mix = 1,
): boolean {
  const child = project.bones[targetBoneId];
  if (!child || !child.parent) return false;
  const parent = project.bones[child.parent];
  if (!parent) return false;
  const l1 = Math.max(1e-6, parent.length);
  const l2 = Math.max(1e-6, child.length);
  const pose = evalPose(project);
  const parentWorld = pose.get(parent.id);
  const childWorld = pose.get(child.id);
  if (!parentWorld || !childWorld) return false;
  const rootX = parentWorld.m[4] ?? 0;
  const rootY = parentWorld.m[5] ?? 0;
  const dx = targetX - rootX;
  const dy = targetY - rootY;
  const dist = clamp(Math.hypot(dx, dy), 1e-6, l1 + l2 - 1e-6);

  // Law of cosines. angle1 is the angle from root→target to the upper
  // bone. angle2 is the elbow angle between upper and lower bone.
  const base = Math.atan2(dy, dx);
  const cosA = clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1);
  const a = Math.acos(cosA) * bend;
  const upperWorldRot = base - a;

  const cosB = clamp((l1 * l1 + l2 * l2 - dist * dist) / (2 * l1 * l2), -1, 1);
  const elbow = Math.PI - Math.acos(cosB);
  const childLocalRot = elbow * bend;

  // Convert desired upper world rotation into parent.local rotation.
  // If parent itself has a parent, subtract that ancestor world rotation.
  let ancestorRot = 0;
  if (parent.parent) {
    const ancWorld = pose.get(parent.parent);
    if (ancWorld) ancestorRot = Math.atan2(ancWorld.m[1] ?? 0, ancWorld.m[0] ?? 1);
  }
  const desiredParentLocal = radToDeg(upperWorldRot - ancestorRot);
  const desiredChildLocal = radToDeg(childLocalRot);
  // Mix into current rotations rather than snapping hard when mix < 1.
  parent.rotation = parent.rotation + (desiredParentLocal - parent.rotation) * mix;
  child.rotation = child.rotation + (desiredChildLocal - child.rotation) * mix;
  return true;
}
