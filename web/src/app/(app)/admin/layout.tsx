"use client";

import type { ReactNode } from "react";
import { Forbidden } from "@/components/common/forbidden";
import { TopBar } from "@/components/layout/topbar";
import { SettingsShell } from "@/components/settings/settings-shell";
import { useSession } from "@/lib/session";

// Instance admins only. The API enforces this too (403); this just avoids showing a broken page.
export default function AdminLayout({ children }: { children: ReactNode }) {
  const { user } = useSession();
  if (!user.isInstanceAdmin) {
    return (
      <>
        <TopBar />
        <Forbidden message="Only instance administrators can open this area." />
      </>
    );
  }
  return (
    <SettingsShell area="admin" title="Instance admin">
      {children}
    </SettingsShell>
  );
}
