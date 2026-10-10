import type { Metadata } from "next";
import { TokensPanel } from "@/components/settings/tokens-panel";

export const metadata: Metadata = { title: "Access tokens" };

export default function TokensSettingsPage() {
  return <TokensPanel />;
}
