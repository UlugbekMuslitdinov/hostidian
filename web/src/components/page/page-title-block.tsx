"use client";

import { ImagePlus, SmilePlus } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { coverBackground } from "@/lib/covers";
import { cn } from "@/lib/utils";
import type { PageSummary } from "@hostidian/api-types";
import { CoverPicker } from "./cover-picker";
import { IconPicker } from "./icon-picker";

const SAVE_DEBOUNCE_MS = 600;

export function PageCover({
  cover,
  editable,
  onChange,
}: {
  cover: string | null | undefined;
  editable: boolean;
  onChange: (cover: string | null) => void;
}) {
  const background = coverBackground(cover);
  if (!background) return null;
  return (
    <div
      className="group/cover relative h-[24vh] max-h-[220px] min-h-[110px] w-full"
      style={{ background }}
      role="img"
      aria-label="Page cover"
    >
      {editable && (
        <div className="absolute right-3 bottom-3 pr-safe opacity-0 transition-opacity group-focus-within/cover:opacity-100 group-hover/cover:opacity-100 [@media(hover:none)]:opacity-100">
          <CoverPicker value={cover} onChange={onChange}>
            <Button variant="secondary" size="sm" className="bg-background/85 backdrop-blur hover:bg-background">
              <ImagePlus /> Change cover
            </Button>
          </CoverPicker>
        </div>
      )}
    </div>
  );
}

/** Icon, "add icon / add cover" affordances and the inline-editable title. */
export function PageTitleBlock({
  page,
  editable,
  onSaveTitle,
  onChangeIcon,
  onChangeCover,
}: {
  page: Pick<PageSummary, "id" | "title" | "icon" | "cover">;
  editable: boolean;
  onSaveTitle: (title: string) => void;
  onChangeIcon: (icon: string | null) => void;
  onChangeCover: (cover: string | null) => void;
}) {
  const hasCover = Boolean(coverBackground(page.cover));
  const icon = page.icon;

  return (
    <div className={cn("group/title relative pt-6 pb-1 md:pt-8", hasCover && icon && "-mt-10 pt-0 md:-mt-12 md:pt-0")}>
      {icon ? (
        editable ? (
          <IconPicker value={icon} onChange={onChangeIcon}>
            <button
              type="button"
              aria-label="Change page icon"
              className="mb-2 grid size-[72px] place-items-center rounded-lg text-[60px] leading-none transition-colors hover:bg-accent"
            >
              {icon}
            </button>
          </IconPicker>
        ) : (
          <span className="mb-2 grid size-[72px] place-items-center text-[60px] leading-none" aria-hidden="true">
            {icon}
          </span>
        )
      ) : null}

      {editable && (!icon || !hasCover) && (
        <div className="mb-1 flex flex-wrap gap-1 opacity-0 transition-opacity group-focus-within/title:opacity-100 group-hover/title:opacity-100 [@media(hover:none)]:opacity-100">
          {!icon && (
            <IconPicker value={icon} onChange={onChangeIcon}>
              <Button variant="ghost" size="sm" className="text-muted-foreground">
                <SmilePlus /> Add icon
              </Button>
            </IconPicker>
          )}
          {!hasCover && (
            <CoverPicker value={page.cover} onChange={onChangeCover}>
              <Button variant="ghost" size="sm" className="text-muted-foreground">
                <ImagePlus /> Add cover
              </Button>
            </CoverPicker>
          )}
        </div>
      )}

      <TitleInput title={page.title} editable={editable} onSave={onSaveTitle} />
    </div>
  );
}

function TitleInput({
  title,
  editable,
  onSave,
}: {
  title: string;
  editable: boolean;
  onSave: (title: string) => void;
}) {
  const [value, setValue] = useState(title);
  const [seenTitle, setSeenTitle] = useState(title);
  const [focused, setFocused] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const latest = useRef(title);
  const lastSaved = useRef(title);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSaveRef = useRef(onSave);

  // Adopt remote/optimistic title changes, but never while the user is typing here.
  if (title !== seenTitle) {
    setSeenTitle(title);
    if (!focused) {
      setValue(title);
    }
  }

  useEffect(() => {
    onSaveRef.current = onSave;
  });

  useEffect(() => {
    if (!focused) {
      latest.current = title;
      lastSaved.current = title;
    }
  }, [title, focused]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (latest.current !== lastSaved.current) {
      lastSaved.current = latest.current;
      onSaveRef.current(latest.current);
    }
  }, []);

  // Don't lose the last keystrokes when navigating away.
  useEffect(() => flush, [flush]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      flush();
      const editor = document.querySelector<HTMLElement>('[data-page-editor] [contenteditable="true"]');
      if (editor) editor.focus();
      else e.currentTarget.blur();
    }
  };

  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      readOnly={!editable}
      maxLength={500}
      aria-label="Page title"
      placeholder="Untitled"
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        flush();
      }}
      onKeyDown={onKeyDown}
      onChange={(e) => {
        const next = e.target.value.replace(/\n/g, " ");
        setValue(next);
        latest.current = next;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
      }}
      className="block w-full resize-none overflow-hidden bg-transparent text-[30px] leading-[1.15] font-bold tracking-tight text-foreground outline-none placeholder:text-muted-foreground/50 read-only:cursor-default md:text-[40px]"
    />
  );
}
