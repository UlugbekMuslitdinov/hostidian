export interface SnippetPart {
  text: string;
  mark: boolean;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
};

function decode(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39|#x27);/g, (m) => ENTITIES[m] ?? m);
}

/**
 * Search snippets are HTML-escaped text with matches wrapped in `<mark>…</mark>` (openapi: SearchResult).
 * Parse them into parts so React renders them as text (never as injected HTML).
 */
export function parseSnippet(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  const re = /<mark>([\s\S]*?)<\/mark>/g;
  let last = 0;
  for (let m = re.exec(snippet); m !== null; m = re.exec(snippet)) {
    if (m.index > last) parts.push({ text: decode(snippet.slice(last, m.index)), mark: false });
    parts.push({ text: decode(m[1] ?? ""), mark: true });
    last = m.index + m[0].length;
  }
  if (last < snippet.length) parts.push({ text: decode(snippet.slice(last)), mark: false });
  return parts;
}
