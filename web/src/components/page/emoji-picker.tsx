"use client";

import { EmojiPicker } from "frimousse";

/**
 * frimousse downloads its emoji data from a CDN unless told where it lives. The data (emojibase-data, `en` locale)
 * is served from public/emoji instead (refresh it with `pnpm -F @hostidian/web emoji`): self-hosted installs make
 * no third-party requests, and the service worker precaches it, so the picker also works offline.
 */
const EMOJIBASE_URL = "/emoji";

export function EmojiPickerPanel({ onSelect }: { onSelect: (emoji: string) => void }) {
  return (
    <EmojiPicker.Root
      onEmojiSelect={({ emoji }) => onSelect(emoji)}
      emojibaseUrl={EMOJIBASE_URL}
      columns={9}
      className="isolate flex h-[340px] w-full flex-col"
    >
      <EmojiPicker.Search
        autoFocus
        aria-label="Search emoji"
        placeholder="Search emoji…"
        className="mx-2 mt-2 h-10 rounded-md border bg-background px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25 md:h-9 md:text-sm"
      />
      <EmojiPicker.Viewport className="relative flex-1 outline-hidden">
        <EmojiPicker.Loading className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          Loading emoji…
        </EmojiPicker.Loading>
        <EmojiPicker.Empty className="absolute inset-0 flex items-center justify-center px-4 text-center text-sm text-muted-foreground">
          No emoji found.
        </EmojiPicker.Empty>
        <EmojiPicker.List
          className="pb-2 select-none"
          components={{
            CategoryHeader: ({ category, ...props }) => (
              <div className="bg-popover px-3 pt-3 pb-1.5 text-xs font-medium text-muted-foreground" {...props}>
                {category.label}
              </div>
            ),
            Row: ({ children, ...props }) => (
              <div className="scroll-my-1.5 px-1.5" {...props}>
                {children}
              </div>
            ),
            Emoji: ({ emoji, ...props }) => (
              <button
                type="button"
                className="flex size-8 items-center justify-center rounded-md text-xl data-[active]:bg-accent"
                {...props}
              >
                {emoji.emoji}
              </button>
            ),
          }}
        />
      </EmojiPicker.Viewport>
    </EmojiPicker.Root>
  );
}
