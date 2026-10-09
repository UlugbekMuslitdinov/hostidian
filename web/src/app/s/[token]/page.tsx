import type { Metadata } from "next";
import { PublicPageView } from "@/components/public/public-page-view";

// Top-level `/s` (not inside the `(app)` group), so the client-side AuthGate never wraps it.
export const metadata: Metadata = { title: "Shared page" };

export default async function SharedRootPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PublicPageView token={token} />;
}
