"use client";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { pageTitle } from "@/lib/utils";
import type { PageSummary } from "@hostidian/api-types";
import { PublicLinkTab } from "./public-link-tab";
import { SharePeopleTab } from "./share-people-tab";

export type SharePage = Pick<PageSummary, "id" | "title" | "role" | "parentId">;

export function ShareDialog({
  open,
  onOpenChange,
  page,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  page: SharePage;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Share “{pageTitle(page.title)}”</DialogTitle>
          <DialogDescription>Invite people to this page, or publish it with a public link.</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="share">
          <TabsList aria-label="Sharing options">
            <TabsTrigger value="share">Share</TabsTrigger>
            <TabsTrigger value="public">Public link</TabsTrigger>
          </TabsList>
          <TabsContent value="share" className="pt-3">
            {open ? <SharePeopleTab page={page} /> : null}
          </TabsContent>
          <TabsContent value="public" className="pt-3">
            {open ? <PublicLinkTab page={page} /> : null}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
