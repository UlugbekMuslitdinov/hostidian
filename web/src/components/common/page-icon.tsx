import { FileText } from "lucide-react";
import { cn } from "@/lib/utils";

/** A page's emoji icon, or the default document glyph. */
export function PageIcon({
  icon,
  className,
  emojiClassName,
}: {
  icon: string | null | undefined;
  className?: string;
  emojiClassName?: string;
}) {
  if (icon) {
    return (
      <span
        aria-hidden="true"
        className={cn("inline-flex w-fit shrink-0 items-center justify-center leading-none", emojiClassName)}
      >
        {icon}
      </span>
    );
  }
  return <FileText aria-hidden="true" className={cn("size-4 shrink-0 text-muted-foreground", className)} />;
}
