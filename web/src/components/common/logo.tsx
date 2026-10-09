import { cn } from "@/lib/utils";

export function LogoMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-lg bg-foreground text-sm font-bold text-background",
        className,
      )}
    >
      H
    </span>
  );
}
