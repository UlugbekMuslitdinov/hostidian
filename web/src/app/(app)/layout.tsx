import type { ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { AuthGate } from "@/components/layout/auth-gate";

// No middleware, no cookies(): the whole authenticated area is a client-side shell so the PWA can
// render it offline. Access control is enforced by the API; AuthGate only decides what to *show*.
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGate>
      <AppShell>{children}</AppShell>
    </AuthGate>
  );
}
