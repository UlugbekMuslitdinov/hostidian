/** The few fields of a BlockNote block that id reconciliation looks at. */
export interface IdentifiedBlock {
  id?: string;
  type: string;
  children?: IdentifiedBlock[];
}

/** Blocks and their descendants without ids: two blocks with the same key look identical to the user. */
function keyOf(block: IdentifiedBlock): string {
  const strip = (value: IdentifiedBlock): unknown => {
    const { id: _id, children, ...rest } = value;
    return [rest, (children ?? []).map(strip)];
  };
  return JSON.stringify(strip(block));
}

/** Longest-common-subsequence pairs `[existingIndex, incomingIndex]` of blocks that are identical apart from ids. */
function matchIdentical(existing: string[], incoming: string[]): Array<[number, number]> {
  // Beyond this the quadratic table is not worth it; fall back to the common prefix/suffix.
  const LIMIT = 4_000_000;
  const pairs: Array<[number, number]> = [];
  let start = 0;
  while (start < existing.length && start < incoming.length && existing[start] === incoming[start]) {
    pairs.push([start, start]);
    start++;
  }
  let endOld = existing.length;
  let endNew = incoming.length;
  const tail: Array<[number, number]> = [];
  while (endOld > start && endNew > start && existing[endOld - 1] === incoming[endNew - 1]) {
    endOld--;
    endNew--;
    tail.push([endOld, endNew]);
  }
  const rows = endOld - start;
  const cols = endNew - start;
  if (rows > 0 && cols > 0 && rows * cols <= LIMIT) {
    // lcs[i][j] = LCS length of existing[start+i..] and incoming[start+j..]
    const width = cols + 1;
    const lcs = new Uint32Array((rows + 1) * width);
    for (let i = rows - 1; i >= 0; i--) {
      for (let j = cols - 1; j >= 0; j--) {
        lcs[i * width + j] =
          existing[start + i] === incoming[start + j]
            ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
            : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < rows && j < cols) {
      if (existing[start + i] === incoming[start + j]) {
        pairs.push([start + i, start + j]);
        i++;
        j++;
      } else if ((lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0)) i++;
      else j++;
    }
  }
  return pairs.concat(tail.reverse());
}

function copyIdsDeep(from: IdentifiedBlock, to: IdentifiedBlock): void {
  if (from.id !== undefined) to.id = from.id;
  const target = to.children ?? [];
  (from.children ?? []).forEach((child, index) => {
    const mate = target[index];
    if (mate) copyIdsDeep(child, mate);
  });
}

/**
 * Gives freshly parsed `incoming` blocks the ids of the `existing` blocks they correspond to, so replacing a page body
 * keeps comment anchors and the in-place Yjs diff small. Blocks identical apart from ids are matched first (longest
 * common subsequence); inside the gaps, blocks of the same type at the same position count as edited versions of each
 * other (and their children are reconciled the same way). Mutates and returns `incoming`.
 */
export function reuseBlockIds<T extends IdentifiedBlock>(existing: readonly T[], incoming: T[]): T[] {
  const pairs = matchIdentical(existing.map(keyOf), incoming.map(keyOf));
  const used = new Set<number>();
  for (const [oldIndex, newIndex] of pairs) {
    const from = existing[oldIndex];
    const to = incoming[newIndex];
    if (from && to) copyIdsDeep(from, to);
    used.add(newIndex);
  }
  // Gaps between matched pairs: pair edited blocks of the same type in order.
  const bounds: Array<[number, number, number, number]> = [];
  let prevOld = -1;
  let prevNew = -1;
  for (const [oldIndex, newIndex] of [...pairs, [existing.length, incoming.length] as [number, number]]) {
    bounds.push([prevOld + 1, oldIndex, prevNew + 1, newIndex]);
    prevOld = oldIndex;
    prevNew = newIndex;
  }
  for (const [oldFrom, oldTo, newFrom, newTo] of bounds) {
    const count = Math.min(oldTo - oldFrom, newTo - newFrom);
    for (let offset = 0; offset < count; offset++) {
      const from = existing[oldFrom + offset];
      const to = incoming[newFrom + offset];
      if (!from || !to || used.has(newFrom + offset) || from.type !== to.type) continue;
      if (from.id !== undefined) to.id = from.id;
      if (from.children && to.children) reuseBlockIds(from.children as T[], to.children as T[]);
    }
  }
  return incoming;
}
