import type { Metadata } from "next";
import { InviteRoute } from "@/components/auth/invite-route";

export const metadata: Metadata = { title: "Join workspace" };

export default function InvitePage() {
  return <InviteRoute />;
}
