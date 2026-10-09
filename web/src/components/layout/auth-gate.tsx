"use client";

import { useQuery } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { FullPageSpinner } from "@/components/common/spinner";
import { Button } from "@/components/ui/button";
import { instanceInfoOptions, meOptions } from "@/lib/api/queries";
import { hasStatus, isNetworkError } from "@/lib/api/error";
import { SessionProvider, wasIntentionalLogout } from "@/lib/session";

/**
 * Client-side auth gate for the whole (app) group. Deliberately no middleware/cookies(): the shell must
 * be renderable offline, so the decision is made in the browser from `/auth/me`.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const me = useQuery(meOptions());

  const unauthorized = hasStatus(me.error, 401);
  const info = useQuery({ ...instanceInfoOptions(), enabled: unauthorized });

  useEffect(() => {
    if (!unauthorized) return;
    if (!info.data && !info.isError) return; // still deciding between /setup and /login
    if (info.data?.needsSetup) {
      router.replace("/setup");
      return;
    }
    const here = window.location.pathname + window.location.search;
    const next = wasIntentionalLogout() || here === "/" ? "" : `?next=${encodeURIComponent(here)}`;
    router.replace(`/login${next}`);
    // `pathname` is a dependency so a session that dies on another route re-evaluates.
  }, [unauthorized, info.data, info.isError, router, pathname]);

  if (unauthorized) return <FullPageSpinner label="Redirecting to sign in…" />;
  if (me.data) return <SessionProvider me={me.data}>{children}</SessionProvider>;
  if (me.isError) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-3 px-6 text-center">
        <h1 className="text-lg font-semibold">
          {isNetworkError(me.error) ? "You appear to be offline" : "Couldn't load your account"}
        </h1>
        <p className="max-w-sm text-muted-foreground">
          {isNetworkError(me.error)
            ? "Hostidian can't reach the server right now. Check your connection and try again."
            : "The server returned an unexpected error. Please try again in a moment."}
        </p>
        <Button onClick={() => void me.refetch()}>Try again</Button>
      </main>
    );
  }
  return <FullPageSpinner />;
}
