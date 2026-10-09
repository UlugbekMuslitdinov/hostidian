import { UUID_RE } from "../constants";

/**
 * BlockNote's Markdown functions know nothing about our custom nodes, so around them we swap page links and callouts for
 * alphanumeric placeholder tokens (nothing Markdown could escape or re-interpret) and swap the real syntax back in.
 *
 * Token shape: `<prefix><nonce>n<index>END`. The nonce is random per call and checked against the input so user text can
 * never collide with a token.
 */
export const PAGE_LINK_PREFIX = "PLK";
export const CALLOUT_PREFIX = "CLO";

export function uniqueNonce(...haystacks: string[]): string {
  for (;;) {
    const bytes = new Uint8Array(6);
    globalThis.crypto.getRandomValues(bytes);
    const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    if (!haystacks.some((h) => h.includes(nonce))) return nonce;
  }
}

export function token(prefix: string, nonce: string, index: number): string {
  return `${prefix}${nonce}n${index}END`;
}

export function tokenRegex(prefix: string, nonce: string, flags = "g"): RegExp {
  return new RegExp(`${prefix}${nonce}n(\\d+)END`, flags);
}

export function isPageId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

// ---- stored page-link syntax: [[hostidian:<uuid>|<title>]] --------------------------------------------------------

/** `\` and `]` are backslash-escaped in titles; inside table rows `|` is escaped too (GFM cell delimiter). */
function escapeTitle(title: string, inTable: boolean): string {
  let escaped = title.replace(/\r\n|\r|\n/g, " ").replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
  if (inTable) escaped = escaped.replace(/\|/g, "\\|");
  return escaped;
}

export function formatPageLink(pageId: string, title: string, inTable: boolean): string {
  const separator = inTable ? "\\|" : "|";
  return `[[hostidian:${pageId.toLowerCase()}${separator}${escapeTitle(title, inTable)}]]`;
}

/** Accepts both `|` and the table-escaped `\|` between id and title. Groups: 1 = uuid, 2 = escaped title. */
export function pageLinkRegex(): RegExp {
  return /\[\[hostidian:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\\?\|((?:\\[\s\S]|[^\]\\\n])*)\]\]/g;
}

export function unescapeTitle(escaped: string): string {
  return escaped.replace(/\\([\s\S])/g, "$1");
}
