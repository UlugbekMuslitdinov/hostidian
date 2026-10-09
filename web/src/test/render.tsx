import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { createQueryClient } from "@/lib/query/client";
import { setupMutationDefaults } from "@/lib/query/mutations";
import { SessionProvider } from "@/lib/session";
import { WorkspaceProvider, type WorkspaceValue } from "@/lib/workspace";
import { TooltipProvider } from "@/components/ui/tooltip";
import { makeMe, makeMembership } from "./factories";
import type { Me } from "@hostidian/api-types";

export function makeTestQueryClient(): QueryClient {
  const qc = createQueryClient();
  qc.setDefaultOptions({
    ...qc.getDefaultOptions(),
    queries: { ...qc.getDefaultOptions().queries, retry: false, gcTime: Infinity },
    mutations: { ...qc.getDefaultOptions().mutations, retry: false },
  });
  setupMutationDefaults(qc);
  return qc;
}

export function renderWithApp(
  ui: ReactElement,
  options: {
    qc?: QueryClient;
    me?: Me;
    workspace?: WorkspaceValue | null;
    wrap?: (children: ReactNode) => ReactNode;
  } = {},
) {
  const qc = options.qc ?? makeTestQueryClient();
  const me = options.me ?? makeMe();
  const membership = me.workspaces[0] ?? makeMembership();
  const workspace =
    options.workspace === undefined
      ? { workspace: membership.workspace, role: membership.role, memberships: me.workspaces }
      : options.workspace;
  const tree = (
    <QueryClientProvider client={qc}>
      <SessionProvider me={me}>
        <WorkspaceProvider value={workspace}>
          <TooltipProvider>{options.wrap ? options.wrap(ui) : ui}</TooltipProvider>
        </WorkspaceProvider>
      </SessionProvider>
    </QueryClientProvider>
  );
  return { qc, ...render(tree) };
}
