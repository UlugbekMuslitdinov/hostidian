"use client";

import { Shuffle, SmilePlus, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { EmojiPickerPanel } from "./emoji-picker";

const RANDOM_ICONS = ["📄", "📝", "📚", "💡", "🚀", "🎯", "🗂️", "🧠", "🌱", "⭐", "🔖", "🧭", "🛠️", "🎨", "📌", "☕"];

/** Emoji picker in a popover. `children` is the trigger (a button). */
export function IconPicker({
  value,
  onChange,
  children,
  align = "start",
}: {
  value: string | null | undefined;
  onChange: (icon: string | null) => void;
  children: ReactNode;
  align?: "start" | "center" | "end";
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} className="w-[min(21rem,calc(100vw-1rem))] p-0">
        <div className="flex items-center justify-between gap-2 border-b px-2 py-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onChange(RANDOM_ICONS[Math.floor(Math.random() * RANDOM_ICONS.length)] ?? "📄");
              setOpen(false);
            }}
          >
            <Shuffle /> Random
          </Button>
          {value ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
            >
              <X /> Remove
            </Button>
          ) : (
            <span className="flex items-center gap-1.5 pr-2 text-xs text-muted-foreground">
              <SmilePlus className="size-4" /> Pick an icon
            </span>
          )}
        </div>
        <EmojiPickerPanel
          onSelect={(emoji) => {
            onChange(emoji);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
