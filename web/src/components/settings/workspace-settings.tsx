"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut, Trash2, UserMinus, UserPlus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/common/copy-button";
import { EmptyState } from "@/components/common/empty-state";
import { FormError, FormField } from "@/components/common/form-field";
import { IconPicker } from "@/components/page/icon-picker";
import { OnlineOnly } from "@/components/pwa/online-only";
import { WorkspaceBadge } from "@/components/sidebar/workspace-switcher";
import { ImportExportSection } from "@/components/transfer/transfer-panel";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { UserAvatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { api } from "@/lib/api/client";
import { errorMessage, hasStatus } from "@/lib/api/error";
import { qk } from "@/lib/api/keys";
import { membersOptions, workspaceInvitesOptions } from "@/lib/api/queries";
import { unwrap, unwrapVoid } from "@/lib/api/unwrap";
import {
  assignableWorkspaceRoles,
  canDeleteWorkspace,
  canInviteMembers,
  canManageMembers,
  canManageWorkspace,
  canModifyMember,
  WORKSPACE_ROLE_LABELS,
} from "@/lib/permissions";
import { useOnline } from "@/lib/offline/context";
import { useSession } from "@/lib/session";
import { SLUG_PATTERN } from "@/lib/slug";
import { formatDateTime } from "@/lib/time";
import { absoluteUrl, cn, copyToClipboard, workspaceHref } from "@/lib/utils";
import { validateName } from "@/lib/validation";
import { useOptionalWorkspace } from "@/lib/workspace";
import type { components, Member, WorkspaceRole } from "@hostidian/api-types";

type InviteRole = components["schemas"]["InviteRole"];
import { AddMemberPanel, type InviteDraft } from "./add-member-panel";
import { SettingsSection } from "./settings-shell";

export function WorkspaceSettings() {
  const ws = useOptionalWorkspace();
  useDocumentTitle("Workspace settings");
  if (!ws) {
    return <EmptyState title="No workspace selected" description="Create or join a workspace to manage it here." />;
  }
  return (
    <WorkspaceSections />
  );
}

function WorkspaceSections() {
  const ws = useOptionalWorkspaceStrict();
  // "No account with that email" in Add member hands its email/role to the Invites form below.
  const [draft, setDraft] = useState<(InviteDraft & { nonce: number }) | null>(null);
  return (
    <>
      <GeneralSection />
      <MembersSection onNeedInvite={(d) => setDraft({ ...d, nonce: (draft?.nonce ?? 0) + 1 })} />
      <ImportExportSection />
      {canInviteMembers(ws.role) && <InvitesSection draft={draft} />}
      {canDeleteWorkspace(ws.role) && <DangerSection />}
    </>
  );
}

// ---------------------------------------------------------------------------------------------

function GeneralSection() {
  const { workspace, role } = useOptionalWorkspaceStrict();
  const qc = useQueryClient();
  const router = useRouter();
  const editable = canManageWorkspace(role);
  const [name, setName] = useState(workspace.name);
  const [slug, setSlug] = useState(workspace.slug);
  const [icon, setIcon] = useState<string | null>(workspace.icon ?? null);
  const [errors, setErrors] = useState<{ name?: string; slug?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH("/workspaces/{workspaceId}", {
          params: { path: { workspaceId: workspace.id } },
          body: { name: name.trim(), slug, icon },
        }),
      ),
    onSuccess: async (updated) => {
      await qc.invalidateQueries({ queryKey: qk.me() });
      toast.success("Workspace updated");
      if (updated.workspace.slug !== workspace.slug) router.replace(`${workspaceHref(updated.workspace.slug)}`);
    },
    onError: (e) => {
      if (hasStatus(e, 409)) setErrors({ slug: "That URL name is already taken." });
      else setFormError(errorMessage(e));
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const found = {
      name: validateName(name, "a workspace name") ?? undefined,
      slug: SLUG_PATTERN.test(slug) ? undefined : "Use lowercase letters, numbers and single dashes.",
    };
    setErrors(found);
    if (found.name || found.slug) return;
    save.mutate();
  };

  const dirty = name.trim() !== workspace.name || slug !== workspace.slug || icon !== (workspace.icon ?? null);

  return (
    <SettingsSection
      title="General"
      description={editable ? "Name and icon shown in the sidebar." : "Only owners and admins can edit these."}
    >
      <form onSubmit={submit} className="grid max-w-md gap-4" noValidate>
        <FormError message={formError} />
        <div className="flex items-end gap-3">
          <div className="grid gap-1.5">
            <span className="text-[13px] font-medium">Icon</span>
            {editable ? (
              <IconPicker value={icon} onChange={setIcon}>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="Change workspace icon"
                  className="size-11 md:size-9"
                >
                  <WorkspaceBadge name={name || workspace.name} icon={icon} className="size-6" />
                </Button>
              </IconPicker>
            ) : (
              <WorkspaceBadge name={workspace.name} icon={workspace.icon} className="size-9" />
            )}
          </div>
          <FormField label="Name" error={errors.name} className="flex-1">
            {(p) => (
              <Input
                {...p}
                value={name}
                readOnly={!editable}
                maxLength={100}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </FormField>
        </div>
        <FormField label="URL name" error={errors.slug} hint="Used in links: /w/your-name">
          {(p) => (
            <Input
              {...p}
              value={slug}
              readOnly={!editable}
              maxLength={60}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
            />
          )}
        </FormField>
        {editable && (
          <Button type="submit" className="w-fit" disabled={save.isPending || !dirty}>
            {save.isPending ? "Saving…" : "Save changes"}
          </Button>
        )}
      </form>
    </SettingsSection>
  );
}

function useOptionalWorkspaceStrict() {
  const ws = useOptionalWorkspace();
  if (!ws) throw new Error("workspace required");
  return ws;
}

// ---------------------------------------------------------------------------------------------

function MembersSection({ onNeedInvite }: { onNeedInvite: (draft: InviteDraft) => void }) {
  const { workspace, role } = useOptionalWorkspaceStrict();
  const { user } = useSession();
  const qc = useQueryClient();
  const router = useRouter();
  const query = useQuery(membersOptions(workspace.id));
  const [removing, setRemoving] = useState<Member | null>(null);
  const [adding, setAdding] = useState(false);
  const roles = assignableWorkspaceRoles(role);

  const changeRole = useMutation({
    mutationFn: (vars: { userId: string; role: WorkspaceRole }) =>
      unwrap(
        api.PATCH("/workspaces/{workspaceId}/members/{userId}", {
          params: { path: { workspaceId: workspace.id, userId: vars.userId } },
          body: { role: vars.role },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.members(workspace.id) }),
    onError: (e) => {
      toast.error("Couldn't change the role", {
        description: hasStatus(e, 409) ? "A workspace needs at least one owner." : errorMessage(e),
      });
      void qc.invalidateQueries({ queryKey: qk.members(workspace.id) });
    },
  });

  const remove = useMutation({
    mutationFn: (userId: string) =>
      unwrapVoid(
        api.DELETE("/workspaces/{workspaceId}/members/{userId}", {
          params: { path: { workspaceId: workspace.id, userId } },
        }),
      ),
    onSuccess: async (_d, userId) => {
      setRemoving(null);
      if (userId === user.id) {
        toast.success(`You left ${workspace.name}`);
        await qc.invalidateQueries({ queryKey: qk.me() });
        router.replace("/");
      } else {
        toast.success("Member removed");
        await qc.invalidateQueries({ queryKey: qk.members(workspace.id) });
      }
    },
    onError: (e) => {
      setRemoving(null);
      toast.error("Couldn't remove the member", {
        description: hasStatus(e, 409) ? "A workspace needs at least one owner." : errorMessage(e),
      });
    },
  });

  return (
    <SettingsSection title="Members" description="People who belong to this workspace.">
      {canManageMembers(role) &&
        (adding ? (
          <AddMemberPanel
            workspaceId={workspace.id}
            actorRole={role}
            onClose={() => setAdding(false)}
            onNeedInvite={(draft) => {
              setAdding(false);
              onNeedInvite(draft);
            }}
          />
        ) : (
          <div className="mb-4">
            <OnlineOnly reason="Adding members needs a connection">
              <Button variant="outline" onClick={() => setAdding(true)}>
                <UserPlus /> Add member
              </Button>
            </OnlineOnly>
          </div>
        ))}
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
          {query.data.map((m) => {
            const self = m.user.id === user.id;
            const modifiable = canModifyMember(role, m.role) && !self;
            return (
              <li key={m.user.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-3">
                <UserAvatar name={m.user.name} color={m.user.avatarColor} className="size-8 text-xs" />
                <div className="min-w-0 flex-1 basis-44">
                  <p className="truncate font-medium">
                    {m.user.name} {self && <span className="font-normal text-muted-foreground">(you)</span>}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{m.user.email}</p>
                </div>
                {modifiable ? (
                  <NativeSelect
                    aria-label={`Role of ${m.user.name}`}
                    value={m.role}
                    disabled={changeRole.isPending}
                    onChange={(e) => changeRole.mutate({ userId: m.user.id, role: e.target.value as WorkspaceRole })}
                  >
                    {roles.map((r) => (
                      <option key={r} value={r}>
                        {WORKSPACE_ROLE_LABELS[r]}
                      </option>
                    ))}
                    {!roles.includes(m.role) && <option value={m.role}>{WORKSPACE_ROLE_LABELS[m.role]}</option>}
                  </NativeSelect>
                ) : (
                  <Badge variant={m.role === "owner" ? "primary" : "default"}>{WORKSPACE_ROLE_LABELS[m.role]}</Badge>
                )}
                {modifiable && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${m.user.name}`}
                    onClick={() => setRemoving(m)}
                  >
                    <UserMinus />
                  </Button>
                )}
                {self && (
                  <Button variant="outline" size="sm" onClick={() => setRemoving(m)}>
                    <LogOut /> Leave
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {removing?.user.id === user.id ? `Leave ${workspace.name}?` : `Remove ${removing?.user.name}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {removing?.user.id === user.id
                ? "You'll lose access to every page in this workspace unless someone invites you again."
                : "They'll lose access to every page in this workspace. Pages they created stay."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={remove.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (removing) remove.mutate(removing.user.id);
              }}
            >
              {removing?.user.id === user.id ? "Leave workspace" : "Remove member"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}

// ---------------------------------------------------------------------------------------------

function InvitesSection({ draft }: { draft: (InviteDraft & { nonce: number }) | null }) {
  const { workspace, role } = useOptionalWorkspaceStrict();
  const qc = useQueryClient();
  const query = useQuery(workspaceInvitesOptions(workspace.id));
  const online = useOnline();
  const sectionRef = useRef<HTMLElement>(null);
  const [inviteRole, setInviteRole] = useState<InviteRole>("member");
  const [email, setEmail] = useState("");
  const [days, setDays] = useState("7");
  const [error, setError] = useState<string | null>(null);
  // The invite created in this session: its link is shown prominently (and copied) so it can be sent right away.
  const [fresh, setFresh] = useState<{ id: string; url: string; copied: boolean } | null>(null);

  // Arriving from "No account with that email": prefill the form, bring the section into view, focus Create.
  const handled = useRef(0);
  useEffect(() => {
    if (!draft || draft.nonce === handled.current) return;
    handled.current = draft.nonce;
    setEmail(draft.email);
    setInviteRole(draft.role === "admin" && role !== "owner" ? "member" : draft.role);
    setError(null);
    const section = sectionRef.current;
    section?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    section?.querySelector<HTMLButtonElement>("button[type=submit]")?.focus({ preventScroll: true });
  }, [draft, role]);

  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/workspaces/{workspaceId}/invites", {
          params: { path: { workspaceId: workspace.id } },
          body: {
            role: inviteRole,
            expiresInDays: Math.min(90, Math.max(1, Number.parseInt(days, 10) || 7)),
            ...(email.trim() ? { email: email.trim() } : {}),
          },
        }),
      ),
    onSuccess: async (invite) => {
      setEmail("");
      const url = absoluteUrl(invite.url);
      const copied = await copyToClipboard(url);
      setFresh({ id: invite.id, url, copied });
      toast.success(copied ? "Invite link copied" : "Invite created", {
        description: copied ? "Send it to the person yourself — no email is sent." : "Copy the link and send it yourself.",
      });
      await qc.invalidateQueries({ queryKey: qk.invites(workspace.id) });
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const revoke = useMutation({
    mutationFn: (id: string) =>
      unwrapVoid(
        api.DELETE("/workspaces/{workspaceId}/invites/{inviteId}", {
          params: { path: { workspaceId: workspace.id, inviteId: id } },
        }),
      ),
    onSuccess: (_d, id) => {
      setFresh((f) => (f?.id === id ? null : f));
      return qc.invalidateQueries({ queryKey: qk.invites(workspace.id) });
    },
    onError: (e) => toast.error("Couldn't revoke the invite", { description: errorMessage(e) }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (email.trim() && !/^\S+@\S+\.\S+$/.test(email.trim())) {
      setError("Enter a valid email address, or leave it empty for a link anyone can use.");
      return;
    }
    create.mutate();
  };

  return (
    <SettingsSection
      title="Invites"
      description="Invite someone new with a link. Copy the link and send it yourself — Hostidian doesn't send email."
      ref={sectionRef}
      id="invites"
    >
      <form onSubmit={submit} className="mb-5 grid max-w-xl gap-3" noValidate>
        <FormError message={error} />
        <div className="flex flex-wrap items-start gap-3">
          <FormField label="Role">
            {(p) => (
              <NativeSelect {...p} value={inviteRole} onChange={(e) => setInviteRole(e.target.value as InviteRole)}>
                {(["admin", "member", "guest"] as const)
                  .filter((r) => role === "owner" || r !== "admin")
                  .map((r) => (
                    <option key={r} value={r}>
                      {WORKSPACE_ROLE_LABELS[r]}
                    </option>
                  ))}
              </NativeSelect>
            )}
          </FormField>
          <FormField
            label="Email (optional)"
            hint="Only this email address can use the link. Leave empty for a link anyone can use."
            className="min-w-48 flex-1"
          >
            {(p) => (
              <Input
                {...p}
                type="email"
                value={email}
                placeholder="Anyone with the link"
                onChange={(e) => setEmail(e.target.value)}
              />
            )}
          </FormField>
          <FormField label="Expires in (days)">
            {(p) => (
              <Input
                {...p}
                type="number"
                min={1}
                max={90}
                value={days}
                className="w-24"
                onChange={(e) => setDays(e.target.value)}
              />
            )}
          </FormField>
        </div>
        <Button type="submit" className="w-fit" disabled={create.isPending || !online}>
          {create.isPending ? "Creating…" : "Create invite link"}
        </Button>
      </form>

      {fresh && (
        <div
          role="status"
          data-testid="new-invite"
          className="mb-5 grid max-w-xl gap-2 rounded-xl border border-primary/30 bg-primary/5 p-3.5"
        >
          <p className="text-sm font-medium">
            {fresh.copied ? "Invite link created and copied" : "Invite link created"}
          </p>
          <p className="text-[13px] text-muted-foreground">
            Send this link to the person yourself — no email was sent.
          </p>
          <div className="flex flex-wrap gap-2">
            <Input
              readOnly
              value={fresh.url}
              aria-label="New invite link"
              className="basis-52 flex-1 font-mono text-[13px]"
              onFocus={(e) => e.currentTarget.select()}
            />
            <CopyButton value={fresh.url} label="Copy link" size="default" variant="secondary" />
          </div>
        </div>
      )}

      {query.isPending ? (
        <Skeleton className="h-14" />
      ) : query.isError ? (
        <FormError message={errorMessage(query.error)} />
      ) : query.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">No pending invites.</p>
      ) : (
        <ul className="divide-y rounded-xl border">
          {query.data.map((invite) => (
            <li
              key={invite.id}
              className={cn(
                "flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-3",
                fresh?.id === invite.id && "bg-primary/5",
              )}
            >
              <div className="min-w-0 flex-1 basis-48">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  <Badge variant="default">{WORKSPACE_ROLE_LABELS[invite.role]}</Badge>
                  <span className="truncate">{invite.email ?? "Anyone with the link"}</span>
                </p>
                <p className="text-xs text-muted-foreground">Expires {formatDateTime(invite.expiresAt)}</p>
              </div>
              <CopyButton value={absoluteUrl(invite.url)} label="Copy link" />
              <Button
                variant="destructive-ghost"
                size="sm"
                disabled={revoke.isPending}
                onClick={() => revoke.mutate(invite.id)}
                aria-label="Revoke invite"
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}

// ---------------------------------------------------------------------------------------------

function DangerSection() {
  const { workspace } = useOptionalWorkspaceStrict();
  const qc = useQueryClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");

  const del = useMutation({
    mutationFn: () =>
      unwrapVoid(api.DELETE("/workspaces/{workspaceId}", { params: { path: { workspaceId: workspace.id } } })),
    onSuccess: async () => {
      toast.success(`Workspace "${workspace.name}" deleted`);
      setOpen(false);
      qc.removeQueries({ queryKey: qk.workspace(workspace.id) });
      await qc.invalidateQueries({ queryKey: qk.me() });
      router.replace("/");
    },
    onError: (e) => toast.error("Couldn't delete the workspace", { description: errorMessage(e) }),
  });

  return (
    <SettingsSection
      title="Danger zone"
      description="Deleting a workspace removes all of its pages, comments and files for everyone."
    >
      <Button variant="destructive-ghost" className="border border-destructive/30" onClick={() => setOpen(true)}>
        <Trash2 /> Delete workspace…
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setTyped("");
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{workspace.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes every page and file in the workspace. It can&apos;t be undone. Type the workspace
              name to confirm.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <FormField label={`Type “${workspace.name}” to confirm`}>
            {(p) => <Input {...p} value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />}
          </FormField>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={typed !== workspace.name || del.isPending}
              onClick={(e) => {
                e.preventDefault();
                del.mutate();
              }}
            >
              {del.isPending ? "Deleting…" : "Delete workspace"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <p className="mt-3 text-xs text-muted-foreground">
        Looking for another workspace?{" "}
        <Link href="/" className="underline underline-offset-2">
          Switch from the sidebar.
        </Link>
      </p>
    </SettingsSection>
  );
}
