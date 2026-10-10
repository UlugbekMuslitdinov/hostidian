"use client";

import { cn } from "@/lib/utils";
import { LOCAL_GRAPH_MAX_DEPTH } from "./graph-model";

/** Segmented 1 / 2 / 3 "links away" control for the local graph. */
export function DepthPicker({ depth, onChange, className }: { depth: number; onChange: (depth: number) => void; className?: string }) {
  const options = Array.from({ length: LOCAL_GRAPH_MAX_DEPTH }, (_, index) => index + 1);
  return (
    <div role="group" aria-label="Links away from this page" className={cn("inline-flex items-center gap-1 text-xs text-muted-foreground", className)}>
      <span>Depth</span>
      <div className="inline-flex overflow-hidden rounded-md border">
        {options.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={depth === value}
            onClick={() => onChange(value)}
            className={cn(
              "min-h-8 min-w-8 px-2 text-xs transition-colors md:min-h-6 md:min-w-6",
              depth === value ? "bg-accent font-medium text-foreground" : "hover:bg-accent/60",
            )}
          >
            {value}
          </button>
        ))}
      </div>
    </div>
  );
}
