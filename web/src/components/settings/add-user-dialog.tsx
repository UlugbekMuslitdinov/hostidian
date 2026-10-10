"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, UserPlus } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { CopyButton } from "@/components/common/copy-button";
import { FormError, FormField } from "@/components/common/form-field";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { api } from "@/lib/api/client";
import { ApiError, errorMessage, hasStatus } from "@/lib/api/error";
import { qk } from "@/lib/api/keys";
import { unwrap } from "@/lib/api/unwrap";
import { useOnline } from "@/lib/offline/context";
import { canManageWorkspace, WORKSPACE_ROLE_LABELS } from "@/lib/permissions";
import { useSession } from "@/lib/session";
import { formatDateTime } from "@/lib/time";
import { absoluteUrl } from "@/lib/utils";
import { validateEmail, validateName, validatePassword } from "@/lib/validation";
import type { components } from "@hostidian/api-types";

type InviteRole = components["schemas"]["InviteRole"];
type AdminCreatedUser = components["schemas"]["AdminCreatedUser"];

const MEMBERSHIP_ROLES: readonly InviteRole[] = ["member", "guest", "admin"];

interface FieldErrors {
  name?: string;
  email?: string;
  password?: string;
}

export function AddUserDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The form is mounted only while open, so every opening starts from a blank state. */}
      <DialogContent className="sm:max-w-xl">
        <AddUserBody onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function AddUserBody({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const online = useOnline();
  const { workspaces } = useSession();
  // Only workspaces the admin manages can be targeted (the server enforces the same rule).
  const manageable = workspaces.filter((m) => canManageWorkspace(m.role));

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isInstanceAdmin, setIsInstanceAdmin] = useState(false);
  const [selected, setSelected] = useState<Record<string, InviteRole>>({});
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ result: AdminCreatedUser; workspaceCount: number } | null>(null);
  const adminId = useId();

  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/admin/users", {
          body: {
            name: name.trim(),
            email: email.trim(),
            ...(password ? { password } : {}),
            ...(isInstanceAdmin ? { isInstanceAdmin: true } : {}),
            ...(Object.keys(selected).length > 0
              ? { memberships: Object.entries(selected).map(([workspaceId, role]) => ({ workspaceId, role })) }
              : {}),
          },
        }),
      ),
    onSuccess: async (result) => {
      setCreated({ result, workspaceCount: Object.keys(selected).length });
      await qc.invalidateQueries({ queryKey: qk.adminUsers() });
      for (const workspaceId of Object.keys(selected)) {
        void qc.invalidateQueries({ queryKey: qk.members(workspaceId) });
      }
    },
    onError: (e) => {
      if (hasStatus(e, 409)) setErrors({ email: "An account with this email already exists." });
      else if (hasStatus(e, 422)) {
        const details = e instanceof ApiError ? e.details : undefined;
        const mapped: FieldErrors = { name: details?.name, email: details?.email, password: details?.password };
        if (mapped.name || mapped.email || mapped.password) setErrors(mapped);
        else setFormError(errorMessage(e));
      } else if (hasStatus(e, 404)) {
        // The server answers 404 (not 403) for a workspace the caller doesn't own or administer.
        setFormError("One of the selected workspaces can't be found, or you can't manage it. Untick it and try again.");
      } else if (hasStatus(e, 403)) setFormError("Only instance admins can create accounts.");
      else if (hasStatus(e, 501)) setFormError("Creating users isn't available on this server yet. Update it and try again.");
      else setFormError(errorMessage(e));
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    const found: FieldErrors = {
      name: validateName(name, "their name") ?? undefined,
      email: validateEmail(email) ?? undefined,
      password: password ? (validatePassword(password) ?? undefined) : undefined,
    };
    setErrors(found);
    if (found.name || found.email || found.password) return;
    create.mutate();
  };

  const reset = () => {
    setName("");
    setEmail("");
    setPassword("");
    setIsInstanceAdmin(false);
    setSelected({});
    setErrors({});
    setFormError(null);
    setCreated(null);
    create.reset();
  };

  if (created) return <CreatedView {...created} onAnother={reset} onClose={onClose} />;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add user</DialogTitle>
        <DialogDescription>
          Create an account without an invite. Hostidian doesn&apos;t send email, so you pass the sign-in details on
          yourself.
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} noValidate className="grid gap-4">
        <FormError message={formError} />
        <FormField label="Name" error={errors.name}>
          {(p) => (
            <Input {...p} value={name} maxLength={100} autoComplete="off" onChange={(e) => setName(e.target.value)} />
          )}
        </FormField>
        <FormField label="Email" error={errors.email}>
          {(p) => (
            <Input
              {...p}
              type="email"
              value={email}
              autoComplete="off"
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </FormField>
        <FormField
          label="Password (optional)"
          error={errors.password}
          hint="At least 10 characters. Leave empty to generate a set-password link they open to choose their own."
        >
          {(p) => (
            <Input
              {...p}
              type="password"
              value={password}
              maxLength={200}
              autoComplete="new-password"
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </FormField>

        <div className="flex items-start gap-3">
          <input
            id={adminId}
            type="checkbox"
            checked={isInstanceAdmin}
            aria-describedby={`${adminId}-desc`}
            onChange={(e) => setIsInstanceAdmin(e.target.checked)}
            className="mt-0.5 size-5 shrink-0 cursor-pointer accent-primary md:size-4"
          />
          <div className="grid gap-0.5">
            <label htmlFor={adminId} className="cursor-pointer text-sm font-medium">
              Instance admin
            </label>
            <p id={`${adminId}-desc`} className="text-[13px] text-muted-foreground">
              Can manage every user and the instance settings.
            </p>
          </div>
        </div>

        {manageable.length > 0 && (
          <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0">
            <legend className="mb-1 text-[13px] font-medium">Add to workspaces (optional)</legend>
            <ul className="divide-y rounded-lg border">
              {manageable.map(({ workspace, role: myRole }) => {
                const role = selected[workspace.id];
                const checked = role !== undefined;
                return (
                  <li key={workspace.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
                    <label className="flex min-h-11 min-w-0 flex-1 basis-40 cursor-pointer items-center gap-3 text-sm md:min-h-8">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) =>
                          setSelected((prev) => {
                            const next = { ...prev };
                            if (e.target.checked) next[workspace.id] = "member";
                            else delete next[workspace.id];
                            return next;
                          })
                        }
                        className="size-5 shrink-0 cursor-pointer accent-primary md:size-4"
                      />
                      <span className="truncate">{workspace.name}</span>
                    </label>
                    <NativeSelect
                      aria-label={`Role in ${workspace.name}`}
                      value={role ?? "member"}
                      disabled={!checked}
                      onChange={(e) => setSelected((prev) => ({ ...prev, [workspace.id]: e.target.value as InviteRole }))}
                    >
                      {MEMBERSHIP_ROLES.filter((r) => r !== "admin" || myRole === "owner").map((r) => (
                        <option key={r} value={r}>
                          {WORKSPACE_ROLE_LABELS[r]}
                        </option>
                      ))}
                    </NativeSelect>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        )}

        {online ? null : (
          <p role="status" className="text-[13px] text-muted-foreground">
            You&apos;re offline. Adding a user needs a connection.
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending || !online}>
            <UserPlus /> {create.isPending ? "Creating…" : "Create user"}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

function CreatedView({
  result,
  workspaceCount,
  onAnother,
  onClose,
}: {
  result: AdminCreatedUser;
  workspaceCount: number;
  onAnother: () => void;
  onClose: () => void;
}) {
  const { user, setPasswordUrl, setPasswordExpiresAt } = result;
  const link = setPasswordUrl ? absoluteUrl(setPasswordUrl) : null;

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <span className="flex size-6 items-center justify-center rounded-full bg-success/15 text-success">
            <Check className="size-4" aria-hidden="true" />
          </span>
          Account created
        </DialogTitle>
        <DialogDescription>
          {user.name} ({user.email}) now has an account
          {workspaceCount > 0 ? ` and was added to ${workspaceCount} workspace${workspaceCount === 1 ? "" : "s"}` : ""}.
        </DialogDescription>
      </DialogHeader>

      {link ? (
        <div className="grid gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3.5" data-testid="set-password-link">
          <p className="text-sm font-medium">Send {user.name} this set-password link</p>
          <p className="text-[13px] text-muted-foreground">
            No email was sent. They open the link to choose a password, then sign in. It works once
            {setPasswordExpiresAt ? ` and expires ${formatDateTime(setPasswordExpiresAt)}` : ""}.
          </p>
          <div className="flex flex-wrap gap-2">
            <Input
              readOnly
              autoFocus
              value={link}
              aria-label="Set-password link"
              className="basis-52 flex-1 font-mono text-[13px]"
              onFocus={(e) => e.currentTarget.select()}
            />
            <CopyButton value={link} label="Copy link" size="default" variant="secondary" />
          </div>
        </div>
      ) : (
        <p className="rounded-lg border bg-muted/40 p-3.5 text-sm text-muted-foreground">
          {user.name} can sign in right away with the password you set. Pass it on through a safe channel.
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onAnother}>
          Add another user
        </Button>
        <Button type="button" onClick={onClose}>
          Done
        </Button>
      </DialogFooter>
    </>
  );
}
