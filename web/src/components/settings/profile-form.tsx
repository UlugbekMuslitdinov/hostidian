"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { FormError, FormField } from "@/components/common/form-field";
import { UserAvatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/error";
import { qk } from "@/lib/api/keys";
import { unwrap } from "@/lib/api/unwrap";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { validateName } from "@/lib/validation";
import type { Me } from "@hostidian/api-types";
import { SettingsSection } from "./settings-shell";

export const AVATAR_COLORS = [
  "#e57373",
  "#f06292",
  "#ba68c8",
  "#9575cd",
  "#7986cb",
  "#64b5f6",
  "#4dd0e1",
  "#4db6ac",
  "#81c784",
  "#aed581",
  "#ffd54f",
  "#ffb74d",
  "#ff8a65",
  "#a1887f",
  "#90a4ae",
] as const;

const HEX = /^#[0-9a-fA-F]{6}$/;

export function ProfileForm() {
  const { user } = useSession();
  const qc = useQueryClient();
  const [name, setName] = useState(user.name);
  const [color, setColor] = useState(user.avatarColor);
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  useDocumentTitle("Profile settings");

  const save = useMutation({
    mutationFn: () => unwrap(api.PATCH("/auth/profile", { body: { name: name.trim(), avatarColor: color } })),
    onSuccess: (updated) => {
      qc.setQueryData<Me>(qk.me(), (old) => (old ? { ...old, user: updated } : old));
      toast.success("Profile saved");
    },
    onError: (e) => setFormError(errorMessage(e)),
  });

  const colorValid = HEX.test(color);
  const dirty = name.trim() !== user.name || color.toLowerCase() !== user.avatarColor.toLowerCase();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const err = validateName(name);
    setNameError(err);
    if (err) return;
    if (!colorValid) {
      setFormError("Use a colour like #4db6ac.");
      return;
    }
    save.mutate();
  };

  return (
    <SettingsSection title="Profile" description="How you appear to other people in your workspaces.">
      <form onSubmit={submit} className="grid max-w-md gap-5" noValidate>
        <FormError message={formError} />
        <div className="flex items-center gap-4">
          <UserAvatar
            name={name || user.name}
            color={colorValid ? color : user.avatarColor}
            className="size-14 text-lg"
          />
          <div className="min-w-0">
            <p className="truncate font-medium">{name.trim() || user.name}</p>
            <p className="truncate text-sm text-muted-foreground">{user.email}</p>
          </div>
        </div>
        <FormField label="Name" error={nameError}>
          {(p) => <Input {...p} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />}
        </FormField>
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-[13px] font-medium">Avatar colour</legend>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Avatar colour">
            {AVATAR_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={color.toLowerCase() === c}
                aria-label={c}
                onClick={() => setColor(c)}
                style={{ backgroundColor: c }}
                className={cn(
                  "size-9 rounded-full border border-black/10 transition-transform hover:scale-110 md:size-7",
                  color.toLowerCase() === c && "ring-2 ring-ring ring-offset-2 ring-offset-background",
                )}
              />
            ))}
          </div>
          <FormField label="Custom colour" error={colorValid ? null : "Use a hex colour like #4db6ac."}>
            {(p) => (
              <Input
                {...p}
                value={color}
                maxLength={7}
                className="w-32 font-mono"
                onChange={(e) => setColor(e.target.value)}
              />
            )}
          </FormField>
        </fieldset>
        <Button type="submit" className="w-fit" disabled={save.isPending || !dirty}>
          {save.isPending ? "Saving…" : "Save changes"}
        </Button>
      </form>
    </SettingsSection>
  );
}
