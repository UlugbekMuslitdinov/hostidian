"use client";

import { useParams } from "next/navigation";
import { ResetPasswordForm } from "./reset-password-form";

export function ResetPasswordRoute() {
  const { token } = useParams<{ token: string }>();
  return <ResetPasswordForm token={decodeURIComponent(token)} />;
}
