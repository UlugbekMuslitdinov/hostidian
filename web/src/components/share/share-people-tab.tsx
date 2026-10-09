"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Lock, Users, X } from "lucide-react";
import { useId, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/common/copy-button";
import { FormError } from "@/components/common/form-field";
import { UserAvatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api/client";
import { errorMessage, hasStatus } from "@/lib/api/error";
import { qk } from "@/lib/api/keys";
import { membersOptions, pagePermissionsOptions } from "@/lib/api/queries";
import { unwrap } from "@/lib/api/unwrap";
import { canShare, PAGE_ROLE_LABELS, PAGE_ROLES } from "@/lib/permissions";
import { absoluteUrl } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import type { PagePermissions, PageRole, Visibility } from "@hostidian/api-types";
import type { SharePage } from "./share-dialog";

export function SharePeopleTab({ page }: { page: SharePage }) {
  if (!canShare(page.role)) {
    return (
      <p className="rounded-md border bg-muted px-3 py-3 text-sm text-muted-foreground" role="status">
        You have <strong className="font-medium text-foreground">{PAGE_ROLE_LABELS[page.role].toLowerCase()}</strong> on
        this page. Only people with full access can change who it&apos;s shared with.
      </p>
    );
  }
  return <ManagePeople page={page} />;
}

function ManagePeople({ page }: { page: SharePage }) {
  const qc = useQueryClient();
  const { workspace } = useWorkspace();
  const query = useQuery(pagePermissionsOptions(page.id));
  const membersQuery = useQuery(membersOptions(workspace.id));

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<PageRole>("edit");
  const [error, setError] = useState<string | null>(null);
  const [unknownEmail, setUnknownEmail] = useState<string | null>(null);
  const emailListId = useId();

  const store = (data: PagePermissions) => {
    qc.setQueryData(qk.pagePermissions(page.id), data);
    void qc.invalidateQueries({ queryKey: qk.pages(workspace.id) });
  };

  const grant = useMutation({
    mutationFn: (vars: { email?: string; userId?: string; role: PageRole }) =>
      unwrap(api.POST("/pages/{pageId}/permissions", { params: { path: { pageId: page.id } }, body: vars })),
    onSuccess: (data, vars) => {
      store(data);
      if (vars.email) {
        setEmail("");
        toast.success("Access granted");
      }
    },
    onError: (e, vars) => {
      if (vars.email && hasStatus(e, 404)) {
        setUnknownEmail(vars.email);
        setError(null);
      } else {
        toast.error("Couldn't update access", { description: errorMessage(e) });
      }
    },
  });

  const revoke = useMutation({
    mutationFn: (userId: string) =>
      unwrap(api.DELETE("/pages/{pageId}/permissions/{userId}", { params: { path: { pageId: page.id, userId } } })),
    onSuccess: store,
    onError: (e) => toast.error("Couldn't remove access", { description: errorMessage(e) }),
  });

  const visibility = useMutation({
    mutationFn: (value: Visibility) =>
      unwrap(
        api.PUT("/pages/{pageId}/visibility", { params: { path: { pageId: page.id } }, body: { visibility: value } }),
      ),
    onSuccess: store,
    onError: (e) => toast.error("Couldn't change visibility", { description: errorMessage(e) }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setUnknownEmail(null);
    const value = email.trim();
    if (!/^\S+@\S+\.\S+$/.test(value)) {
      setError("Enter a valid email address.");
      return;
    }
    grant.mutate({ email: value, role });
  };

  const entries = query.data?.entries;
  const sorted = useMemo(() => [...(entries ?? [])].sort((a, b) => a.user.name.localeCompare(b.user.name)), [entries]);
  const suggestions = useMemo(() => {
    const taken = new Set(sorted.map((s) => s.user.id));
    return (membersQuery.data ?? []).filter((m) => !taken.has(m.user.id)).slice(0, 50);
  }, [membersQuery.data, sorted]);

  if (query.isPending) {
    return (
      <div className="grid gap-2" aria-busy="true" aria-label="Loading access list">
        <Skeleton className="h-10" />
        <Skeleton className="h-12" />
        <Skeleton className="h-12" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="grid gap-2">
        <FormError message={errorMessage(query.error, "Couldn't load who has access.")} />
        <Button variant="outline" className="w-fit" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const data = query.data;

  return (
    <div className="grid gap-5">
      <form onSubmit={submit} className="grid gap-2" noValidate>
        <label htmlFor={`${emailListId}-email`} className="text-[13px] font-medium">
          Invite by email
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id={`${emailListId}-email`}
            type="email"
            inputMode="email"
            autoComplete="off"
            list={emailListId}
            placeholder="name@example.com"
            value={email}
            aria-invalid={Boolean(error)}
            onChange={(e) => {
              setEmail(e.target.value);
              setError(null);
              setUnknownEmail(null);
            }}
            className="flex-1"
          />
          <datalist id={emailListId}>
            {suggestions.map((m) => (
              <option key={m.user.id} value={m.user.email}>
                {m.user.name}
              </option>
            ))}
          </datalist>
          <NativeSelect
            aria-label="Access level for the invitation"
            value={role}
            onChange={(e) => setRole(e.target.value as PageRole)}
          >
            {PAGE_ROLES.map((r) => (
              <option key={r} value={r}>
                {PAGE_ROLE_LABELS[r]}
              </option>
            ))}
          </NativeSelect>
          <Button type="submit" disabled={grant.isPending || !email.trim()}>
            {grant.isPending ? "Inviting…" : "Invite"}
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-[13px] text-destructive">
            {error}
          </p>
        )}
        {unknownEmail && <GuestInvite email={unknownEmail} workspaceId={workspace.id} />}
      </form>

      <section aria-label="People with access" className="grid gap-1">
        <h3 className="text-[13px] font-medium">People with access</h3>
        <VisibilityRow
          data={data}
          pending={visibility.isPending}
          onChange={(v) => visibility.mutate(v)}
          workspaceName={workspace.name}
        />
        {sorted.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">Nobody has been given direct access to this page yet.</p>
        ) : (
          <ul className="divide-y">
            {sorted.map((entry) => {
              const inherited = Boolean(entry.inheritedFrom);
              return (
                <li key={entry.user.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2">
                  <UserAvatar name={entry.user.name} color={entry.user.avatarColor} className="size-8 text-xs" />
                  <div className="min-w-0 flex-1 basis-40">
                    <p className="truncate font-medium">{entry.user.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{entry.user.email}</p>
                  </div>
                  {inherited && (
                    <Badge variant="outline" title="Access granted on a parent page. Change it there.">
                      Inherited
                    </Badge>
                  )}
                  <NativeSelect
                    aria-label={`Access level for ${entry.user.name}`}
                    value={entry.role}
                    disabled={inherited || grant.isPending}
                    onChange={(e) => grant.mutate({ userId: entry.user.id, role: e.target.value as PageRole })}
                  >
                    {PAGE_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {PAGE_ROLE_LABELS[r]}
                      </option>
                    ))}
                  </NativeSelect>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${entry.user.name}`}
                    disabled={inherited || revoke.isPending}
                    title={inherited ? "Inherited from a parent page" : undefined}
                    onClick={() => revoke.mutate(entry.user.id)}
                  >
                    <X />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function VisibilityRow({
  data,
  pending,
  onChange,
  workspaceName,
}: {
  data: PagePermissions;
  pending: boolean;
  onChange: (visibility: Visibility) => void;
  workspaceName: string;
}) {
  if (!data.canChangeVisibility) {
    return (
      <p className="flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-[13px] text-muted-foreground">
        <Users className="size-4 shrink-0" aria-hidden="true" />
        This is a sub-page, so it inherits access from its top-level page.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md bg-muted px-3 py-2">
      {data.visibility === "private" ? (
        <Lock className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      ) : (
        <Users className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1 basis-48 text-[13px]">
        <p className="font-medium">{data.visibility === "private" ? "Private" : `Everyone in ${workspaceName}`}</p>
        <p className="text-muted-foreground">
          {data.visibility === "private"
            ? "Only you and the people below can open this page."
            : "Every member of the workspace can edit this page."}
        </p>
      </div>
      <Select value={data.visibility} onValueChange={(v) => onChange(v as Visibility)} disabled={pending}>
        <SelectTrigger aria-label="Page visibility" className="w-36 bg-background">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          <SelectItem value="workspace">Workspace</SelectItem>
          <SelectItem value="private">Private</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

/** Unknown email: offer a guest-invite link for the workspace (the API answers 404 for unknown users). */
function GuestInvite({ email, workspaceId }: { email: string; workspaceId: string }) {
  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/workspaces/{workspaceId}/invites", {
          params: { path: { workspaceId } },
          body: { role: "guest", email },
        }),
      ),
    onError: (e) => toast.error("Couldn't create the invite", { description: errorMessage(e) }),
  });

  return (
    <div className="rounded-md border border-dashed px-3 py-2.5 text-[13px]" role="status">
      <p>
        <strong className="font-medium">{email}</strong> doesn&apos;t have an account here yet.
      </p>
      {create.data ? (
        <div className="mt-2 grid gap-2">
          <p className="text-muted-foreground">
            Send them this link. Once they&apos;ve joined as a guest, share the page with them again.
          </p>
          <div className="flex gap-2">
            <Input
              readOnly
              value={absoluteUrl(create.data.url)}
              aria-label="Guest invite link"
              onFocus={(e) => e.currentTarget.select()}
            />
            <CopyButton value={absoluteUrl(create.data.url)} size="default" />
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2"
          disabled={create.isPending}
          onClick={() => create.mutate()}
        >
          <Link2 /> {create.isPending ? "Creating…" : "Create guest invite link"}
        </Button>
      )}
    </div>
  );
}
