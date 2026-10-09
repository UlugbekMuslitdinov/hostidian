/**
 * Structural, schema-agnostic views of BlockNote blocks/inline content.
 *
 * The transforms walk and rewrite documents generically (including shapes that exist only transiently, like
 * placeholder tokens), so they work on these loose types and cast at the public boundary.
 */
export interface LooseInline {
  type: string;
  text?: string;
  styles?: Record<string, unknown>;
  props?: Record<string, unknown>;
  href?: string;
  content?: LooseInline[];
}

export interface LooseTableCell {
  type: "tableCell";
  props?: Record<string, unknown>;
  content: LooseInline[];
}

export interface LooseTableContent {
  type: "tableContent";
  columnWidths?: unknown[];
  headerRows?: number;
  headerCols?: number;
  rows: { cells: (LooseInline[] | LooseTableCell)[] }[];
}

export interface LooseBlock {
  id?: string;
  type: string;
  props?: Record<string, unknown>;
  /** `LooseInline[]` for inline blocks, `LooseTableContent` for tables, undefined for atomic blocks. */
  content?: LooseInline[] | LooseTableContent;
  children?: LooseBlock[];
}

export function isTableContent(content: LooseBlock["content"]): content is LooseTableContent {
  return !!content && !Array.isArray(content) && content.type === "tableContent";
}

/** Returns a copy of `block` with `fn` applied to every inline array it owns (inline content or table cells). */
export function mapInlineArrays(
  block: LooseBlock,
  fn: (items: LooseInline[]) => LooseInline[],
): LooseBlock {
  const { content } = block;
  if (Array.isArray(content)) return { ...block, content: fn(content) };
  if (isTableContent(content)) {
    return {
      ...block,
      content: {
        ...content,
        rows: content.rows.map((row) => ({
          ...row,
          cells: row.cells.map((cell) =>
            Array.isArray(cell) ? fn(cell) : { ...cell, content: fn(cell.content) },
          ),
        })),
      },
    };
  }
  return block;
}

/** Visits every inline array a block owns, in reading order. */
export function forEachInlineArray(block: LooseBlock, fn: (items: LooseInline[]) => void): void {
  const { content } = block;
  if (Array.isArray(content)) {
    fn(content);
  } else if (isTableContent(content)) {
    for (const row of content.rows) {
      for (const cell of row.cells) fn(Array.isArray(cell) ? cell : cell.content);
    }
  }
}
