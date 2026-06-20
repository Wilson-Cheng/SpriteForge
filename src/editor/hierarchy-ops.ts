// src/editor/hierarchy-ops.ts
// Tree-traversal helpers for the bone hierarchy. Kept separate from store.ts
// so that the latter can stay focused on flat state mutations.

import type { Project, Id, Bone } from "../core/model";

export function rootOf(project: Project, id: Id): Id {
  let cur: Id | null = id;
  const seen = new Set<Id>();
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur);
    const b: Bone | undefined = project.bones[cur];
    if (!b) break;
    if (b.parent === null) return cur;
    cur = b.parent;
  }
  return id;
}

/** Returns true if `descendantId` is `ancestorId` or any descendant of it
 *  (transitively). Returns false if `descendantId` is the ancestor's parent,
 *  sibling, or unrelated. */
export function isDescendantOf(project: Project, ancestorId: Id, descendantId: Id): boolean {
  if (ancestorId === descendantId) return true;
  // Walk from descendantId up through its parents. If we hit ancestorId,
  // then descendantId IS a descendant of ancestorId.
  let cur: Id | null = descendantId;
  const seen = new Set<Id>();
  while (cur !== null && !seen.has(cur)) {
    if (cur === ancestorId) return true;
    seen.add(cur);
    const b: Bone | undefined = project.bones[cur];
    if (!b || b.parent === null) return false;
    cur = b.parent;
  }
  return false;
}

/** Children of a bone in declaration order. */
export function childrenOf(project: Project, id: Id): Id[] {
  const out: Id[] = [];
  for (const cid of project.boneOrder) {
    const c = project.bones[cid];
    if (c && c.parent === id) out.push(cid);
  }
  return out;
}

/** Depth-first traversal of the bone tree, starting at the roots. */
export function* walkTree(project: Project): Generator<{ bone: Bone; depth: number; parent: Id | null }> {
  for (const rootId of project.rootIds) {
    yield* walkSubtree(project, rootId, 0, null);
  }
}

function* walkSubtree(project: Project, id: Id, depth: number, parent: Id | null): Generator<{ bone: Bone; depth: number; parent: Id | null }> {
  const b: Bone | undefined = project.bones[id];
  if (!b) return;
  yield { bone: b, depth, parent };
  for (const cid of childrenOf(project, id)) {
    yield* walkSubtree(project, cid, depth + 1, id);
  }
}

/** Counts all descendants of a bone (excluding the bone itself). */
export function descendantCount(project: Project, id: Id): number {
  let n = 0;
  const stack: Id[] = [id];
  const seen = new Set<Id>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const cid of childrenOf(project, cur)) {
      if (cid !== id) {
        n++;
        stack.push(cid);
      }
    }
  }
  return n;
}
