"use client";

import { KeyRound, Lock, ShieldCheck, SlidersHorizontal, User, WifiOff } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, type ReactNode, type Ref } from "react";
import { TopBar } from "@/components/layout/topbar";
import { useOnline } from "@/lib/offline/context";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

const settingsLinks = [
  { href: "/settings", label: "Profile", icon: User },
  { href: "/settings/security", label: "Security", icon: Lock },
  { href: "/settings/workspace", label: "Workspace", icon: SlidersHorizontal },
  { href: "/settings/tokens", label: "Access tokens", icon: KeyRound },
] as const;

const adminLinks = [
  { href: "/admin/users", label: "Users", icon: User },
  { href: "/admin/settings", label: "Instance", icon: ShieldCheck },
] as const;

export function SettingsShell({
  area,
  title,
  children,
}: {
  area: "settings" | "admin";
  title: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const { user } = useSession();
  const online = useOnline();
  const links = area === "settings" ? settingsLinks : adminLinks;
  const navRef = useRef<HTMLElement>(null);

  // On a phone the tab row scrolls sideways; keep the current section in view.
  useEffect(() => {
    const nav = navRef.current;
    const el = nav?.querySelector<HTMLElement>("[aria-current=page]");
    if (nav && el && nav.scrollWidth > nav.clientWidth) {
      nav.scrollLeft += el.getBoundingClientRect().left - nav.getBoundingClientRect().left - 16;
    }
  }, [pathname]);

  return (
    <>
      <TopBar>
        <span className="truncate px-1.5 text-[13px] font-medium">
          {area === "admin" ? "Instance admin" : "Settings"}
        </span>
      </TopBar>
      <div className="mx-auto w-full max-w-4xl px-5 pb-20 pl-[max(1.25rem,env(safe-area-inset-left))] pr-[max(1.25rem,env(safe-area-inset-right))] md:px-10">
        <h1 className="pt-6 pb-4 text-2xl font-semibold tracking-tight md:pt-10">{title}</h1>
        <div className="flex flex-col gap-6 md:flex-row md:gap-10">
          <nav
            ref={navRef}
            aria-label={area === "admin" ? "Admin sections" : "Settings sections"}
            className="no-scrollbar -mx-1 flex shrink-0 gap-1 overflow-x-auto px-1 md:mx-0 md:w-44 md:flex-col md:overflow-visible md:px-0"
          >
            {links.map(({ href, label, icon: Icon }) => {
              const active = pathname === href;
              return (
                <Link
                  key={href}
                  href={href}
                  prefetch={false}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex min-h-11 shrink-0 items-center gap-2 rounded-md px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:min-h-8",
                    active && "bg-accent font-medium text-foreground",
                  )}
                >
                  <Icon className="size-4" aria-hidden="true" />
                  {label}
                </Link>
              );
            })}
            {area === "settings" && user.isInstanceAdmin && (
              <Link
                href="/admin/users"
                prefetch={false}
                className="flex min-h-11 shrink-0 items-center gap-2 rounded-md px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:mt-4 md:min-h-8"
              >
                <ShieldCheck className="size-4" aria-hidden="true" />
                Instance admin
              </Link>
            )}
            {area === "admin" && (
              <Link
                href="/settings"
                prefetch={false}
                className="flex min-h-11 shrink-0 items-center gap-2 rounded-md px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:mt-4 md:min-h-8"
              >
                <User className="size-4" aria-hidden="true" />
                My settings
              </Link>
            )}
          </nav>
          <div className="min-w-0 flex-1">
            {online ? null : (
              <p
                role="status"
                data-testid="settings-offline-note"
                className="mb-5 flex items-start gap-2 rounded-md border bg-muted/50 px-3 py-2.5 text-sm text-muted-foreground"
              >
                <WifiOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>
                  You&apos;re offline.{" "}
                  {area === "admin"
                    ? "Instance administration needs a connection."
                    : "Account, security, workspace, invite and access-token settings need a connection to be saved."}
                </span>
              </p>
            )}
            {/* A disabled fieldset disables every form control inside it, which is exactly "read-only while offline". */}
            <fieldset disabled={!online} className="m-0 min-w-0 border-0 p-0">
              {children}
            </fieldset>
          </div>
        </div>
      </div>
    </>
  );
}

export function SettingsSection({
  title,
  description,
  children,
  className,
  ref,
  id,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  ref?: Ref<HTMLElement>;
  id?: string;
}) {
  return (
    <section ref={ref} id={id} className={cn("scroll-mt-20 border-b py-6 first:pt-0 last:border-b-0", className)}>
      <div className="mb-4">
        <h2 className="text-base font-semibold">{title}</h2>
        {description ? <p className="mt-0.5 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}
