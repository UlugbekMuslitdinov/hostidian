"use client";

import { useQuery } from "@tanstack/react-query";
import { FilePlus2, Home, Moon, PanelLeft, Search, Settings, Sun, Trash2 } from "lucide-react";
import { useTheme } from "next-themes";
import { useMemo, useState, type ReactNode } from "react";
import { PageIcon } from "@/components/common/page-icon";
import { useAppUI } from "@/components/layout/app-ui";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { usePageActions } from "@/hooks/use-page-actions";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { pagesOptions, recentOptions, searchOptions } from "@/lib/api/queries";
import { useAppNavigate } from "@/lib/nav";
import { canCreateTopLevelPage } from "@/lib/permissions";
import { parseSnippet } from "@/lib/snippet";
import { pageHref, pageTitle, workspaceHref } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import type { PageSummary } from "@hostidian/api-types";

export function CommandPalette() {
  const { paletteOpen, setPaletteOpen } = useAppUI();
  return (
    <Dialog open={paletteOpen} onOpenChange={setPaletteOpen}>
      <DialogContent
        showClose={false}
        aria-describedby="palette-description"
        className="top-[10%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
      >
        <DialogTitle className="sr-only">Search and commands</DialogTitle>
        <DialogDescription id="palette-description" className="sr-only">
          Jump to a page, search page contents, or run a command.
        </DialogDescription>
        {/* Mounted only while open, so the query resets every time. */}
        {paletteOpen ? <PaletteBody close={() => setPaletteOpen(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

interface ActionItem {
  id: string;
  label: string;
  icon: ReactNode;
  shortcut?: string;
  run: () => void;
}

function PaletteBody({ close }: { close: () => void }) {
  const navigate = useAppNavigate();
  const { workspace, role } = useWorkspace();
  const ui = useAppUI();
  const { resolvedTheme, setTheme } = useTheme();
  const actions = usePageActions();
  const [query, setQuery] = useState("");
  // Local filtering follows the keystrokes immediately (so ↵ always acts on what you see); only the
  // server requests are debounced.
  const typed = query.trim();
  const q = useDebouncedValue(typed, 200);
  const settled = q === typed;

  const pagesQuery = useQuery(pagesOptions(workspace.id));
  const recentQuery = useQuery(recentOptions(workspace.id, 8));
  const titleSearch = useQuery({ ...searchOptions(workspace.id, "title", q), enabled: q.length > 0 });
  const fullSearch = useQuery({ ...searchOptions(workspace.id, "full", q, 6), enabled: q.length > 1 });

  const go = (href: string) => {
    close();
    navigate(href);
  };

  const commands = ((): ActionItem[] => {
    const list: ActionItem[] = [];
    if (canCreateTopLevelPage(role)) {
      list.push({
        id: "new-page",
        label: "New page",
        icon: <FilePlus2 />,
        shortcut: "⌘N",
        run: () => {
          close();
          actions.createPage({ parentId: null });
        },
      });
    }
    list.push(
      {
        id: "home",
        label: "Go to Home",
        icon: <Home />,
        shortcut: "G H",
        run: () => go(workspaceHref(workspace.slug)),
      },
      {
        id: "trash",
        label: "Go to Trash",
        icon: <Trash2 />,
        shortcut: "G T",
        run: () => go(`${workspaceHref(workspace.slug)}/trash`),
      },
      { id: "settings", label: "Go to Settings", icon: <Settings />, shortcut: "G S", run: () => go("/settings") },
      {
        id: "theme",
        label: "Toggle theme",
        icon: resolvedTheme === "dark" ? <Sun /> : <Moon />,
        run: () => {
          close();
          setTheme(resolvedTheme === "dark" ? "light" : "dark");
        },
      },
      {
        id: "sidebar",
        label: "Toggle sidebar",
        icon: <PanelLeft />,
        shortcut: "⌘\\",
        run: () => {
          close();
          ui.toggleSidebar();
        },
      },
    );
    return list;
  })();

  const localPages = pagesQuery.data;
  const recentPages: PageSummary[] = useMemo(() => {
    if (recentQuery.data && recentQuery.data.length > 0) return recentQuery.data;
    return [...(localPages ?? [])].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, 8);
  }, [recentQuery.data, localPages]);

  const titleMatches: PageSummary[] = useMemo(() => {
    if (!typed) return [];
    const needle = typed.toLowerCase();
    const local = (localPages ?? []).filter((p) => pageTitle(p.title).toLowerCase().includes(needle));
    const remote = settled && titleSearch.data ? titleSearch.data.map((r) => r.page) : [];
    const seen = new Set<string>();
    return [...remote, ...local].filter((p) => !seen.has(p.id) && seen.add(p.id)).slice(0, 8);
  }, [typed, settled, titleSearch.data, localPages]);

  const titleIds = new Set(titleMatches.map((p) => p.id));
  const contentMatches = (settled ? (fullSearch.data ?? []) : []).filter((r) => !titleIds.has(r.page.id));
  const filteredCommands = typed
    ? commands.filter((c) => c.label.toLowerCase().includes(typed.toLowerCase()))
    : commands;
  const searching = typed.length > 0 && (!settled || titleSearch.isFetching || fullSearch.isFetching);

  const pageItem = (p: PageSummary, extra?: ReactNode) => (
    <CommandItem key={`page-${p.id}`} value={`page-${p.id}`} onSelect={() => go(pageHref(workspace.slug, p.id))}>
      <PageIcon icon={p.icon} emojiClassName="text-[15px]" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{pageTitle(p.title)}</span>
        {extra}
      </span>
    </CommandItem>
  );

  return (
    <Command shouldFilter={false} loop label="Search and commands">
      <CommandInput value={query} onValueChange={setQuery} placeholder="Search pages or type a command…" />
      <CommandList>
        {typed && titleMatches.length === 0 && contentMatches.length === 0 && filteredCommands.length === 0 ? (
          <CommandEmpty>{searching ? "Searching…" : `No results for “${typed}”.`}</CommandEmpty>
        ) : null}

        {typed ? (
          <>
            {titleMatches.length > 0 && (
              <CommandGroup heading="Pages">{titleMatches.map((p) => pageItem(p))}</CommandGroup>
            )}
            {contentMatches.length > 0 && (
              <CommandGroup heading="In page content">
                {contentMatches.map((r) =>
                  pageItem(
                    r.page,
                    r.snippet ? (
                      <span className="line-clamp-1 text-xs text-muted-foreground">
                        {parseSnippet(r.snippet).map((part, i) =>
                          part.mark ? (
                            <mark key={i} className="rounded-sm bg-primary/20 px-0.5 text-foreground">
                              {part.text}
                            </mark>
                          ) : (
                            <span key={i}>{part.text}</span>
                          ),
                        )}
                      </span>
                    ) : null,
                  ),
                )}
              </CommandGroup>
            )}
          </>
        ) : (
          recentPages.length > 0 && <CommandGroup heading="Recent">{recentPages.map((p) => pageItem(p))}</CommandGroup>
        )}

        {filteredCommands.length > 0 && (
          <CommandGroup heading="Actions">
            {filteredCommands.map((c) => (
              <CommandItem key={c.id} value={`action-${c.id}`} onSelect={c.run}>
                {c.icon}
                <span>{c.label}</span>
                {c.shortcut ? <CommandShortcut>{c.shortcut}</CommandShortcut> : null}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {!typed && recentPages.length === 0 && filteredCommands.length === 0 && (
          <CommandEmpty>
            <Search className="mx-auto mb-2 size-5" aria-hidden="true" />
            Start typing to search.
          </CommandEmpty>
        )}
      </CommandList>
      <div className="hidden items-center gap-4 border-t px-3.5 py-2 text-xs text-muted-foreground md:flex">
        <span>↑↓ to navigate</span>
        <span>↵ to open</span>
        <span>esc to close</span>
      </div>
    </Command>
  );
}
