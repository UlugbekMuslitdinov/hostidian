"use client";

import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { FormError, FormField } from "@/components/common/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api/client";
import { errorMessage, hasStatus } from "@/lib/api/error";
import { unwrapVoid } from "@/lib/api/unwrap";
import { MIN_PASSWORD_LENGTH, validatePassword, validatePasswordConfirmation } from "@/lib/validation";
import { AuthCard } from "./auth-card";

export function ResetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);

  const reset = useMutation({
    mutationFn: () => unwrapVoid(api.POST("/auth/password-reset/confirm", { body: { token, newPassword: password } })),
    meta: { skipAuthRedirect: true },
    onError: (error) => {
      if (hasStatus(error, 404)) setInvalid(true);
      else setFormError(errorMessage(error));
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const next = {
      password: validatePassword(password) ?? undefined,
      confirm: validatePasswordConfirmation(password, confirm) ?? undefined,
    };
    setErrors(next);
    if (next.password || next.confirm) return;
    reset.mutate();
  };

  if (reset.isSuccess) {
    return (
      <AuthCard
        title="Password updated"
        description="You can now log in with your new password. Other devices were signed out."
      >
        <Button size="lg" className="w-full" asChild>
          <Link href="/login">Go to login</Link>
        </Button>
      </AuthCard>
    );
  }

  if (invalid) {
    return (
      <AuthCard title="Link expired" description="This password reset link is invalid or has expired.">
        <p className="text-sm text-muted-foreground">Ask an administrator to generate a new reset link for you.</p>
        <Button variant="outline" size="lg" className="mt-4 w-full" asChild>
          <Link href="/login">Back to login</Link>
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Choose a new password" description="Pick something long and unique.">
      <form onSubmit={submit} className="grid gap-4" noValidate>
        <FormError message={formError} />
        <FormField label="New password" error={errors.password} hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}>
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="new-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </FormField>
        <FormField label="Confirm new password" error={errors.confirm}>
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          )}
        </FormField>
        <Button type="submit" size="lg" disabled={reset.isPending}>
          {reset.isPending ? "Saving…" : "Set new password"}
        </Button>
      </form>
    </AuthCard>
  );
}
