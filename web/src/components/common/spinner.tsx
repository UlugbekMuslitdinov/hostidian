import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <span role="status" className="inline-flex items-center">
      <Loader2 className={cn("size-4 animate-spin text-muted-foreground", className)} aria-hidden="true" />
      <span className="sr-only">{label ?? "Loading"}</span>
    </span>
  );
}

export function FullPageSpinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <Spinner className="size-5" label={label} />
    </div>
  );
}
