"use client";

import { Check, ImagePlus, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { COVER_PRESETS } from "@/lib/covers";
import { cn } from "@/lib/utils";

/** Preset gradient/colour covers. The page stores the preset id (see lib/covers.ts). */
export function CoverPicker({
  value,
  onChange,
  children,
}: {
  value: string | null | undefined;
  onChange: (cover: string | null) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="end" className="w-[min(20rem,calc(100vw-1rem))]">
        <div className="mb-2 flex items-center justify-between">
          <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <ImagePlus className="size-4" /> Choose a cover
          </p>
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
          ) : null}
        </div>
        <div role="radiogroup" aria-label="Cover" className="grid grid-cols-5 gap-2">
          {COVER_PRESETS.map((preset) => {
            const selected = preset.id === value;
            return (
              <button
                key={preset.id}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={preset.label}
                title={preset.label}
                onClick={() => {
                  onChange(preset.id);
                  setOpen(false);
                }}
                style={{ background: preset.background }}
                className={cn(
                  "relative grid aspect-[4/3] min-h-11 place-items-center rounded-md border border-black/10 transition-transform hover:scale-[1.04] md:min-h-0",
                  selected && "ring-2 ring-ring ring-offset-2 ring-offset-popover",
                )}
              >
                {selected ? <Check className="size-4 text-white drop-shadow" /> : null}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
