"use client";

import { Avatar as AvatarPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn, initials } from "@/lib/utils";

export function Avatar({ className, ...props }: ComponentProps<typeof AvatarPrimitive.Root>) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      className={cn("relative flex size-8 shrink-0 overflow-hidden rounded-full", className)}
      {...props}
    />
  );
}

export function AvatarImage({ className, ...props }: ComponentProps<typeof AvatarPrimitive.Image>) {
  return <AvatarPrimitive.Image className={cn("aspect-square size-full", className)} {...props} />;
}

export function AvatarFallback({ className, ...props }: ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarPrimitive.Fallback
      className={cn("flex size-full items-center justify-center rounded-full bg-muted text-xs font-medium", className)}
      {...props}
    />
  );
}

function relativeLuminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG contrast ratio between two relative luminances. */
function contrast(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** White, soft black or pure black: the first that reaches WCAG AA (4.5:1) on `hex`. */
export function readableTextColor(hex: string): string {
  const lum = relativeLuminance(hex);
  if (lum === null) return "#ffffff";
  if (contrast(lum, 1) >= 4.5) return "#ffffff";
  if (contrast(lum, relativeLuminance("#1a1a1a")!) >= 4.5) return "#1a1a1a";
  return "#000000";
}

/** Avatar for a Hostidian user: initials on the user's chosen colour. */
export function UserAvatar({ name, color, className }: { name: string; color: string; className?: string }) {
  return (
    <Avatar className={className} title={name}>
      <AvatarFallback
        style={{ backgroundColor: color, color: readableTextColor(color) }}
        className="text-[0.8em] font-semibold"
      >
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  );
}
