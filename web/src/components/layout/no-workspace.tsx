"use client";

import Link from "next/link";
import { LogoMark } from "@/components/common/logo";
import { CreateWorkspaceForm } from "@/components/sidebar/create-workspace-dialog";
import { Button } from "@/components/ui/button";
import { useLogout, useSession } from "@/lib/session";

/** Shown when the signed-in user belongs to no workspace yet. */
export function NoWorkspace() {
  const { user } = useSession();
  const logout = useLogout();

  return (
    <div className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center gap-6 px-6 py-12 pt-safe pb-safe">
      <div className="flex flex-col items-center gap-3 text-center">
        <LogoMark className="size-10 text-lg" />
        <h1 className="text-xl font-semibold tracking-tight">Welcome, {user.name.split(" ")[0]}</h1>
        <p className="text-muted-foreground">
          You&apos;re not a member of any workspace yet. Create one to get started, or ask an administrator for an
          invite link.
        </p>
      </div>
      <div className="rounded-xl border bg-card p-5 shadow-xs">
        <CreateWorkspaceForm />
      </div>
      <div className="flex justify-center gap-2">
        <Button variant="ghost" asChild>
          <Link href="/settings">Account settings</Link>
        </Button>
        <Button variant="ghost" onClick={() => void logout()}>
          Log out
        </Button>
      </div>
    </div>
  );
}
