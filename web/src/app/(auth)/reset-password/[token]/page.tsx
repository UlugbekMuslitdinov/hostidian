import type { Metadata } from "next";
import { ResetPasswordRoute } from "@/components/auth/reset-password-route";

export const metadata: Metadata = { title: "Reset password" };

export default function ResetPasswordPage() {
  return <ResetPasswordRoute />;
}
