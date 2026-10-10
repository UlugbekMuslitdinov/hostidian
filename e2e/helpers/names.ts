import { randomBytes } from "node:crypto";

/** A short random token: lower-case letters and digits only, so it is safe in emails, slugs and search queries. */
export function uniqueId(length = 8): string {
  return randomBytes(length).toString("hex").slice(0, length);
}

/**
 * A unique, human-readable name. `prefix` keeps screenshots/traces legible; the suffix makes it unique across
 * parallel workers and repeated runs against the same stack.
 */
export function uniqueName(prefix = "e2e"): string {
  return `${prefix} ${uniqueId(6)}`;
}

/** A single search-friendly word that no other test (or earlier run) will have written. */
export function uniqueWord(prefix = "quokka"): string {
  return `${prefix}${uniqueId(8)}`;
}

export function uniqueEmail(label = "user"): string {
  return `${label.toLowerCase().replace(/[^a-z0-9]+/g, "")}.${uniqueId(8)}@e2e.test`;
}
