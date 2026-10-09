import type { BlockNoteEditor } from "@blocknote/core";
import { schema } from "@hostidian/editor-schema/react";

/**
 * The editor instance type used by the page editor, the discussion menu and the block comment button.
 * Derived from the shared schema so every consumer agrees on the block/inline/style types.
 */
export type HEditor = BlockNoteEditor<
  typeof schema.blockSchema,
  typeof schema.inlineContentSchema,
  typeof schema.styleSchema
>;
