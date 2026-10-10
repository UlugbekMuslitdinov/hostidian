import type { Metadata } from "next";
import { PublicPageView } from "@/components/public/public-page-view";

// Top-level `/s` (not inside the `(app)` group), so the client-side AuthGate never wraps it.
// Share links are capabilities: keep them out of search indexes and out of `Referer` headers sent to other sites.
export const metadata: Metadata = {
  title: "Shared page",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default async function SharedRootPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PublicPageView token={token} />;
}
