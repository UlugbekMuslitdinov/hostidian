import type { Metadata } from "next";
import { GithubPanel } from "@/components/settings/github-panel";

export const metadata: Metadata = { title: "GitHub sync" };

export default function GithubSettingsPage() {
  return <GithubPanel />;
}
