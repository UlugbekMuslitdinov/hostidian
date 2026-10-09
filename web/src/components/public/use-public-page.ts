"use client";

import { useCallback, useEffect, useState } from "react";
import type { PublicPage } from "@hostidian/api-types";
import { api } from "@/lib/api/client";
import { unwrap } from "@/lib/api/unwrap";

export type PublicPageState =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; data: PublicPage };

/**
 * Loads a public share page. Root (`/public/{token}/page`) and descendant
 * (`/public/{token}/pages/{pageId}`) endpoints both need no session. The result is fetched after mount
 * so the server render and the first client render are identical (no hydration mismatch); callers key
 * this hook by token+pageId so a route change starts from a fresh "loading" state.
 */
export function usePublicPage(token: string, pageId?: string) {
  const [state, setState] = useState<PublicPageState>({ status: "loading" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const data: PublicPage = pageId
          ? await unwrap(api.GET("/public/{token}/pages/{pageId}", { params: { path: { token, pageId } } }))
          : await unwrap(api.GET("/public/{token}/page", { params: { path: { token } } }));
        if (!cancelled) setState({ status: "ready", data });
      } catch (error) {
        if (!cancelled) setState({ status: "error", error });
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [token, pageId, nonce]);

  const reload = useCallback(() => {
    setState({ status: "loading" });
    setNonce((n) => n + 1);
  }, []);

  return { state, reload };
}
