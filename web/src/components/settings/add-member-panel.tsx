"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { FormError, FormField } from "@/components/common/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { api } from "@/lib/api/client";
import { errorMessage, hasStatus } from "@/lib/api/error";
import { qk } from "@/lib/api/keys";
import { unwrap } from "@/lib/api/unwrap";
import { useOnline } from "@/lib/offline/context";
import { WORKSPACE_ROLE_LABELS } from "@/lib/permissions";
import { validateEmail } from "@/lib/validation";
import type { components, WorkspaceRole } from "@hostidian/api-types";

type InviteRole = components["schemas"]["InviteRole"];

/** What the "create an invite link instead" shortcut hands to the Invites section. */
export interface InviteDraft {
  email: string;
  role: InviteRole;
}

type Problem = { kind: "not-found" } | { kind: "member" } | { kind: "other"; message: string };

/**
 * Add an existing account to the workspace by email. There is no user directory (by design), so the email has to
 * be typed; an unknown address falls back to an invite link.
 */
export function AddMemberPanel({
  workspaceId,
  actorRole,
  onClose,
  onNeedInvite,
}: {
  workspaceId: string;
  actorRole: WorkspaceRole;
  onClose: () => void;
  onNeedInvite: (draft: InviteDraft) => void;
}) {
  const qc = useQueryClient();
  const online = useOnline();
  const emailRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InviteRole>("member");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const roles = (["member", "guest", "admin"] as const).filter((r) => r !== "admin" || actorRole === "owner");

  const add = useMutation({
    mutationFn: (vars: { email: string; role: InviteRole }) =>
      unwrap(
        api.POST("/workspaces/{workspaceId}/members", {
          params: { path: { workspaceId } },
          body: { email: vars.email, role: vars.role },
        }),
      ),
    onSuccess: (member, vars) => {
      setAdded(`${member.user.name} (${member.user.email}) was added as ${WORKSPACE_ROLE_LABELS[vars.role]}.`);
      setEmail("");
      void qc.invalidateQueries({ queryKey: qk.members(workspaceId) });
      emailRef.current?.focus();
    },
    onError: (e) => {
      if (hasStatus(e, 404)) setProblem({ kind: "not-found" });
      else if (hasStatus(e, 409)) setProblem({ kind: "member" });
      else if (hasStatus(e, 403)) setProblem({ kind: "other", message: "You don't have permission to add that role." });
      else if (hasStatus(e, 501)) {
        setProblem({ kind: "other", message: "Adding members isn't available on this server yet. Update it and try again." });
      } else setProblem({ kind: "other", message: errorMessage(e) });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setAdded(null);
    setProblem(null);
    const err = validateEmail(email);
    setEmailError(err);
    if (err) return;
    add.mutate({ email: email.trim(), role });
  };

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label="Add member"
      className="mb-5 grid max-w-xl gap-3 rounded-xl border bg-muted/30 p-4"
    >
      <p className="text-[13px] text-muted-foreground">
        Add someone who already has an account on this instance. They get access straight away — no email is sent.
        For a new person, create an invite link below.
      </p>
      {problem?.kind === "other" && <FormError message={problem.message} />}
      {problem?.kind === "member" && <FormError message="That person is already a member of this workspace." />}
      {problem?.kind === "not-found" && (
        <div role="alert" className="grid gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2.5 text-[13px]">
          <p>
            No account with that email — <strong className="font-medium">create an invite link instead</strong> and
            send it to them.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() => onNeedInvite({ email: email.trim(), role })}
          >
            Create an invite link
          </Button>
        </div>
      )}
      {added && (
        <p role="status" className="text-[13px] text-success">
          {added}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <FormField label="Email" error={emailError} className="min-w-48 flex-1">
          {(p) => (
            <Input
              {...p}
              ref={emailRef}
              type="email"
              value={email}
              autoComplete="off"
              autoFocus
              placeholder="name@example.com"
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </FormField>
        <FormField label="Role">
          {(p) => (
            <NativeSelect {...p} value={role} onChange={(e) => setRole(e.target.value as InviteRole)}>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {WORKSPACE_ROLE_LABELS[r]}
                </option>
              ))}
            </NativeSelect>
          )}
        </FormField>
        <div className="flex gap-2">
          <Button type="submit" disabled={add.isPending || !online}>
            {add.isPending ? "Adding…" : "Add member"}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </form>
  );
}
