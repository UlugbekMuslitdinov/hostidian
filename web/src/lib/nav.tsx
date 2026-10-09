"use client";

import { useRouter, usePathname } from "next/navigation";
import { forwardRef, useCallback, type ComponentProps, type MouseEvent } from "react";

/**
 * Navigation inside a workspace (/w/<slug>, /w/<slug>/p/<id>, /w/<slug>/trash) is *shallow*: all three
 * route files render the same client component (<WorkspaceRoutes/>) which picks the view from the URL, and
 * we move between them with the history API instead of the Next.js router (supported by Next:
 * pushState/replaceState sync with usePathname()).
 *
 * Why: a router navigation fetches an RSC payload from the server. That fails offline, and a page created
 * offline has never been seen by the server, so "open the page I just created" couldn't work without this.
 * With shallow routing, moving between workspace views needs no network at all.
 *
 * Everything else (settings, admin, auth, `/`) keeps using the real router.
 */

export type RouteInfo =
  | { kind: "home"; slug: string }
  | { kind: "page"; slug: string; pageId: string }
  | { kind: "trash"; slug: string }
  | { kind: "other" };

const WORKSPACE_RE = /^\/w\/([^/]+)(?:\/(?:p\/([^/]+)|(trash)))?\/?$/;

export function parseRoute(pathname: string): RouteInfo {
  const path = pathname.split(/[?#]/, 1)[0] ?? "";
  const m = WORKSPACE_RE.exec(path);
  if (!m) return { kind: "other" };
  const slug = safeDecode(m[1]!);
  if (m[2]) return { kind: "page", slug, pageId: safeDecode(m[2]) };
  if (m[3]) return { kind: "trash", slug };
  return { kind: "home", slug };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The current route, derived from the URL (not from Next's matched route params, which shallow routing leaves stale). */
export function useRoute(): RouteInfo {
  return parseRoute(usePathname());
}

/** Can we get from the current URL to `href` without asking the server for anything? */
export function isShallowNavigation(currentPath: string, href: string): boolean {
  return parseRoute(currentPath).kind !== "other" && parseRoute(href).kind !== "other";
}

export interface NavigateOptions {
  replace?: boolean;
}

export function useAppNavigate() {
  const router = useRouter();
  return useCallback(
    (href: string, options: NavigateOptions = {}) => {
      if (isShallowNavigation(window.location.pathname, href)) {
        if (options.replace) window.history.replaceState(null, "", href);
        else window.history.pushState(null, "", href);
        return;
      }
      if (options.replace) router.replace(href);
      else router.push(href);
    },
    [router],
  );
}

/** Drop-in for next/link for in-app links; keeps new-tab / modifier-click behaviour. */
export const AppLink = forwardRef<
  HTMLAnchorElement,
  Omit<ComponentProps<"a">, "href"> & { href: string; replace?: boolean; prefetch?: boolean }
>(function AppLink({ href, replace, onClick, prefetch, ...props }, ref) {
  void prefetch; // accepted for call-site compatibility with next/link; nothing is prefetched
  const navigate = useAppNavigate();
  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (
      e.defaultPrevented ||
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey ||
      (props.target && props.target !== "_self") ||
      props.download !== undefined
    ) {
      return;
    }
    e.preventDefault();
    navigate(href, { replace });
  };
  return <a ref={ref} href={href} onClick={handleClick} {...props} />;
});
