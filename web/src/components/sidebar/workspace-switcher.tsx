"use client";

import { Check, ChevronsUpDown, LogOut, Monitor, Moon, Plus, Settings, ShieldCheck, Sun } from "lucide-react";
import Link from "next/link";
import { useTheme } from "next-themes";
import { useState } from "react";
import { UserAvatar } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useOnline } from "@/lib/offline/context";
import { AppLink } from "@/lib/nav";
import { useLogout, useSession } from "@/lib/session";
import { cn, workspaceHref } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import { CreateWorkspaceDialog } from "./create-workspace-dialog";

export function WorkspaceBadge({ name, icon, className }: { name: string; icon?: string | null; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-foreground/90 text-[13px] font-semibold text-background",
        icon && "bg-transparent text-base",
        className,
      )}
    >
      {icon || Array.from(name.trim())[0]?.toUpperCase() || "W"}
    </span>
  );
}

export function WorkspaceSwitcher() {
  const { workspace, memberships } = useWorkspace();
  const { user } = useSession();
  const logout = useLogout();
  const { theme, setTheme } = useTheme();
  const [createOpen, setCreateOpen] = useState(false);
  const online = useOnline();

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm font-medium transition-colors hover:bg-sidebar-accent data-[state=open]:bg-sidebar-accent md:min-h-8"
          >
            <WorkspaceBadge name={workspace.name} icon={workspace.icon} />
            <span className="truncate">{workspace.name}</span>
            <ChevronsUpDown className="ml-auto size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="sr-only">Switch workspace or open account menu</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel className="flex items-center gap-2 py-2">
            <UserAvatar name={user.name} color={user.avatarColor} className="size-6" />
            <span className="min-w-0">
              <span className="block truncate text-foreground">{user.name}</span>
              <span className="block truncate font-normal">{user.email}</span>
            </span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
          {memberships.map((m) => (
            <DropdownMenuItem key={m.workspace.id} asChild>
              <AppLink href={workspaceHref(m.workspace.slug)}>
                <WorkspaceBadge name={m.workspace.name} icon={m.workspace.icon} className="size-5 text-[11px]" />
                <span className="truncate">{m.workspace.name}</span>
                {m.workspace.id === workspace.id && <Check className="ml-auto size-4" />}
              </AppLink>
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem disabled={!online} onSelect={() => setCreateOpen(true)}>
            <Plus />
            Create workspace
            {!online && <span className="ml-auto text-xs text-muted-foreground">Needs connection</span>}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href="/settings">
              <Settings />
              Settings
            </Link>
          </DropdownMenuItem>
          {user.isInstanceAdmin &&
            (online ? (
              <DropdownMenuItem asChild>
                <Link href="/admin/users">
                  <ShieldCheck />
                  Instance admin
                </Link>
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem disabled>
                <ShieldCheck />
                Instance admin
                <span className="ml-auto text-xs text-muted-foreground">Needs connection</span>
              </DropdownMenuItem>
            ))}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Sun className="dark:hidden" />
              <Moon className="hidden dark:block" />
              Theme
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup value={theme ?? "system"} onValueChange={setTheme}>
                <DropdownMenuRadioItem value="system">
                  <Monitor className="mr-1 size-4" /> System
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="light">
                  <Sun className="mr-1 size-4" /> Light
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="dark">
                  <Moon className="mr-1 size-4" /> Dark
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void logout()}>
            <LogOut />
            Log out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateWorkspaceDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
