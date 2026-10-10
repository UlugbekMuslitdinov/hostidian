/**
 * BlockNote renders the slash menu's headings from `item.group` and keys each heading by its text, so two
 * runs of the same group (the stock list has "Basic blocks" both before and after "Others", and our extra
 * items would add a third) produce a duplicate heading and a React key warning. Pull every group's items
 * together, keeping the groups in order of first appearance and the items in their original order.
 */
export function groupContiguously<T extends { group?: string }>(items: readonly T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = item.group ?? "";
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.values()].flat();
}
