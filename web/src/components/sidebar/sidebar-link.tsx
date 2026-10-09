import type { ComponentProps, ReactNode } from "react";
import { AppLink } from "@/lib/nav";
import { cn } from "@/lib/utils";

const base =
  "flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-[14px] text-sidebar-foreground/85 transition-colors hover:bg-sidebar-accent focus-visible:-outline-offset-2 md:min-h-[30px] [&_svg]:size-[18px] [&_svg]:shrink-0 [&_svg]:text-muted-foreground";

export function SidebarLink({
  active,
  icon,
  children,
  className,
  ...props
}: Omit<ComponentProps<typeof AppLink>, "children"> & { active?: boolean; icon: ReactNode; children: ReactNode }) {
  return (
    <AppLink
      aria-current={active ? "page" : undefined}
      className={cn(base, active && "bg-sidebar-accent font-medium text-sidebar-foreground", className)}
      {...props}
    >
      {icon}
      <span className="truncate">{children}</span>
    </AppLink>
  );
}

export function SidebarButton({
  icon,
  children,
  hint,
  className,
  ...props
}: Omit<ComponentProps<"button">, "children"> & { icon: ReactNode; children: ReactNode; hint?: string }) {
  return (
    <button type="button" className={cn(base, className)} {...props}>
      {icon}
      <span className="truncate">{children}</span>
      {hint ? (
        <kbd className="ml-auto font-sans text-[11px] tracking-wide text-muted-foreground [@media(hover:none)]:hidden">
          {hint}
        </kbd>
      ) : null}
    </button>
  );
}
