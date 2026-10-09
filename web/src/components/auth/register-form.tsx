"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { FormError, FormField } from "@/components/common/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api/client";
import { errorMessage, hasStatus, isApiError } from "@/lib/api/error";
import { qk } from "@/lib/api/keys";
import { unwrap } from "@/lib/api/unwrap";
import {
  MIN_PASSWORD_LENGTH,
  validateEmail,
  validateName,
  validatePassword,
  validatePasswordConfirmation,
} from "@/lib/validation";

type Errors = Partial<Record<"name" | "email" | "password" | "confirm", string>>;

/** Sign-up form, with an invite token (invite page) or without (open signup). */
export function RegisterForm({
  inviteToken,
  lockedEmail,
  submitLabel = "Create account",
}: {
  inviteToken?: string;
  /** Invite restricted to one email: prefilled and not editable. */
  lockedEmail?: string | null;
  submitLabel?: string;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [email, setEmail] = useState(lockedEmail ?? "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const register = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/auth/register", {
          body: { name: name.trim(), email: email.trim(), password, ...(inviteToken ? { inviteToken } : {}) },
        }),
      ),
    meta: { skipAuthRedirect: true },
    onSuccess: (me) => {
      qc.setQueryData(qk.me(), me);
      router.replace("/");
    },
    onError: (error) => {
      if (isApiError(error) && error.details) {
        setErrors({
          name: error.details.name,
          email: error.details.email,
          password: error.details.password,
        });
      }
      if (hasStatus(error, 409)) setFormError("An account with that email already exists. Try logging in instead.");
      else if (hasStatus(error, 403))
        setFormError("This invite link or sign-up isn't valid anymore. Ask for a new invite.");
      else setFormError(errorMessage(error));
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const next: Errors = {
      name: validateName(name) ?? undefined,
      email: validateEmail(email) ?? undefined,
      password: validatePassword(password) ?? undefined,
      confirm: validatePasswordConfirmation(password, confirm) ?? undefined,
    };
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    register.mutate();
  };

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      <FormError message={formError} />
      <FormField label="Name" error={errors.name}>
        {(p) => (
          <Input
            {...p}
            name="name"
            autoComplete="name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </FormField>
      <FormField
        label="Email"
        error={errors.email}
        hint={lockedEmail ? "This invite is for this email address." : undefined}
      >
        {(p) => (
          <Input
            {...p}
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            value={email}
            readOnly={Boolean(lockedEmail)}
            onChange={(e) => setEmail(e.target.value)}
          />
        )}
      </FormField>
      <FormField label="Password" error={errors.password} hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}>
        {(p) => (
          <Input
            {...p}
            type="password"
            name="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        )}
      </FormField>
      <FormField label="Confirm password" error={errors.confirm}>
        {(p) => (
          <Input
            {...p}
            type="password"
            name="confirm"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        )}
      </FormField>
      <Button type="submit" size="lg" disabled={register.isPending}>
        {register.isPending ? "Creating account…" : submitLabel}
      </Button>
    </form>
  );
}
