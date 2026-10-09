import { ChevronDown } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * Styled native <select>. Preferred for compact inline pickers (roles in member/permission rows):
 * best keyboard + screen-reader support and the OS picker on phones.
 */
export function NativeSelect({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <div className={cn("relative inline-flex w-fit", className)}>
      <select
        data-slot="native-select"
        className="h-11 w-full cursor-pointer appearance-none rounded-md border border-input bg-background py-1 pr-8 pl-3 text-base text-foreground shadow-xs transition-[color,box-shadow,border-color] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 md:h-8 md:text-sm"
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}
