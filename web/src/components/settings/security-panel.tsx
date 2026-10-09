"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Laptop } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { FormError, FormField } from "@/components/common/form-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api/client";
import { errorMessage, hasStatus } from "@/lib/api/error";
import { qk } from "@/lib/api/keys";
import { sessionsOptions } from "@/lib/api/queries";
import { unwrapVoid } from "@/lib/api/unwrap";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useSession } from "@/lib/session";
import { formatRelative, useNow } from "@/lib/time";
import { describeUserAgent } from "@/lib/user-agent";
import { MIN_PASSWORD_LENGTH, validatePassword, validatePasswordConfirmation } from "@/lib/validation";
import { SettingsSection } from "./settings-shell";

export function SecurityPanel() {
  useDocumentTitle("Security settings");
  return (
    <>
      <ChangePassword />
      <Sessions />
    </>
  );
}

function ChangePassword() {
  const { user } = useSession();
  const qc = useQueryClient();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Partial<Record<"current" | "next" | "confirm", string>>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const change = useMutation({
    mutationFn: () =>
      unwrapVoid(
        api.POST("/auth/password", {
          body: { newPassword: next, ...(user.hasPassword ? { currentPassword: current } : {}) },
        }),
      ),
    meta: { skipAuthRedirect: true },
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setConfirm("");
      toast.success("Password changed", { description: "Your other sessions were signed out." });
      void qc.invalidateQueries({ queryKey: qk.sessions() });
      void qc.invalidateQueries({ queryKey: qk.me() });
    },
    onError: (e) => {
      if (hasStatus(e, 401)) setErrors({ current: "That password is incorrect." });
      else setFormError(errorMessage(e));
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const found = {
      current: user.hasPassword && !current ? "Enter your current password." : undefined,
      next: validatePassword(next) ?? undefined,
      confirm: validatePasswordConfirmation(next, confirm) ?? undefined,
    };
    setErrors(found);
    if (found.current || found.next || found.confirm) return;
    change.mutate();
  };

  return (
    <SettingsSection
      title={user.hasPassword ? "Change password" : "Set a password"}
      description={
        user.hasPassword
          ? "Changing your password signs you out everywhere else."
          : "Your account uses single sign-on. You can add a password to log in without it."
      }
    >
      <form onSubmit={submit} className="grid max-w-md gap-4" noValidate>
        <FormError message={formError} />
        {user.hasPassword && (
          <FormField label="Current password" error={errors.current}>
            {(p) => (
              <Input
                {...p}
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            )}
          </FormField>
        )}
        <FormField label="New password" error={errors.next} hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}>
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
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
        <Button type="submit" className="w-fit" disabled={change.isPending}>
          {change.isPending ? "Saving…" : "Update password"}
        </Button>
      </form>
    </SettingsSection>
  );
}

function Sessions() {
  const qc = useQueryClient();
  const now = useNow();
  const query = useQuery(sessionsOptions());
  const revoke = useMutation({
    mutationFn: (id: string) =>
      unwrapVoid(api.DELETE("/auth/sessions/{sessionId}", { params: { path: { sessionId: id } } })),
    onSuccess: () => {
      toast.success("Session signed out");
      return qc.invalidateQueries({ queryKey: qk.sessions() });
    },
    onError: (e) => toast.error("Couldn't sign out that session", { description: errorMessage(e) }),
  });

  return (
    <SettingsSection title="Active sessions" description="Devices currently signed in to your account.">
      {query.isPending ? (
        <div className="grid gap-2" aria-busy="true">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : query.isError ? (
        <div className="grid gap-2">
          <FormError message={errorMessage(query.error)} />
          <Button variant="outline" className="w-fit" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        <ul className="divide-y rounded-xl border">
          {query.data.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 px-3.5 py-3">
              <Laptop className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0 flex-1 basis-48">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {describeUserAgent(s.userAgent)}
                  {s.current && <Badge variant="success">This device</Badge>}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {s.ip || "Unknown IP"} · active {formatRelative(s.lastSeenAt, now || Date.parse(s.lastSeenAt))}
                </p>
              </div>
              {!s.current && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(s.id)}
                  aria-label={`Sign out ${describeUserAgent(s.userAgent)} session`}
                >
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}
