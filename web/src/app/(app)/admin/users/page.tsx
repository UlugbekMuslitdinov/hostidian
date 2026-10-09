import type { Metadata } from "next";
import { AdminUsers } from "@/components/settings/admin-panels";

export const metadata: Metadata = { title: "Users · Admin" };

export default function AdminUsersPage() {
  return <AdminUsers />;
}
