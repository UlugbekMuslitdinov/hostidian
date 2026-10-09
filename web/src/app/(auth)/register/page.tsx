import type { Metadata } from "next";
import { RegisterPage } from "@/components/auth/register-page";

export const metadata: Metadata = { title: "Create account" };

export default function Register() {
  return <RegisterPage />;
}
