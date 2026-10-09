"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { FormError, FormField } from "@/components/common/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api/client";
import { errorMessage, hasStatus } from "@/lib/api/error";
import { qk } from "@/lib/api/keys";
import { instanceInfoOptions } from "@/lib/api/queries";
import { unwrap } from "@/lib/api/unwrap";
import {
  MIN_PASSWORD_LENGTH,
  validateEmail,
  validateName,
  validatePassword,
  validatePasswordConfirmation,
} from "@/lib/validation";
import { AuthCard } from "./auth-card";

type Errors = Partial<Record<"name" | "email" | "password" | "confirm" | "workspace", string>>;

/** First-run: create the instance admin and the first workspace. */
export function SetupForm() {
  const router = useRouter();
  const qc = useQueryClient();
  const info = useQuery(instanceInfoOptions());
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [workspaceName, setWorkspaceName] = useState("My Workspace");
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const alreadySetUp = info.data?.needsSetup === false;
  useEffect(() => {
    if (alreadySetUp) router.replace("/login");
  }, [alreadySetUp, router]);

  const setup = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/setup", {
          body: { name: name.trim(), email: email.trim(), password, workspaceName: workspaceName.trim() || undefined },
        }),
      ),
    meta: { skipAuthRedirect: true },
    onSuccess: (me) => {
      qc.setQueryData(qk.me(), me);
      void qc.invalidateQueries({ queryKey: qk.instance() });
      router.replace("/");
    },
    onError: (error) => {
      if (hasStatus(error, 409)) {
        setFormError("This instance has already been set up. Log in instead.");
        void qc.invalidateQueries({ queryKey: qk.instance() });
      } else setFormError(errorMessage(error));
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
      workspace: workspaceName.trim().length > 100 ? "Use at most 100 characters." : undefined,
    };
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    setup.mutate();
  };

  return (
    <AuthCard
      title="Set up Hostidian"
      description="Create the administrator account and your first workspace. You'll only do this once."
    >
      <form onSubmit={submit} className="grid gap-4" noValidate>
        <FormError message={formError} />
        <FormField label="Your name" error={errors.name}>
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
        <FormField label="Email" error={errors.email}>
          {(p) => (
            <Input
              {...p}
              type="email"
              name="email"
              autoComplete="email"
              inputMode="email"
              value={email}
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
        <FormField label="Workspace name" error={errors.workspace}>
          {(p) => (
            <Input {...p} name="workspace" value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} />
          )}
        </FormField>
        <Button type="submit" size="lg" disabled={setup.isPending}>
          {setup.isPending ? "Setting up…" : "Create administrator"}
        </Button>
      </form>
    </AuthCard>
  );
}
