"use client";

import { cloneElement, isValidElement, type MouseEvent, type ReactElement } from "react";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useOnline } from "@/lib/offline/context";
import { cn } from "@/lib/utils";

/**
 * Wraps a control that only works with a server round trip (sharing, invites, admin, ...). Online it renders
 * the control untouched. Offline it is disabled and the reason shows in a tooltip (and as a toast when tapped,
 * because touch screens have no hover).
 *
 * The control itself is disabled (so keyboard and assistive tech get the right state); a focusable wrapper
 * carries the tooltip because disabled buttons swallow pointer events.
 */
export function OnlineOnly({
  reason,
  className,
  children,
}: {
  /** Why it is unavailable, e.g. "Sharing needs a connection". */
  reason: string;
  /** Classes for the wrapper that exists while offline (e.g. the responsive visibility of the control). */
  className?: string;
  children: ReactElement<{ disabled?: boolean; onClick?: unknown; "aria-disabled"?: boolean; tabIndex?: number }>;
}) {
  const online = useOnline();
  if (online || !isValidElement(children)) return children;

  const explain = (event: MouseEvent) => {
    event.preventDefault();
    toast.info(reason);
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className={cn("inline-flex", className)} onClick={explain} data-offline-disabled="">
          {cloneElement(children, { disabled: true, "aria-disabled": true, tabIndex: -1, onClick: undefined })}
          <span className="sr-only">{reason}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}
