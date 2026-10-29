"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch, Pause, Play, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/common/copy-button";
import { EmptyState } from "@/components/common/empty-state";
import { FormError, FormField } from "@/components/common/form-field";
import { OnlineOnly } from "@/components/pwa/online-only";
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
import { Badge } from "@/components/ui/badge";
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
import { Skeleton } from "@/components/ui/skeleton";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { api } from "@/lib/api/client";
import { errorMessage, isApiError } from "@/lib/api/error";
import { qk } from "@/lib/api/keys";
import { githubConnectionsOptions } from "@/lib/api/queries";
import { unwrap, unwrapVoid } from "@/lib/api/unwrap";
import { canManageWorkspace } from "@/lib/permissions";
import { formatRelative, useNow } from "@/lib/time";
import { pageHref } from "@/lib/utils";
import { useOptionalWorkspace } from "@/lib/workspace";
import type { GithubConnection } from "@hostidian/api-types";
import { connectionStatus, WEBHOOK_EVENTS } from "./github-status";
import { SettingsSection } from "./settings-shell";

const OFFLINE_REASON = "Managing GitHub sync needs a connection.";

/** Field-level message from a 422 (`details.token`, `details.repository`), if any. */
const fieldMessage = (e: unknown, field: string) => (isApiError(e) ? e.details?.[field] : undefined);

export function GithubPanel() {
  useDocumentTitle("GitHub sync");
  const ws = useOptionalWorkspace();
  if (!ws) {
    return <EmptyState title="No workspace selected" description="Create or join a workspace to connect GitHub." />;
  }
  if (!canManageWorkspace(ws.role)) {
    return (
      <EmptyState
        title="Only owners and admins can manage GitHub sync"
        description={`Ask an owner or admin of ${ws.workspace.name} to connect a repository. Synced issues appear as pages for everyone.`}
      />
    );
  }
  return <GithubSections workspaceId={ws.workspace.id} workspaceName={ws.workspace.name} slug={ws.workspace.slug} />;
}

function GithubSections({ workspaceId, workspaceName, slug }: { workspaceId: string; workspaceName: string; slug: string }) {
  const query = useQuery(githubConnectionsOptions(workspaceId));
  return (
    <>
      <SettingsSection
        title="GitHub issues"
        description={`Keep a repository's issues in sync with ${workspaceName}: every issue becomes a page, edits and comments flow both ways, and pages you create under the repository's root page open new issues.`}
      >
        {query.isPending ? (
          <div className="grid gap-2" aria-busy="true">
            <Skeleton className="h-24" />
          </div>
        ) : query.isError ? (
          <div className="grid gap-2">
            <FormError message={errorMessage(query.error)} />
            <Button variant="outline" className="w-fit" onClick={() => void query.refetch()}>
              Try again
            </Button>
          </div>
        ) : query.data.length === 0 ? (
          <EmptyState
            icon={GitBranch}
            title="No repository connected"
            description="Connect one below to import its issues."
            className="rounded-xl border border-dashed py-10"
          />
        ) : (
          <ul className="grid gap-3" aria-label="Connected repositories">
            {query.data.map((c) => (
              <ConnectionItem key={c.id} connection={c} workspaceId={workspaceId} slug={slug} />
            ))}
          </ul>
        )}
      </SettingsSection>

      <SettingsSection
        title="Connect a repository"
        description="Use a personal access token that can read and write the repository's issues."
      >
        <ConnectForm workspaceId={workspaceId} />
      </SettingsSection>

      <SettingsSection title="How it works">
        <ul className="grid max-w-2xl list-disc gap-1.5 pl-5 text-sm text-muted-foreground">
          <li>
            Each issue is a page under <strong className="font-medium text-foreground">GitHub: owner/repo</strong>. The
            icon shows its state (🟢 open, 🟣 closed). Write <code>[[#123]]</code> in any page to link to an issue.
          </li>
          <li>
            Title, description and open/closed state sync both ways. If both sides change the same field, the more
            recent edit wins. Pull requests are not synced.
          </li>
          <li>
            Comments in a page&apos;s <em>GitHub</em> thread are posted to the issue as the token&apos;s owner, signed
            “via Hostidian, by Name”. Comments from GitHub show up there with their author&apos;s name.
          </li>
          <li>
            Changes from GitHub arrive about once a minute, or instantly with a webhook. Disconnecting keeps the pages
            and deletes nothing on GitHub.
          </li>
        </ul>
      </SettingsSection>
    </>
  );
}

// ---------------------------------------------------------------------------------------------

function ConnectForm({ workspaceId }: { workspaceId: string }) {
  const qc = useQueryClient();
  const [repository, setRepository] = useState("");
  const [token, setToken] = useState("");
  const [errors, setErrors] = useState<{ repository?: string; token?: string; form?: string }>({});

  const connect = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/workspaces/{workspaceId}/integrations/github", {
          params: { path: { workspaceId } },
          body: { repository: repository.trim(), token: token.trim() },
        }),
      ),
    onSuccess: async (c) => {
      setRepository("");
      setToken("");
      setErrors({});
      toast.success(`Connected ${c.repository}`, { description: "Existing issues are being imported." });
      await qc.invalidateQueries({ queryKey: qk.githubConnections(workspaceId) });
    },
    onError: (e) => {
      const repo = fieldMessage(e, "repository");
      const tok = fieldMessage(e, "token");
      setErrors({ repository: repo, token: tok, form: repo || tok ? undefined : errorMessage(e) });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = {
      repository: repository.trim() ? undefined : "Enter the repository as owner/name.",
      token: token.trim() ? undefined : "Paste an access token.",
    };
    setErrors(next);
    if (!next.repository && !next.token) connect.mutate();
  };

  return (
    <form onSubmit={submit} noValidate className="grid max-w-xl gap-4">
      <FormError message={errors.form} />
      <FormField label="Repository" error={errors.repository} hint="owner/name or the repository's URL.">
        {(p) => (
          <Input {...p} value={repository} onChange={(e) => setRepository(e.target.value)} placeholder="acme/website" autoComplete="off" />
        )}
      </FormField>
      <FormField
        label="Access token"
        error={errors.token}
        hint="Fine-grained: Issues read & write on this repository. Classic: the repo scope. It is stored encrypted and never shown again."
      >
        {(p) => (
          <Input
            {...p}
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="github_pat_…"
            autoComplete="off"
            spellCheck={false}
          />
        )}
      </FormField>
      <div>
        <OnlineOnly reason="Connecting needs a connection.">
          <Button type="submit" disabled={connect.isPending}>
            {connect.isPending ? "Checking with GitHub…" : "Connect repository"}
          </Button>
        </OnlineOnly>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------

function ConnectionItem({ connection: c, workspaceId, slug }: { connection: GithubConnection; workspaceId: string; slug: string }) {
  const qc = useQueryClient();
  const now = useNow();
  const status = connectionStatus(c);
  const [replacing, setReplacing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: qk.githubConnections(workspaceId) });

  const syncNow = useMutation({
    mutationFn: () => unwrapVoid(api.POST("/integrations/github/{connectionId}/sync", { params: { path: { connectionId: c.id } } })),
    onSuccess: () => {
      toast.success("Sync scheduled", { description: "It starts within a few seconds." });
      void refresh();
    },
    onError: (e) => toast.error("Couldn't start the sync", { description: errorMessage(e) }),
  });
  const setEnabled = useMutation({
    mutationFn: (enabled: boolean) =>
      unwrap(api.PATCH("/integrations/github/{connectionId}", { params: { path: { connectionId: c.id } }, body: { enabled } })),
    onSuccess: () => void refresh(),
    onError: (e) => toast.error("Couldn't update the connection", { description: errorMessage(e) }),
  });

  return (
    <li className="rounded-xl border">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-3">
        <div className="min-w-0 flex-1 basis-56">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
            <GitBranch className="size-4 text-muted-foreground" aria-hidden="true" />
            <span className="truncate">{c.repository}</span>
            <Badge variant={status.variant}>{status.label}</Badge>
          </p>
          <p className="text-xs text-muted-foreground">
            {c.lastSyncedAt ? `Last synced ${formatRelative(c.lastSyncedAt, now || Date.parse(c.lastSyncedAt))}` : "Not synced yet"}
            {c.rootPageId ? (
              <>
                {" · "}
                <Link href={pageHref(slug, c.rootPageId)} className="underline-offset-2 hover:underline">
                  Open synced pages
                </Link>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <OnlineOnly reason={OFFLINE_REASON}>
            <Button size="sm" variant="outline" disabled={syncNow.isPending || !c.enabled} onClick={() => syncNow.mutate()}>
              <RefreshCw /> Sync now
            </Button>
          </OnlineOnly>
          <OnlineOnly reason={OFFLINE_REASON}>
            <Button size="sm" variant="outline" disabled={setEnabled.isPending} onClick={() => setEnabled.mutate(!c.enabled)}>
              {c.enabled ? <Pause /> : <Play />} {c.enabled ? "Pause" : "Resume"}
            </Button>
          </OnlineOnly>
          <OnlineOnly reason={OFFLINE_REASON}>
            <Button size="sm" variant="outline" onClick={() => setReplacing(true)}>
              Replace token
            </Button>
          </OnlineOnly>
          <OnlineOnly reason={OFFLINE_REASON}>
            <Button size="sm" variant="destructive-ghost" onClick={() => setDisconnecting(true)}>
              Disconnect
            </Button>
          </OnlineOnly>
        </div>
      </div>

      {c.lastError ? (
        <div className="px-3.5 pb-3">
          <FormError message={c.lastError} />
        </div>
      ) : null}

      <details className="border-t px-3.5 py-2.5 text-sm">
        <summary className="cursor-pointer select-none text-muted-foreground">Instant updates with a webhook (optional)</summary>
        <div className="mt-3 grid gap-3">
          <p className="text-[13px] text-muted-foreground">
            In the repository: Settings → Webhooks → Add webhook. Set the content type to{" "}
            <code>application/json</code> and select the events {WEBHOOK_EVENTS.map((e) => `“${e}”`).join(" and ")}.
            Without it, GitHub changes are picked up about once a minute.
          </p>
          <CopyRow label="Payload URL" value={c.webhookUrl} />
          <CopyRow label="Secret" value={c.webhookSecret} />
        </div>
      </details>

      <ReplaceTokenDialog connection={c} open={replacing} onOpenChange={setReplacing} onDone={refresh} />
      <DisconnectDialog connection={c} open={disconnecting} onOpenChange={setDisconnecting} onDone={refresh} />
    </li>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-24 shrink-0 text-xs font-medium text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 basis-60 break-all rounded-md bg-muted px-2 py-1 text-xs">{value}</code>
      <CopyButton value={value} label="Copy" />
    </div>
  );
}

function ReplaceTokenDialog({
  connection,
  open,
  onOpenChange,
  onDone,
}: {
  connection: GithubConnection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => unknown;
}) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const replace = useMutation({
    mutationFn: () =>
      unwrap(api.PATCH("/integrations/github/{connectionId}", { params: { path: { connectionId: connection.id } }, body: { token: token.trim() } })),
    onSuccess: async () => {
      setToken("");
      setError(null);
      onOpenChange(false);
      toast.success("Token replaced", { description: "GitHub-originated edits are now attributed to you." });
      await onDone();
    },
    onError: (e) => setError(fieldMessage(e, "token") ?? errorMessage(e)),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!token.trim()) return setError("Paste an access token.");
    setError(null);
    replace.mutate();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Replace token for {connection.repository}</DialogTitle>
          <DialogDescription>
            The new token is checked against GitHub first. You become the user that edits coming from GitHub are
            attributed to in this workspace.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="grid gap-4">
          <FormField label="New access token" error={error}>
            {(p) => (
              <Input {...p} type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} />
            )}
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={replace.isPending}>
              {replace.isPending ? "Checking…" : "Replace token"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DisconnectDialog({
  connection,
  open,
  onOpenChange,
  onDone,
}: {
  connection: GithubConnection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => unknown;
}) {
  const disconnect = useMutation({
    mutationFn: () => unwrapVoid(api.DELETE("/integrations/github/{connectionId}", { params: { path: { connectionId: connection.id } } })),
    onSuccess: async () => {
      onOpenChange(false);
      toast.success(`Disconnected ${connection.repository}`);
      await onDone();
    },
    onError: (e) => {
      onOpenChange(false);
      toast.error("Couldn't disconnect", { description: errorMessage(e) });
    },
  });
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect {connection.repository}?</AlertDialogTitle>
          <AlertDialogDescription>
            The synced pages stay in this workspace as ordinary pages and nothing is deleted on GitHub, but changes
            stop flowing in both directions. Remove the webhook on GitHub as well if you added one.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={disconnect.isPending}
            onClick={(e) => {
              e.preventDefault();
              disconnect.mutate();
            }}
          >
            {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
