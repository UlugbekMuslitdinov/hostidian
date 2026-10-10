"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, ShieldCheck, ShieldOff, UserCheck, UserPlus, UserX } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/common/copy-button";
import { FormError, FormField } from "@/components/common/form-field";
import { OnlineOnly } from "@/components/pwa/online-only";
import { UserAvatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { api } from "@/lib/api/client";
import { errorMessage, hasStatus } from "@/lib/api/error";
import { qk } from "@/lib/api/keys";
import { adminSettingsOptions, adminUsersOptions } from "@/lib/api/queries";
import { unwrap } from "@/lib/api/unwrap";
import { useSession } from "@/lib/session";
import { formatDateTime, formatRelative, useNow } from "@/lib/time";
import { absoluteUrl } from "@/lib/utils";
import { validateName } from "@/lib/validation";
import { AddUserDialog } from "./add-user-dialog";
import type { AdminUserType } from "./admin-types";
import { SettingsSection } from "./settings-shell";

export function AdminUsers() {
  useDocumentTitle("Users · Admin");
  const { user: me } = useSession();
  const qc = useQueryClient();
  const now = useNow();
  const query = useQuery(adminUsersOptions());
  const [resetFor, setResetFor] = useState<AdminUserType | null>(null);
  const [adding, setAdding] = useState(false);

  const update = useMutation({
    mutationFn: (vars: { id: string; disabled?: boolean; isInstanceAdmin?: boolean }) =>
      unwrap(
        api.PATCH("/admin/users/{userId}", {
          params: { path: { userId: vars.id } },
          body: {
            ...(vars.disabled !== undefined ? { disabled: vars.disabled } : {}),
            ...(vars.isInstanceAdmin !== undefined ? { isInstanceAdmin: vars.isInstanceAdmin } : {}),
          },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.adminUsers() }),
    onError: (e) =>
      toast.error("Couldn't update the user", {
        description: hasStatus(e, 409) ? "You can't demote or disable the last admin (or yourself)." : errorMessage(e),
      }),
  });

  return (
    <SettingsSection title="Users" description="Everyone with an account on this instance.">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="min-w-0 flex-1 basis-60 text-[13px] text-muted-foreground">
          Create an account yourself, or send an invite link from a workspace&apos;s settings. Hostidian never sends
          email.
        </p>
        <OnlineOnly reason="Adding users needs a connection">
          <Button onClick={() => setAdding(true)}>
            <UserPlus /> Add user
          </Button>
        </OnlineOnly>
      </div>
      {query.isPending ? (
        <div className="grid gap-2" aria-busy="true">
          <Skeleton className="h-14" />
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
          {query.data.map((u) => {
            const self = u.id === me.id;
            const disabled = Boolean(u.disabledAt);
            return (
              <li key={u.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-3">
                <UserAvatar name={u.name} color={u.avatarColor} className="size-9 text-xs" />
                <div className="min-w-0 flex-1 basis-52">
                  <p className="flex flex-wrap items-center gap-1.5 font-medium">
                    <span className="truncate">{u.name}</span>
                    {self && <span className="font-normal text-muted-foreground">(you)</span>}
                    {u.isInstanceAdmin && <Badge variant="primary">Admin</Badge>}
                    {disabled && <Badge variant="destructive">Disabled</Badge>}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{u.email}</p>
                  <p className="text-xs text-muted-foreground">
                    {u.workspaceCount} workspace{u.workspaceCount === 1 ? "" : "s"} · joined{" "}
                    {formatDateTime(u.createdAt)}
                    {u.lastSeenAt ? ` · seen ${formatRelative(u.lastSeenAt, now || Date.parse(u.lastSeenAt))}` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Button variant="outline" size="sm" onClick={() => setResetFor(u)}>
                    <KeyRound /> Reset link
                  </Button>
                  {!self && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={update.isPending}
                        onClick={() => update.mutate({ id: u.id, isInstanceAdmin: !u.isInstanceAdmin })}
                      >
                        {u.isInstanceAdmin ? <ShieldOff /> : <ShieldCheck />}
                        {u.isInstanceAdmin ? "Remove admin" : "Make admin"}
                      </Button>
                      <Button
                        variant={disabled ? "outline" : "destructive-ghost"}
                        size="sm"
                        disabled={update.isPending}
                        onClick={() => update.mutate({ id: u.id, disabled: !disabled })}
                      >
                        {disabled ? <UserCheck /> : <UserX />}
                        {disabled ? "Enable" : "Disable"}
                      </Button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <ResetLinkDialog user={resetFor} onClose={() => setResetFor(null)} />
      <AddUserDialog open={adding} onOpenChange={setAdding} />
    </SettingsSection>
  );
}

function ResetLinkDialog({ user, onClose }: { user: AdminUserType | null; onClose: () => void }) {
  const create = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.POST("/admin/users/{userId}/reset-link", { params: { path: { userId: id } } })),
    onError: (e) => toast.error("Couldn't create the reset link", { description: errorMessage(e) }),
  });
  const { mutate, reset } = create;

  useEffect(() => {
    if (user) mutate(user.id);
    else reset();
  }, [user, mutate, reset]);

  return (
    <Dialog open={user !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Password reset link</DialogTitle>
          <DialogDescription>
            Send this one-time link to {user?.name}. It lets them choose a new password and signs them out everywhere.
          </DialogDescription>
        </DialogHeader>
        {create.isPending || (!create.data && !create.isError) ? (
          <Skeleton className="h-11" />
        ) : create.isError ? (
          <FormError message={errorMessage(create.error)} />
        ) : (
          <div className="grid gap-2">
            <div className="flex gap-2">
              <Input
                readOnly
                value={absoluteUrl(create.data.url)}
                aria-label="Reset link"
                onFocus={(e) => e.currentTarget.select()}
              />
              <CopyButton value={absoluteUrl(create.data.url)} size="default" />
            </div>
            <p className="text-xs text-muted-foreground">Valid until {formatDateTime(create.data.expiresAt)}.</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function AdminInstanceSettings() {
  useDocumentTitle("Instance settings · Admin");
  const qc = useQueryClient();
  const query = useQuery(adminSettingsOptions());
  const [name, setName] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);

  const update = useMutation({
    mutationFn: (body: { instanceName?: string; allowOpenSignup?: boolean; allowWorkspaceCreation?: boolean }) =>
      unwrap(api.PATCH("/admin/settings", { body })),
    onSuccess: (data) => {
      qc.setQueryData(qk.adminSettings(), data);
      void qc.invalidateQueries({ queryKey: qk.instance() });
      toast.success("Settings saved");
    },
    onError: (e) => toast.error("Couldn't save settings", { description: errorMessage(e) }),
  });

  if (query.isPending) return <Skeleton className="h-40" />;
  if (query.isError) {
    return (
      <div className="grid gap-2">
        <FormError message={errorMessage(query.error)} />
        <Button variant="outline" className="w-fit" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  const settings = query.data;
  const nameValue = name ?? settings.instanceName;

  const submitName = (e: FormEvent) => {
    e.preventDefault();
    const err = validateName(nameValue, "an instance name");
    setNameError(err);
    if (err) return;
    update.mutate({ instanceName: nameValue.trim() }, { onSuccess: () => setName(null) });
  };

  return (
    <>
      <SettingsSection title="Instance" description="Shown on the login page.">
        <form onSubmit={submitName} className="grid max-w-md gap-3" noValidate>
          <FormField label="Instance name" error={nameError}>
            {(p) => <Input {...p} value={nameValue} maxLength={100} onChange={(e) => setName(e.target.value)} />}
          </FormField>
          <Button
            type="submit"
            className="w-fit"
            disabled={update.isPending || nameValue.trim() === settings.instanceName}
          >
            Save name
          </Button>
        </form>
      </SettingsSection>

      <SettingsSection title="Access" description="Who can join and create things on this instance.">
        <div className="grid max-w-xl gap-5">
          <ToggleRow
            id="open-signup"
            label="Open sign-up"
            description="Anyone who can reach this server can create an account. When off, accounts need an invite link."
            checked={settings.allowOpenSignup}
            disabled={update.isPending}
            onChange={(allowOpenSignup) => update.mutate({ allowOpenSignup })}
          />
          <ToggleRow
            id="workspace-creation"
            label="Allow everyone to create workspaces"
            description="When off, only instance admins can create new workspaces."
            checked={settings.allowWorkspaceCreation}
            disabled={update.isPending}
            onChange={(allowWorkspaceCreation) => update.mutate({ allowWorkspaceCreation })}
          />
        </div>
      </SettingsSection>
    </>
  );
}

function ToggleRow({
  id,
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="grid gap-1">
        <Label htmlFor={id} className="text-sm">
          {label}
        </Label>
        <p id={`${id}-desc`} className="text-[13px] text-muted-foreground">
          {description}
        </p>
      </div>
      <Switch
        id={id}
        aria-describedby={`${id}-desc`}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    </div>
  );
}
