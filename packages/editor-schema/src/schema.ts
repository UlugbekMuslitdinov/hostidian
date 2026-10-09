import {
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  type InlineContent,
  type PartialInlineContent,
} from "@blocknote/core";
import { createCalloutBlockSpec, pageLinkSpec } from "./specs";

/** BlockNote schema = default blocks + `callout` block + `pageLink` inline content. */
export const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    callout: createCalloutBlockSpec(),
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    pageLink: pageLinkSpec,
  },
});

export type HSchema = typeof schema;
export type HBlock = typeof schema.Block;
export type HPartialBlock = typeof schema.PartialBlock;
export type HInlineContent = InlineContent<typeof schema.inlineContentSchema, typeof schema.styleSchema>;
export type HPartialInlineContent = PartialInlineContent<
  typeof schema.inlineContentSchema,
  typeof schema.styleSchema
>;
