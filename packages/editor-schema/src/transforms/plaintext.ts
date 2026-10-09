import type { HBlock } from "../schema";
import { isTableContent, type LooseBlock, type LooseInline } from "../loose";

function inlineText(items: LooseInline[]): string {
  let out = "";
  for (const item of items) {
    if (item.type === "text") out += item.text ?? "";
    else if (item.type === "link") out += inlineText(item.content ?? []);
    else if (item.type === "pageLink") out += typeof item.props?.title === "string" ? item.props.title : "";
    else if (item.content) out += inlineText(item.content);
  }
  return out;
}

const NAMED_MEDIA = new Set(["file", "audio", "video"]);

function collect(blocks: LooseBlock[], lines: string[]): void {
  for (const block of blocks) {
    const { content } = block;
    if (Array.isArray(content)) {
      const text = inlineText(content);
      if (text.trim()) lines.push(text);
    } else if (isTableContent(content)) {
      for (const row of content.rows) {
        const cells = row.cells
          .map((cell) => inlineText(Array.isArray(cell) ? cell : cell.content).trim())
          .filter(Boolean);
        if (cells.length) lines.push(cells.join(" "));
      }
    }
    // Media blocks show a caption (and, for non-image files, their file name) as visible text.
    const props = block.props ?? {};
    if (NAMED_MEDIA.has(block.type) && typeof props.name === "string" && props.name.trim()) {
      lines.push(props.name.trim());
    }
    if (typeof props.caption === "string" && props.caption.trim()) lines.push(props.caption.trim());
    if (block.children?.length) collect(block.children, lines);
  }
}

/** Visible text only (no Markdown or other markup), one block per line, in document order. Used for full-text search. */
export function blocksToPlaintext(blocks: HBlock[]): string {
  const lines: string[] = [];
  collect(blocks as LooseBlock[], lines);
  return lines.join("\n");
}
