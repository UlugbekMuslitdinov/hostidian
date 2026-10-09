/** Y.Doc XML fragment name BlockNote collaborates on (docs/conventions.md §6). MUST equal what the editor uses. */
export const YDOC_FRAGMENT = "blocknote";

/** Callout flavours, in the order the UI cycles through them. */
export const CALLOUT_KINDS = ["note", "tip", "warning", "danger"] as const;
export type CalloutKind = (typeof CALLOUT_KINDS)[number];

export function isCalloutKind(value: unknown): value is CalloutKind {
  return typeof value === "string" && (CALLOUT_KINDS as readonly string[]).includes(value);
}

/** Canonical (lower-case, hyphenated) UUID. Page ids are UUIDv7 or v4; we do not constrain the version. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
