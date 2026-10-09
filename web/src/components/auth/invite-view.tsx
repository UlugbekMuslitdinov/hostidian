"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { FormError } from "@/components/common/form-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api/client";
import { errorMessage, hasStatus } from "@/lib/api/error";
import { qk } from "@/lib/api/keys";
import { inviteInfoOptions, meOptions } from "@/lib/api/queries";
import { unwrap } from "@/lib/api/unwrap";
import { WORKSPACE_ROLE_LABELS } from "@/lib/permissions";
import { workspaceHref } from "@/lib/utils";
import { AuthCard } from "./auth-card";
import { RegisterForm } from "./register-form";

export function InviteView({ token }: { token: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const invite = useQuery(inviteInfoOptions(token));
  const me = useQuery(meOptions());
  const [joinError, setJoinError] = useState<string | null>(null);

  const join = useMutation({
    mutationFn: () => unwrap(api.POST("/auth/invites/{token}", { params: { path: { token } } })),
    onSuccess: (updated) => {
      const before = new Set((me.data?.workspaces ?? []).map((w) => w.workspace.id));
      const joined = updated.workspaces.find((w) => !before.has(w.workspace.id)) ?? updated.workspaces[0];
      qc.setQueryData(qk.me(), updated);
      router.replace(joined ? workspaceHref(joined.workspace.slug) : "/");
    },
    onError: (error) => {
      if (hasStatus(error, 409))
        setJoinError("You're already a member of this workspace, or this invite was already used.");
      else if (hasStatus(error, 404)) setJoinError("This invite is no longer valid.");
      else setJoinError(errorMessage(error));
    },
  });

  if (invite.isPending || me.isPending) {
    return (
      <AuthCard title="Loading invite…">
        <div className="grid gap-3" aria-busy="true">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-11" />
          <Skeleton className="h-11" />
        </div>
      </AuthCard>
    );
  }

  if (invite.isError) {
    const gone = hasStatus(invite.error, 404);
    return (
      <AuthCard
        title={gone ? "Invite not found" : "Couldn't load the invite"}
        description={
          gone
            ? "This invite link is invalid, has expired, or was already used. Ask for a new one."
            : errorMessage(invite.error)
        }
      >
        <Button variant="outline" size="lg" className="w-full" asChild>
          <Link href="/login">Go to login</Link>
        </Button>
      </AuthCard>
    );
  }

  const { workspaceName, role, email } = invite.data;
  const summary = (
    <>
      You&apos;ve been invited to join <strong className="font-semibold text-foreground">{workspaceName}</strong> as{" "}
      <Badge variant="primary" className="align-middle">
        {WORKSPACE_ROLE_LABELS[role]}
      </Badge>
    </>
  );

  if (me.data) {
    return (
      <AuthCard title="Join workspace" description={summary}>
        <div className="grid gap-4">
          <FormError message={joinError} />
          <p className="text-sm text-muted-foreground">
            You&apos;re signed in as <strong className="font-medium text-foreground">{me.data.user.email}</strong>.
          </p>
          <Button size="lg" disabled={join.isPending} onClick={() => join.mutate()}>
            {join.isPending ? "Joining…" : `Join ${workspaceName}`}
          </Button>
          <Button variant="ghost" asChild>
            <Link href="/">Not now</Link>
          </Button>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Create your account"
      description={summary}
      footer={
        <>
          Already have an account?{" "}
          <Link
            href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            Log in to join
          </Link>
        </>
      }
    >
      <RegisterForm inviteToken={token} lockedEmail={email} submitLabel="Create account and join" />
    </AuthCard>
  );
}
