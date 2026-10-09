import type { Metadata } from "next";
import { AdminInstanceSettings } from "@/components/settings/admin-panels";

export const metadata: Metadata = { title: "Instance settings · Admin" };

export default function AdminSettingsPage() {
  return <AdminInstanceSettings />;
}
