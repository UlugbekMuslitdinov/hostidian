import { isCalloutKind, type CalloutKind } from "../constants";
import type { HBlock } from "../schema";
import {
  isTableContent,
  mapInlineArrays,
  type LooseBlock,
  type LooseInline,
  type LooseTableContent,
} from "../loose";
import { withMarkdownEngine } from "./dom-editor";
import {
  CALLOUT_PREFIX,
  PAGE_LINK_PREFIX,
  formatPageLink,
  isPageId,
  pageLinkRegex,
  token,
  tokenRegex,
  uniqueNonce,
  unescapeTitle,
} from "./tokens";

/** Callouts nest (callout in a callout); bound the recursion so hostile input cannot blow the stack. */
const MAX_CALLOUT_DEPTH = 16;

// =====================================================================================================================
// blocks -> Markdown
// =====================================================================================================================

interface ExportState {
  nonce: string;
  links: { pageId: string; title: string }[];
  callouts: LooseBlock[];
}

const EMPTY_STYLES = {};

function textItem(text: string): LooseInline {
  return { type: "text", text, styles: EMPTY_STYLES };
}

function fileNameFromUrl(url: unknown): string {
  if (typeof url !== "string") return "file";
  const last = url.split(/[?#]/)[0]?.split("/").filter(Boolean).pop();
  return last || "file";
}

/**
 * Rewrites a block (and its subtree) into something `blocksToMarkdownLossy` renders in our dialect:
 * callouts and page links become tokens; media blocks are normalised to `![alt](url)` / `[name](url)`.
 */
function prepareForExport(blocks: LooseBlock[], state: ExportState): LooseBlock[] {
  return blocks.map((block): LooseBlock => {
    if (block.type === "callout") {
      state.callouts.push(block);
      return {
        id: block.id,
        type: "paragraph",
        props: {},
        content: [textItem(token(CALLOUT_PREFIX, state.nonce, state.callouts.length - 1))],
        children: [],
      };
    }

    let out: LooseBlock = block;
    const props = block.props ?? {};
    if (block.type === "image") {
      // BlockNote renders captioned images as raw <figure> HTML; the dialect is plain ![alt](url).
      const alt = [props.caption, props.name].find((v): v is string => typeof v === "string" && v.length > 0) ?? "";
      out = { ...block, props: { ...props, name: alt, caption: "" } };
    } else if (block.type === "audio" || block.type === "video" || block.type === "file") {
      // Non-image files are plain links; audio/video would otherwise come out as raw HTML or as an image.
      const name =
        [props.name, props.caption].find((v): v is string => typeof v === "string" && v.length > 0) ??
        fileNameFromUrl(props.url);
      out = { ...block, type: "file", props: { url: props.url ?? "", name, caption: "" } };
    }

    out = mapInlineArrays(out, (items) =>
      items.map((item): LooseInline => {
        if (item.type !== "pageLink") return item;
        const pageId = item.props?.pageId;
        const title = typeof item.props?.title === "string" ? item.props.title : "";
        // A link without a valid target degrades to its visible title.
        if (!isPageId(pageId)) return textItem(title);
        state.links.push({ pageId, title });
        return textItem(token(PAGE_LINK_PREFIX, state.nonce, state.links.length - 1));
      }),
    );
    return { ...out, children: prepareForExport(block.children ?? [], state) };
  });
}

async function renderCallout(block: LooseBlock): Promise<string> {
  const kind: CalloutKind = isCalloutKind(block.props?.kind) ? block.props.kind : "note";
  const content = Array.isArray(block.content) ? block.content : [];
  const head = content.length
    ? await exportBlocks([{ type: "paragraph", props: {}, content, children: [] }])
    : "";
  const body = block.children?.length ? await exportBlocks(block.children) : "";

  const headLines = head ? head.split("\n") : [];
  const out = [`> [!${kind}]${headLines[0] ? ` ${headLines[0]}` : ""}`];
  for (const line of headLines.slice(1)) out.push(line ? `> ${line}` : ">");
  if (body) {
    out.push(">");
    for (const line of body.split("\n")) out.push(line ? `> ${line}` : ">");
  }
  return out.join("\n");
}

async function exportBlocks(blocks: LooseBlock[]): Promise<string> {
  const state: ExportState = {
    nonce: uniqueNonce(JSON.stringify(blocks)),
    links: [],
    callouts: [],
  };
  const prepared = prepareForExport(blocks, state);
  const raw = await withMarkdownEngine((engine) => engine.serialize(prepared));
  const renderedCallouts = await Promise.all(state.callouts.map(renderCallout));

  const calloutRe = tokenRegex(CALLOUT_PREFIX, state.nonce);
  const linkRe = tokenRegex(PAGE_LINK_PREFIX, state.nonce);
  const standaloneCallout = new RegExp(`^${CALLOUT_PREFIX}${state.nonce}n(\\d+)END$`);
  const lines: string[] = [];
  for (const line of raw.split("\n")) {
    const standalone = standaloneCallout.exec(line.trim());
    const rendered = standalone?.[1] === undefined ? undefined : renderedCallouts[Number(standalone[1])];
    if (rendered !== undefined) {
      lines.push(...rendered.split("\n"));
      continue;
    }
    const inTable = line.trimStart().startsWith("|");
    lines.push(
      line
        // Defensive: a callout token that BlockNote nested into some other block degrades to the callout's text.
        .replace(calloutRe, (_all, index: string) => {
          const content = state.callouts[Number(index)]?.content;
          return Array.isArray(content) ? content.map((i) => i.text ?? "").join("") : "";
        })
        .replace(linkRe, (_all, index: string) => {
          const link = state.links[Number(index)];
          return link ? formatPageLink(link.pageId, link.title, inTable) : "";
        }),
    );
  }
  return lines.join("\n").replace(/\s+$/, "");
}

/**
 * Serialises blocks to Markdown (GFM via BlockNote's lossy exporter) with the Hostidian extensions of
 * docs/conventions.md §8: `[[hostidian:<uuid>|<title>]]` page links and `> [!kind] text` callouts.
 */
export async function blocksToMarkdown(blocks: HBlock[]): Promise<string> {
  return exportBlocks(blocks as LooseBlock[]);
}

// =====================================================================================================================
// Markdown -> blocks
// =====================================================================================================================

interface ImportState {
  nonce: string;
  links: { pageId: string; title: string }[];
  callouts: { kind: CalloutKind; firstLine: string; rest: string[] }[];
}

/** Obsidian ships many callout types; map them onto the four we render. */
const CALLOUT_KIND_ALIASES: Record<string, CalloutKind> = {
  note: "note",
  info: "note",
  todo: "note",
  abstract: "note",
  summary: "note",
  tldr: "note",
  example: "note",
  quote: "note",
  cite: "note",
  tip: "tip",
  hint: "tip",
  important: "tip",
  success: "tip",
  check: "tip",
  done: "tip",
  warning: "warning",
  caution: "warning",
  attention: "warning",
  question: "warning",
  help: "warning",
  faq: "warning",
  danger: "danger",
  error: "danger",
  failure: "danger",
  fail: "danger",
  missing: "danger",
  bug: "danger",
};

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const CALLOUT_HEAD = /^ {0,3}>[ \t]?\[!([A-Za-z][A-Za-z0-9_-]*)\][+-]?(?:[ \t]+(.*))?[ \t]*$/;
const QUOTE_LINE = /^ {0,3}>/;

function dequote(line: string): string {
  return line.replace(/^ {0,3}>[ \t]?/, "");
}

/**
 * Cuts `> [!kind] ...` blockquote regions out of the Markdown and leaves one standalone token paragraph per callout.
 * Fenced code is left untouched.
 */
function extractCallouts(lines: string[], state: ImportState): string[] {
  const out: string[] = [];
  let fence: { char: string; length: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const open = FENCE_OPEN.exec(line);
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close?.[1] && close[1].startsWith(fence.char) && close[1].length >= fence.length) fence = undefined;
      out.push(line);
      continue;
    }
    if (open?.[1]) {
      fence = { char: open[1].charAt(0), length: open[1].length };
      out.push(line);
      continue;
    }
    const head = CALLOUT_HEAD.exec(line);
    if (!head) {
      out.push(line);
      continue;
    }
    let end = i + 1;
    while (end < lines.length && QUOTE_LINE.test(lines[end] ?? "")) end++;
    state.callouts.push({
      kind: CALLOUT_KIND_ALIASES[(head[1] ?? "").toLowerCase()] ?? "note",
      firstLine: head[2] ?? "",
      rest: lines.slice(i + 1, end).map(dequote),
    });
    out.push("", token(CALLOUT_PREFIX, state.nonce, state.callouts.length - 1), "");
    i = end - 1;
  }
  return out;
}

/** Replaces `[[hostidian:...]]` outside code (fences and inline code spans) with tokens. */
function replacePageLinks(lines: string[], state: ImportState): string[] {
  let fence: { char: string; length: number } | undefined;
  return lines.map((line) => {
    const open = FENCE_OPEN.exec(line);
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close?.[1] && close[1].startsWith(fence.char) && close[1].length >= fence.length) fence = undefined;
      return line;
    }
    if (open?.[1]) {
      fence = { char: open[1].charAt(0), length: open[1].length };
      return line;
    }
    if (!line.includes("[[hostidian:")) return line;

    // Split on inline code spans (a backtick run closed by a run of the same length) and only rewrite the rest.
    const parts: string[] = [];
    let cursor = 0;
    const tick = /`+/g;
    for (let m = tick.exec(line); m; m = tick.exec(line)) {
      const run = m[0];
      const closeAt = line.indexOf(run, m.index + run.length);
      // Skip when no equal-length closing run exists (then the backticks are literal) or it is part of a longer run.
      let close = closeAt;
      while (close !== -1 && (line[close + run.length] === "`" || line[close - 1] === "`")) {
        close = line.indexOf(run, close + 1);
      }
      if (close === -1) continue;
      parts.push(rewrite(line.slice(cursor, m.index)), line.slice(m.index, close + run.length));
      cursor = close + run.length;
      tick.lastIndex = cursor;
    }
    parts.push(rewrite(line.slice(cursor)));
    return parts.join("");
  });

  function rewrite(segment: string): string {
    return segment.replace(pageLinkRegex(), (_all, pageId: string, escapedTitle: string) => {
      state.links.push({ pageId: pageId.toLowerCase(), title: unescapeTitle(escapedTitle) });
      return token(PAGE_LINK_PREFIX, state.nonce, state.links.length - 1);
    });
  }
}

/** `<br>` + newline comes back from BlockNote's parser as "\n" followed by a stray space. */
function normalizeText(text: string): string {
  return text.replace(/\n +/g, "\n");
}

function restoreInline(items: LooseInline[], state: ImportState, linkRe: RegExp): LooseInline[] {
  const out: LooseInline[] = [];
  for (const item of items) {
    if (item.type === "link") {
      // Links hold styled text only, so a page link inside one degrades to its title.
      out.push({
        ...item,
        content: (item.content ?? []).map((c) =>
          c.type === "text"
            ? {
                ...c,
                text: normalizeText(c.text ?? "").replace(linkRe, (_all, i: string) => state.links[Number(i)]?.title ?? ""),
              }
            : c,
        ),
      });
      continue;
    }
    if (item.type !== "text" || !item.text) {
      out.push(item);
      continue;
    }
    const text = normalizeText(item.text);
    let cursor = 0;
    for (const m of text.matchAll(linkRe)) {
      const link = state.links[Number(m[1])];
      const start = m.index ?? 0;
      if (start > cursor) out.push({ ...item, text: text.slice(cursor, start) });
      if (link) out.push({ type: "pageLink", props: { pageId: link.pageId, title: link.title } });
      cursor = start + m[0].length;
    }
    if (cursor < text.length || cursor === 0) out.push({ ...item, text: text.slice(cursor) });
  }
  return out;
}

function isBlankInline(items: LooseInline[]): boolean {
  return items.every((i) => i.type === "text" && !(i.text ?? "").trim());
}

/** GFM needs a header row, so BlockNote exports header-less tables with an empty one. Drop it again on import. */
function dropEmptyHeaderRow(content: LooseTableContent): LooseTableContent {
  const [first, ...others] = content.rows;
  if (content.headerRows !== 1 || !first || others.length === 0) return content;
  const empty = first.cells.every((cell) => isBlankInline(Array.isArray(cell) ? cell : cell.content));
  if (!empty) return content;
  const { headerRows: _headerRows, ...withoutHeader } = content;
  return { ...withoutHeader, rows: others };
}

async function buildCallout(
  id: string | undefined,
  spec: ImportState["callouts"][number],
  depth: number,
): Promise<LooseBlock> {
  const rest = [...spec.rest];
  let content: LooseInline[] = [];
  let children: LooseBlock[];
  if (!spec.firstLine && rest.length > 0 && rest[0]?.trim() === "") {
    // "> [!note]" + blank line: the callout has no text of its own, everything after is body.
    children = await importMarkdown(rest.join("\n"), depth + 1, true);
  } else {
    const blocks = await importMarkdown([spec.firstLine, ...rest].join("\n"), depth + 1, true);
    const [first, ...others] = blocks;
    if (first?.type === "paragraph" && Array.isArray(first.content)) {
      content = first.content;
      children = others;
    } else {
      children = blocks;
    }
  }
  return { id, type: "callout", props: { kind: spec.kind }, content, children };
}

async function restoreBlocks(blocks: LooseBlock[], state: ImportState, depth: number): Promise<LooseBlock[]> {
  const linkRe = tokenRegex(PAGE_LINK_PREFIX, state.nonce);
  const out: LooseBlock[] = [];
  for (const block of blocks) {
    if (block.type === "paragraph" && Array.isArray(block.content) && block.content.length === 1) {
      const only = block.content[0];
      const m = only?.type === "text" ? new RegExp(`^${CALLOUT_PREFIX}${state.nonce}n(\\d+)END$`).exec(only.text ?? "") : null;
      const spec = m?.[1] === undefined ? undefined : state.callouts[Number(m[1])];
      if (spec) {
        out.push(await buildCallout(block.id, spec, depth));
        continue;
      }
    }

    let next = mapInlineArrays(block, (items) => restoreInline(items, state, linkRe));
    if (isTableContent(next.content)) next = { ...next, content: dropEmptyHeaderRow(next.content) };
    if (next.props) {
      // Tokens can only land in string props (image alt etc.) if the author nested links in odd places.
      next = {
        ...next,
        props: Object.fromEntries(
          Object.entries(next.props).map(([key, value]) => [
            key,
            typeof value === "string"
              ? value.replace(linkRe, (_all, i: string) => state.links[Number(i)]?.title ?? "")
              : value,
          ]),
        ),
      };
    }
    out.push({ ...next, children: await restoreBlocks(next.children ?? [], state, depth) });
  }
  return out;
}

async function importMarkdown(markdown: string, depth: number, trimLeadingBlank = false): Promise<LooseBlock[]> {
  const source = markdown.replace(/\r\n?/g, "\n");
  const nonce = uniqueNonce(source);
  const state: ImportState = { nonce, links: [], callouts: [] };

  let lines = source.split("\n");
  if (trimLeadingBlank) {
    while (lines.length > 0 && (lines[0] ?? "").trim() === "") lines.shift();
  }
  // Past the depth bound the remaining `> [!x]` text is just parsed as an ordinary blockquote.
  if (depth <= MAX_CALLOUT_DEPTH) lines = extractCallouts(lines, state);
  lines = replacePageLinks(lines, state);

  const prepared = lines.join("\n");
  const parsed = (await withMarkdownEngine((engine) => engine.parse(prepared))) as LooseBlock[];
  return restoreBlocks(parsed, state, depth);
}

/**
 * Parses Markdown (GFM plus the Hostidian extensions of docs/conventions.md §8) into blocks. Unknown `[[...]]` forms
 * stay plain text; Obsidian callout types are mapped onto note/tip/warning/danger.
 */
export async function markdownToBlocks(markdown: string): Promise<HBlock[]> {
  return (await importMarkdown(markdown, 0)) as unknown as HBlock[];
}
