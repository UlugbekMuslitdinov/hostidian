"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { FormError, FormField } from "@/components/common/form-field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api/client";
import { errorMessage, hasStatus } from "@/lib/api/error";
import { qk } from "@/lib/api/keys";
import { unwrap } from "@/lib/api/unwrap";
import { useAppNavigate } from "@/lib/nav";
import { slugify } from "@/lib/slug";
import { workspaceHref } from "@/lib/utils";

export function CreateWorkspaceForm({ onCreated, onCancel }: { onCreated?: () => void; onCancel?: () => void }) {
  const qc = useQueryClient();
  const navigate = useAppNavigate();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveSlug = slugTouched ? slug : slugify(name);

  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/workspaces", {
          body: { name: name.trim(), ...(effectiveSlug ? { slug: effectiveSlug } : {}) },
        }),
      ),
    onSuccess: async (membership) => {
      await qc.invalidateQueries({ queryKey: qk.me() });
      toast.success(`Workspace "${membership.workspace.name}" created`);
      onCreated?.();
      navigate(workspaceHref(membership.workspace.slug));
    },
    onError: (e) => {
      if (hasStatus(e, 403)) {
        setError("Workspace creation is disabled on this instance. Ask an administrator for an invite instead.");
      } else if (hasStatus(e, 409)) {
        setError("That URL name is already taken. Try a different one.");
      } else {
        setError(errorMessage(e));
      }
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("Give the workspace a name.");
      return;
    }
    create.mutate();
  };

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      <FormError message={error} />
      <FormField label="Name">
        {(p) => (
          <Input
            {...p}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            autoFocus
            placeholder="Acme Inc."
          />
        )}
      </FormField>
      <FormField label="URL name" hint="Lowercase letters, numbers and dashes. Used in links.">
        {(p) => (
          <Input
            {...p}
            value={effectiveSlug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value.toLowerCase());
            }}
            maxLength={60}
            placeholder="acme"
          />
        )}
      </FormField>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? "Creating…" : "Create workspace"}
        </Button>
      </div>
    </form>
  );
}

export function CreateWorkspaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a workspace</DialogTitle>
          <DialogDescription>A workspace holds pages and members. You&apos;ll be its owner.</DialogDescription>
        </DialogHeader>
        <CreateWorkspaceForm onCreated={() => onOpenChange(false)} onCancel={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
