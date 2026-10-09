import type { Metadata } from "next";
import { PublicPageView } from "@/components/public/public-page-view";

// Descendant of a shared page; reachable only when the share has `includeSubpages` (otherwise the API
// returns 404 and the view shows "This link is unavailable").
export const metadata: Metadata = { title: "Shared page" };

export default async function SharedSubpage({ params }: { params: Promise<{ token: string; pageId: string }> }) {
  const { token, pageId } = await params;
  return <PublicPageView token={token} pageId={pageId} />;
}
