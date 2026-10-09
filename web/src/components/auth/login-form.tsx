"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { FormError, FormField } from "@/components/common/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api/client";
import { errorMessage, hasStatus, isNetworkError } from "@/lib/api/error";
import { qk } from "@/lib/api/keys";
import { instanceInfoOptions, meOptions } from "@/lib/api/queries";
import { unwrap } from "@/lib/api/unwrap";
import { validateEmail } from "@/lib/validation";
import { safeNextPath } from "@/lib/utils";
import { AuthCard } from "./auth-card";

export function LoginForm() {
  const router = useRouter();
  const qc = useQueryClient();
  const search = useSearchParams();
  const next = safeNextPath(search.get("next"));
  const callbackError = search.get("error");

  const info = useQuery(instanceInfoOptions());
  const me = useQuery(meOptions());

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);

  const needsSetup = info.data?.needsSetup === true;
  const signedIn = me.isSuccess;
  useEffect(() => {
    if (needsSetup) router.replace("/setup");
    else if (signedIn) router.replace(next);
  }, [needsSetup, signedIn, next, router]);

  const login = useMutation({
    mutationFn: (vars: { email: string; password: string }) => unwrap(api.POST("/auth/login", { body: vars })),
    meta: { skipAuthRedirect: true },
    onSuccess: (data) => {
      qc.setQueryData(qk.me(), data);
      router.replace(next);
    },
    onError: (error) => {
      if (hasStatus(error, 401)) setFormError("Incorrect email or password.");
      else if (hasStatus(error, 429)) setFormError("Too many attempts. Please wait a few minutes and try again.");
      else if (isNetworkError(error)) setFormError("Can't reach the server. Check your connection and try again.");
      else setFormError(errorMessage(error));
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const errors = {
      email: validateEmail(email) ?? undefined,
      password: password ? undefined : "Enter your password.",
    };
    setFieldErrors(errors);
    if (errors.email || errors.password) return;
    login.mutate({ email: email.trim(), password });
  };

  const oidc = info.data?.oidc;
  const oidcHref = `/api/auth/oidc/login?next=${encodeURIComponent(next)}`;

  return (
    <AuthCard
      title="Welcome back"
      description="Log in to your Hostidian workspace."
      footer={
        info.data?.allowOpenSignup ? (
          <>
            New here?{" "}
            <Link href="/register" className="font-medium text-foreground underline-offset-4 hover:underline">
              Create an account
            </Link>
          </>
        ) : (
          "Need an account? Ask a workspace admin for an invite link."
        )
      }
    >
      <form onSubmit={submit} className="grid gap-4" noValidate>
        <FormError
          message={formError ?? (callbackError ? `Single sign-on failed (${callbackError}). Try again.` : null)}
        />
        <FormField label="Email" error={fieldErrors.email}>
          {(p) => (
            <Input
              {...p}
              type="email"
              name="email"
              autoComplete="username"
              inputMode="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </FormField>
        <FormField label="Password" error={fieldErrors.password}>
          {(p) => (
            <Input
              {...p}
              type="password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </FormField>
        <Button type="submit" size="lg" disabled={login.isPending}>
          {login.isPending ? "Logging in…" : "Log in"}
        </Button>
      </form>

      {oidc?.enabled ? (
        <>
          <div className="my-4 flex items-center gap-3 text-xs text-muted-foreground" aria-hidden="true">
            <span className="h-px flex-1 bg-border" />
            or
            <span className="h-px flex-1 bg-border" />
          </div>
          <Button variant="outline" size="lg" className="w-full" asChild>
            {/* Full navigation: the API redirects to the identity provider. */}
            <a href={oidcHref}>
              <KeyRound /> {oidc.name || "Single sign-on"}
            </a>
          </Button>
        </>
      ) : null}
    </AuthCard>
  );
}
