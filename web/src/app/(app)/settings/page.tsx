import type { Metadata } from "next";
import { ProfileForm } from "@/components/settings/profile-form";

export const metadata: Metadata = { title: "Profile settings" };

export default function ProfileSettingsPage() {
  return <ProfileForm />;
}
