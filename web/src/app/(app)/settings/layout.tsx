"use client";

import type { ReactNode } from "react";
import { SettingsShell } from "@/components/settings/settings-shell";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <SettingsShell area="settings" title="Settings">
      {children}
    </SettingsShell>
  );
}
