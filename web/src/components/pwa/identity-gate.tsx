"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Me } from "@hostidian/api-types";
import { FullPageSpinner } from "@/components/common/spinner";
import { useOptionalOfflineRuntime } from "@/lib/offline/context";

/**
 * Makes sure the offline data on this device belongs to the user who is signed in.
 *
 * Same account: renders at once. First account on the device: renders at once and takes ownership. A different
 * account than the one whose data is cached (signed in after a session expired, or after a failed logout
 * cleanup): nothing renders until that data is wiped, so the new user can never see the previous user's page
 * titles, queued edits or documents.
 */
export function IdentityGate({ me, children }: { me: Me; children: ReactNode }) {
  const runtime = useOptionalOfflineRuntime();
  const userId = me.user.id;
  // Decided once per user, before the first paint of their data.
  const mustWipe = useMemo(() => runtime?.peekIdentity(userId) === "switch", [runtime, userId]);
  const [settledFor, setSettledFor] = useState<string | null>(null);

  useEffect(() => {
    if (!runtime) return;
    let current = true;
    void runtime.identify(me).then(
      () => current && setSettledFor(userId),
      () => current && setSettledFor(userId), // a failed wipe must not lock the user out; cleanup reports its own errors
    );
    return () => {
      current = false;
    };
  }, [runtime, me, userId]);

  if (mustWipe && settledFor !== userId) return <FullPageSpinner label="Switching account…" />;
  return children;
}
