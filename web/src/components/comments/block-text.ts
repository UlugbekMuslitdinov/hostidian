/**
 * Plain text of a BlockNote block (inline content, links, page links, table cells), used as the "quote"
 * of a comment thread. Loosely typed on purpose: it accepts BlockNote's block objects as well as the
 * opaque JSON the API stores.
 */

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

function inlineText(items: unknown): string {
  if (!Array.isArray(items)) return "";
  let out = "";
  for (const item of items) {
    if (typeof item === "string") out += item;
    else if (isObject(item)) {
      if (item.type === "text" && typeof item.text === "string") out += item.text;
      else if (item.type === "link") out += inlineText(item.content);
      else if (item.type === "pageLink" && isObject(item.props) && typeof item.props.title === "string") out += item.props.title;
    }
  }
  return out;
}

export function blockText(block: unknown): string {
  if (!isObject(block)) return "";
  const { content } = block;
  if (Array.isArray(content)) return inlineText(content);
  if (isObject(content) && content.type === "tableContent" && Array.isArray(content.rows)) {
    const rows: string[] = [];
    for (const row of content.rows) {
      if (!isObject(row) || !Array.isArray(row.cells)) continue;
      rows.push(
        row.cells
          .map((cell) => (Array.isArray(cell) ? inlineText(cell) : isObject(cell) ? inlineText(cell.content) : ""))
          .join(" | "),
      );
    }
    return rows.join(" / ");
  }
  if (isObject(block.props) && typeof block.props.name === "string" && block.props.name) return block.props.name;
  if (isObject(block.props) && typeof block.props.caption === "string" && block.props.caption) return block.props.caption;
  return "";
}
