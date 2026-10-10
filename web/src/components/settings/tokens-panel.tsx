"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, KeyRound, Plus, ShieldAlert } from "lucide-react";
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
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { api } from "@/lib/api/client";
import { errorMessage, hasStatus } from "@/lib/api/error";
import { apiTokensKey, apiTokensOptions } from "@/lib/api/queries";
import { unwrap, unwrapVoid } from "@/lib/api/unwrap";
import { useOnline } from "@/lib/offline/context";
import { useSession } from "@/lib/session";
import { formatDateTime, formatRelative, useNow } from "@/lib/time";
import { validateName } from "@/lib/validation";
import type { components } from "@hostidian/api-types";
import { SettingsSection } from "./settings-shell";
import { claudeCodeCommand, claudeDesktopConfig, EXPIRY_OPTIONS, genericJsonConfig } from "./token-snippets";

type ApiToken = components["schemas"]["ApiToken"];
type CreatedApiToken = components["schemas"]["CreatedApiToken"];
type TokenScope = components["schemas"]["TokenScope"];

const SCOPES: { value: TokenScope; label: string; description: string }[] = [
  {
    value: "read",
    label: "Read only",
    description: "The agent can search and read your pages, backlinks and comments. It can't change anything.",
  },
  {
    value: "write",
    label: "Read and write",
    description:
      "The agent can also create, edit, move and archive pages and add comments — as you. Archived pages can be restored from Trash.",
  },
];

export function TokensPanel() {
  useDocumentTitle("Access tokens");
  const query = useQuery(apiTokensOptions());
  const now = useNow();
  const { workspaces } = useSession();
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);

  const workspaceName = (id: string | null | undefined) =>
    id ? (workspaces.find((m) => m.workspace.id === id)?.workspace.name ?? "One workspace") : "All workspaces";

  return (
    <>
      <SettingsSection
        title="Access tokens"
        description="Connect AI agents such as Claude Code or Cursor to your pages through MCP. A token acts as you, with the permissions below."
      >
        <div className="mb-4">
          <OnlineOnly reason="Creating tokens needs a connection">
            <Button onClick={() => setCreating(true)}>
              <Plus /> Create token
            </Button>
          </OnlineOnly>
        </div>

        {query.isPending ? (
          <div className="grid gap-2" aria-busy="true">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        ) : query.isError ? (
          <div className="grid gap-2">
            <FormError
              message={
                hasStatus(query.error, 501)
                  ? "Access tokens aren't available on this server yet."
                  : errorMessage(query.error)
              }
            />
            <Button variant="outline" className="w-fit" onClick={() => void query.refetch()}>
              Try again
            </Button>
          </div>
        ) : query.data.length === 0 ? (
          <EmptyState
            icon={KeyRound}
            title="No access tokens yet"
            description="Create one to let an agent read (and optionally edit) your pages."
            className="rounded-xl border border-dashed py-10"
          />
        ) : (
          <ul className="divide-y rounded-xl border" aria-label="Access tokens">
            {query.data.map((token) => {
              const expired = token.expiresAt ? now > 0 && Date.parse(token.expiresAt) <= now : false;
              return (
                <li key={token.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-3">
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
                      <span className="truncate">{token.name}</span>
                      <Badge variant={token.scope === "write" ? "warning" : "default"}>
                        {token.scope === "write" ? "Read and write" : "Read only"}
                      </Badge>
                      {expired && <Badge variant="destructive">Expired</Badge>}
                    </p>
                    <p className="font-mono text-xs text-muted-foreground">{token.prefix}…</p>
                    <p className="text-xs text-muted-foreground">
                      {workspaceName(token.workspaceId)} ·{" "}
                      {token.expiresAt
                        ? `${expired ? "expired" : "expires"} ${formatDateTime(token.expiresAt)}`
                        : "never expires"}{" "}
                      ·{" "}
                      {token.lastUsedAt
                        ? `last used ${formatRelative(token.lastUsedAt, now || Date.parse(token.lastUsedAt))}`
                        : "never used"}{" "}
                      · created {formatDateTime(token.createdAt)}
                    </p>
                  </div>
                  <Button
                    variant="destructive-ghost"
                    size="sm"
                    aria-label={`Revoke ${token.name}`}
                    onClick={() => setRevoking(token)}
                  >
                    Revoke
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </SettingsSection>

      <SettingsSection title="What can agents do?">
        <div className="grid max-w-2xl gap-3 text-sm">
          <ul className="grid list-disc gap-1.5 pl-5 text-muted-foreground">
            <li>
              <strong className="font-medium text-foreground">Read only</strong> tokens let an agent search and read
              the pages, backlinks and comments you can see.
            </li>
            <li>
              <strong className="font-medium text-foreground">Read and write</strong> tokens can also create, edit,
              move and archive pages and add comments. Edits show up live and are attributed to you; nothing is ever
              permanently deleted.
            </li>
            <li>
              A token can be limited to one workspace. It can never change your account, password, members, sharing or
              workspace settings, and it can&apos;t create other tokens.
            </li>
          </ul>
          <div className="flex items-start gap-2.5 rounded-lg border border-warning/40 bg-warning/10 p-3 text-[13px]">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
            <p>
              <strong className="font-medium">Treat tokens like passwords.</strong> Anything a token can read, the
              agent — and the AI service behind it — can read. Keep tokens out of chats and repositories, prefer
              read-only and single-workspace tokens, and revoke one as soon as it may have leaked or you stop using
              the agent.
            </p>
          </div>
        </div>
      </SettingsSection>

      <CreateTokenDialog open={creating} onOpenChange={setCreating} />
      <RevokeDialog token={revoking} onClose={() => setRevoking(null)} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------

function RevokeDialog({ token, onClose }: { token: ApiToken | null; onClose: () => void }) {
  const qc = useQueryClient();
  const online = useOnline();
  const revoke = useMutation({
    mutationFn: (id: string) => unwrapVoid(api.DELETE("/auth/tokens/{tokenId}", { params: { path: { tokenId: id } } })),
    onSuccess: async () => {
      onClose();
      toast.success("Token revoked", { description: "Agents using it lose access immediately." });
      await qc.invalidateQueries({ queryKey: apiTokensKey });
    },
    onError: (e) => {
      onClose();
      toast.error("Couldn't revoke the token", { description: errorMessage(e) });
      void qc.invalidateQueries({ queryKey: apiTokensKey });
    },
  });

  return (
    <AlertDialog open={token !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke “{token?.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            Any agent using this token stops working immediately. This can&apos;t be undone — you would have to create
            a new token and update the agent.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={revoke.isPending || !online}
            onClick={(e) => {
              e.preventDefault();
              if (token) revoke.mutate(token.id);
            }}
          >
            {revoke.isPending ? "Revoking…" : "Revoke token"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ---------------------------------------------------------------------------------------------

export function CreateTokenDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  // While the one-time secret is on screen the dialog can only be left through "I've saved it".
  const [locked, setLocked] = useState(false);
  const change = (next: boolean) => {
    if (!next) setLocked(false);
    onOpenChange(next);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next || !locked) change(next);
      }}
    >
      <DialogContent
        className="sm:max-w-2xl"
        showClose={!locked}
        onEscapeKeyDown={(e) => locked && e.preventDefault()}
        onInteractOutside={(e) => locked && e.preventDefault()}
      >
        <CreateTokenBody onLock={setLocked} onClose={() => change(false)} />
      </DialogContent>
    </Dialog>
  );
}

function CreateTokenBody({ onLock, onClose }: { onLock: (locked: boolean) => void; onClose: () => void }) {
  const qc = useQueryClient();
  const online = useOnline();
  const { workspaces } = useSession();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<TokenScope>("read");
  const [workspaceId, setWorkspaceId] = useState("");
  const [expiry, setExpiry] = useState<string>("90");
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedApiToken | null>(null);

  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/auth/tokens", {
          body: {
            name: name.trim(),
            scope,
            ...(workspaceId ? { workspaceId } : {}),
            ...(expiry !== "never" ? { expiresInDays: Number(expiry) } : {}),
          },
        }),
      ),
    onSuccess: async (result) => {
      setCreated(result);
      onLock(true);
      await qc.invalidateQueries({ queryKey: apiTokensKey });
    },
    onError: (e) =>
      setFormError(
        hasStatus(e, 501)
          ? "Access tokens aren't available on this server yet. Update it and try again."
          : hasStatus(e, 403)
            ? "You can't create access tokens."
            : errorMessage(e),
      ),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    const err = validateName(name, "a name for the token");
    setNameError(err);
    if (err) return;
    create.mutate();
  };

  if (created) return <CreatedView created={created} onDone={onClose} />;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Create access token</DialogTitle>
        <DialogDescription>
          Give an AI agent access to your pages. The token is shown once, right after you create it.
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} noValidate className="grid gap-4">
        <FormError message={formError} />
        <FormField label="Name" error={nameError} hint="Something that tells you which agent uses it.">
          {(p) => (
            <Input
              {...p}
              value={name}
              maxLength={100}
              autoComplete="off"
              placeholder="Claude Code on my laptop"
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </FormField>

        <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0">
          <legend className="mb-1 text-[13px] font-medium">What can the agent do?</legend>
          {SCOPES.map((s) => (
            <label
              key={s.value}
              className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-accent/50 has-[:checked]:border-primary/60 has-[:checked]:bg-primary/5 has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/25"
            >
              <input
                type="radio"
                name="token-scope"
                value={s.value}
                checked={scope === s.value}
                onChange={() => setScope(s.value)}
                className="mt-0.5 size-5 shrink-0 cursor-pointer accent-primary md:size-4"
              />
              <span className="grid gap-0.5 text-sm font-medium">
                {s.label}
                <span className="text-[13px] font-normal text-muted-foreground">{s.description}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Workspace">
            {(p) => (
              <NativeSelect {...p} className="w-full" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
                <option value="">All my workspaces</option>
                {workspaces.map((m) => (
                  <option key={m.workspace.id} value={m.workspace.id}>
                    {m.workspace.name}
                  </option>
                ))}
              </NativeSelect>
            )}
          </FormField>
          <FormField label="Expires">
            {(p) => (
              <NativeSelect {...p} className="w-full" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
                {EXPIRY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </NativeSelect>
            )}
          </FormField>
        </div>

        {online ? null : (
          <p role="status" className="text-[13px] text-muted-foreground">
            You&apos;re offline. Creating a token needs a connection.
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending || !online}>
            {create.isPending ? "Creating…" : "Create token"}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

function CreatedView({ created, onDone }: { created: CreatedApiToken; onDone: () => void }) {
  const { token, mcpUrl, apiToken } = created;
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <span className="flex size-6 items-center justify-center rounded-full bg-success/15 text-success">
            <Check className="size-4" aria-hidden="true" />
          </span>
          Token created
        </DialogTitle>
        <DialogDescription>
          Copy “{apiToken.name}” now. For your security it is shown only this once and can&apos;t be retrieved later.
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3.5">
        <p id="token-secret-label" className="text-[13px] font-medium">
          Your access token
        </p>
        <div className="flex flex-wrap gap-2">
          <code
            data-testid="token-secret"
            aria-labelledby="token-secret-label"
            className="min-w-0 flex-1 basis-60 rounded-md border bg-background px-3 py-2.5 font-mono text-[13px] break-all select-all"
          >
            {token}
          </code>
          <CopyButton value={token} label="Copy token" size="default" variant="secondary" />
        </div>
      </div>

      <div className="grid gap-4">
        <div>
          <h3 className="text-sm font-semibold">Connect your agent</h3>
          <p className="text-[13px] text-muted-foreground">
            Server URL: <span className="font-mono break-all">{mcpUrl}</span>
          </p>
        </div>
        <Snippet title="Claude Code" copyLabel="Copy command" text={claudeCodeCommand(mcpUrl, token)} />
        <Snippet
          title="Cursor and other MCP clients (JSON)"
          copyLabel="Copy JSON config"
          text={genericJsonConfig(mcpUrl, token)}
          note="Cursor: paste into ~/.cursor/mcp.json."
        />
        <Snippet
          title="Claude Desktop"
          copyLabel="Copy Claude Desktop config"
          text={claudeDesktopConfig(mcpUrl, token)}
          note="Claude Desktop can't send a custom header to a remote server directly, so this uses the mcp-remote bridge (needs Node.js). Add it to claude_desktop_config.json."
        />
      </div>

      <DialogFooter>
        <Button type="button" onClick={onDone}>
          I&apos;ve saved it
        </Button>
      </DialogFooter>
    </>
  );
}

function Snippet({
  title,
  text,
  copyLabel,
  note,
}: {
  title: string;
  text: string;
  copyLabel: string;
  note?: string;
}) {
  return (
    <figure className="m-0 grid gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <figcaption className="text-[13px] font-medium">{title}</figcaption>
        <CopyButton value={text} label={copyLabel} />
      </div>
      <pre
        tabIndex={0}
        className="m-0 rounded-md border bg-muted/50 p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap"
      >
        <code>{text}</code>
      </pre>
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
    </figure>
  );
}
