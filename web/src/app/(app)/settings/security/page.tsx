import type { Metadata } from "next";
import { SecurityPanel } from "@/components/settings/security-panel";

export const metadata: Metadata = { title: "Security settings" };

export default function SecuritySettingsPage() {
  return <SecurityPanel />;
}
