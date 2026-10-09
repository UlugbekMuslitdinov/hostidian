import type { QueryClient } from "@tanstack/react-query";
import { mutationKeys } from "@/lib/query/mutations";

/** Is `pageId` a page this browser created whose `createPage` mutation hasn't reached the server yet? */
export function hasPendingCreate(qc: QueryClient, pageId: string): boolean {
  const wanted = pageId.toLowerCase();
  return qc
    .getMutationCache()
    .findAll({ mutationKey: mutationKeys.createPage })
    .some(
      (mutation) =>
        mutation.state.status === "pending" &&
        (mutation.state.variables as { id?: string } | undefined)?.id?.toLowerCase() === wanted,
    );
}
