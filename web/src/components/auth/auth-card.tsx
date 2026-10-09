"use client";

import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { LogoMark } from "@/components/common/logo";
import { instanceInfoOptions } from "@/lib/api/queries";

export function AuthCard({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const info = useQuery(instanceInfoOptions());
  return (
    <div className="w-full max-w-[400px]">
      <div className="mb-6 flex flex-col items-center gap-3 text-center">
        <LogoMark className="size-11 text-lg" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description ? <p className="mt-1.5 text-muted-foreground">{description}</p> : null}
        </div>
      </div>
      <div className="rounded-xl border bg-card p-5 shadow-xs md:p-6">{children}</div>
      {footer ? <div className="mt-4 text-center text-sm text-muted-foreground">{footer}</div> : null}
      {info.data ? (
        <p className="mt-8 text-center text-xs text-muted-foreground">
          {info.data.instanceName} · Hostidian {info.data.version}
        </p>
      ) : null}
    </div>
  );
}
