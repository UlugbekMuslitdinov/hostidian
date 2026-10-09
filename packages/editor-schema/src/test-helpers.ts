import type { HBlock } from "./schema";

export const PAGE_A = "0190a5b2-7c3e-7a11-8f44-1234567890ab";
export const PAGE_B = "0190a5b2-7c3e-7a11-8f44-1234567890ac";
export const PAGE_C = "11111111-2222-4333-8444-555555555555";

/** Drops generated block ids and BlockNote's default props so documents can be compared structurally. */
export function normalize(blocks: HBlock[]): unknown {
  return JSON.parse(
    JSON.stringify(blocks, (key, value: unknown) =>
      key === "id" || key === "backgroundColor" || key === "textColor" || key === "textAlignment" ? undefined : value,
    ),
  );
}
