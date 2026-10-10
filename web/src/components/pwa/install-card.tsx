"use client";

import { Download, Share } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useInstallSnapshot } from "@/lib/offline/context";
import { dismissInstallCard, installCardKind, promptInstall } from "@/lib/offline/install";
import { LogoMark } from "@/components/common/logo";

/**
 * Invites the user to install the app: the browser's own prompt where it exists (Chromium), and the manual
 * "Share, then Add to Home Screen" instructions on iOS, where Safari offers no API for it. Dismissal is remembered.
 */
export function InstallCard() {
  const snapshot = useInstallSnapshot();
  // Fixed per mount: the card must not flicker away when the cooldown ticks over while it is on screen.
  const [now] = useState(() => Date.now());
  const kind = installCardKind({ ...snapshot, now });
  if (!kind) return null;

  return (
    <section
      aria-label="Install Hostidian"
      data-testid="install-card"
      data-install-kind={kind}
      className="mb-1 rounded-lg border bg-card p-3 text-sm text-card-foreground shadow-xs"
    >
      <div className="flex items-start gap-2.5">
        <LogoMark className="size-8 shrink-0 text-sm" />
        <div className="min-w-0 space-y-1">
          <p className="font-medium">Install Hostidian</p>
          {kind === "prompt" ? (
            <p className="text-muted-foreground">Open it like an app and keep your pages available offline.</p>
          ) : (
            <p className="text-muted-foreground">
              Tap <Share className="mx-0.5 inline size-3.5 -translate-y-px" aria-label="Share" /> in Safari, then{" "}
              <strong className="font-medium text-foreground">Add to Home Screen</strong>.
            </p>
          )}
        </div>
      </div>
      <div className="mt-2.5 flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={() => dismissInstallCard()}>
          {kind === "prompt" ? "Not now" : "Got it"}
        </Button>
        {kind === "prompt" ? (
          <Button size="sm" onClick={() => void promptInstall()}>
            <Download aria-hidden="true" />
            Install
          </Button>
        ) : null}
      </div>
    </section>
  );
}
