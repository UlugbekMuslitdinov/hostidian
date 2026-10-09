"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { instanceInfoOptions } from "@/lib/api/queries";
import { AuthCard } from "./auth-card";
import { RegisterForm } from "./register-form";

/** Open sign-up (no invite). Only offered when the instance allows it. */
export function RegisterPage() {
  const router = useRouter();
  const info = useQuery(instanceInfoOptions());
  const needsSetup = info.data?.needsSetup === true;
  useEffect(() => {
    if (needsSetup) router.replace("/setup");
  }, [needsSetup, router]);

  if (info.data && !info.data.allowOpenSignup) {
    return (
      <AuthCard
        title="Sign-up is by invitation"
        description="Ask a workspace admin for an invite link to create an account."
      >
        <Button size="lg" className="w-full" asChild>
          <Link href="/login">Go to login</Link>
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Create your account"
      footer={
        <>
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-foreground underline-offset-4 hover:underline">
            Log in
          </Link>
        </>
      }
    >
      <RegisterForm />
    </AuthCard>
  );
}
