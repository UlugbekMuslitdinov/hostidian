"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/common/copy-button";
import { FormError } from "@/components/common/form-field";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api/client";
import { errorMessage, hasStatus } from "@/lib/api/error";
import { qk } from "@/lib/api/keys";
import { shareLinksOptions } from "@/lib/api/queries";
import { unwrap, unwrapVoid } from "@/lib/api/unwrap";
import { canShare } from "@/lib/permissions";
import { absoluteUrl } from "@/lib/utils";
import type { ShareLink } from "@hostidian/api-types";
import type { SharePage } from "./share-dialog";

function Unavailable() {
  return (
    <div className="flex items-start gap-3 rounded-md border bg-muted px-3 py-3 text-sm" role="status">
      <Globe className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div>
        <p className="font-medium">Public links aren&apos;t available yet</p>
        <p className="text-muted-foreground">
          This server doesn&apos;t support publishing pages to the web yet. Check back after the next update.
        </p>
      </div>
    </div>
  );
}

export function PublicLinkTab({ page }: { page: SharePage }) {
  const qc = useQueryClient();
  const allowed = canShare(page.role);
  const query = useQuery({ ...shareLinksOptions(page.id), enabled: allowed });
  const [includeSubpages, setIncludeSubpages] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [revoking, setRevoking] = useState<ShareLink | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: qk.shares(page.id) });

  const create = useMutation({
    mutationFn: () =>
      unwrap(api.POST("/pages/{pageId}/shares", { params: { path: { pageId: page.id } }, body: { includeSubpages } })),
    onSuccess: () => {
      toast.success("Public link created");
      return refresh();
    },
    onError: (e) => {
      if (hasStatus(e, 501)) setUnsupported(true);
      else toast.error("Couldn't create the link", { description: errorMessage(e) });
    },
  });

  const update = useMutation({
    mutationFn: (vars: { id: string; includeSubpages: boolean }) =>
      unwrap(
        api.PATCH("/shares/{shareId}", {
          params: { path: { shareId: vars.id } },
          body: { includeSubpages: vars.includeSubpages },
        }),
      ),
    onSuccess: refresh,
    onError: (e) => toast.error("Couldn't update the link", { description: errorMessage(e) }),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => unwrapVoid(api.DELETE("/shares/{shareId}", { params: { path: { shareId: id } } })),
    onSuccess: () => {
      toast.success("Public link revoked");
      setRevoking(null);
      return refresh();
    },
    onError: (e) => toast.error("Couldn't revoke the link", { description: errorMessage(e) }),
  });

  if (!allowed) {
    return (
      <p className="rounded-md border bg-muted px-3 py-3 text-sm text-muted-foreground" role="status">
        Only people with full access can create public links.
      </p>
    );
  }
  if (unsupported || hasStatus(query.error, 501)) return <Unavailable />;
  if (query.isPending) {
    return (
      <div className="grid gap-2" aria-busy="true" aria-label="Loading public links">
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="grid gap-2">
        <FormError message={errorMessage(query.error, "Couldn't load public links.")} />
        <Button variant="outline" className="w-fit" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const links = query.data.filter((l) => !l.revokedAt);

  return (
    <div className="grid gap-4">
      {links.length === 0 ? (
        <div className="grid gap-3">
          <p className="text-sm text-muted-foreground">
            Anyone with the link can view this page without signing in. They can&apos;t edit or see who else has access.
          </p>
          <div className="flex items-center gap-3">
            <Switch id="new-link-subpages" checked={includeSubpages} onCheckedChange={setIncludeSubpages} />
            <Label htmlFor="new-link-subpages">Include sub-pages</Label>
          </div>
          <Button className="w-fit" disabled={create.isPending} onClick={() => create.mutate()}>
            <Globe /> {create.isPending ? "Creating…" : "Create public link"}
          </Button>
        </div>
      ) : (
        <ul className="grid gap-4">
          {links.map((link) => (
            <li key={link.id} className="grid gap-3 rounded-lg border p-3">
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={absoluteUrl(link.url)}
                  aria-label="Public link URL"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <CopyButton value={absoluteUrl(link.url)} size="default" />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <Switch
                    id={`subpages-${link.id}`}
                    checked={link.includeSubpages}
                    disabled={update.isPending}
                    onCheckedChange={(checked) => update.mutate({ id: link.id, includeSubpages: checked })}
                  />
                  <Label htmlFor={`subpages-${link.id}`}>Include sub-pages</Label>
                </div>
                <Button variant="destructive-ghost" size="sm" onClick={() => setRevoking(link)}>
                  <Trash2 /> Revoke link
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <AlertDialog open={revoking !== null} onOpenChange={(open) => !open && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this public link?</AlertDialogTitle>
            <AlertDialogDescription>
              Anyone using the link will immediately lose access. You can create a new link later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={revoke.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (revoking) revoke.mutate(revoking.id);
              }}
            >
              {revoke.isPending ? "Revoking…" : "Revoke"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
