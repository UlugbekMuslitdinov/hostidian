import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { qk } from "@/lib/api/keys";
import { OfflineRuntimeProvider } from "@/lib/offline/context";
import { createOfflineRuntime } from "@/lib/offline/runtime";
import { createMemoryStore } from "@/lib/offline/test-helpers";
import { createQueryClient } from "@/lib/query/client";
import { fetchMock, errorResponse, jsonResponse } from "@/test/fetch-mock";
import { makeMe } from "@/test/factories";
import { navigation } from "@/test/navigation-mock";
import { AuthGate } from "./auth-gate";

function setup(cachedAt: number | null) {
  const qc = createQueryClient();
  qc.setDefaultOptions({ ...qc.getDefaultOptions(), queries: { ...qc.getDefaultOptions().queries, retry: false } });
  const me = makeMe();
  if (cachedAt !== null) qc.setQueryData(qk.me(), me, { updatedAt: cachedAt });
  const runtime = createOfflineRuntime({
    queryClient: qc,
    store: createMemoryStore(),
    scope: { get: () => me.user.id, set() {}, clear() {}, refresh() {} },
    window: null,
  });
  render(
    <OfflineRuntimeProvider runtime={runtime}>
      <QueryClientProvider client={qc}>
        <AuthGate>
          <p>the workspace</p>
        </AuthGate>
      </QueryClientProvider>
    </OfflineRuntimeProvider>,
  );
  return { qc, me, runtime };
}

describe("<AuthGate/> and the offline identity", () => {
  it("does not show anything of an identity restored from a previous session until the server confirms it", async () => {
    let answer!: (r: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (answer = resolve)));
    const { me } = setup(1);
    expect(screen.getByText("Checking your session…")).toBeInTheDocument();
    expect(screen.queryByText("the workspace")).not.toBeInTheDocument();
    answer(jsonResponse(me));
    expect(await screen.findByText("the workspace")).toBeInTheDocument();
  });

  it("an expired session never reveals the cached workspace: it goes to sign-in", async () => {
    fetchMock.mockImplementation(async (request) => {
      if (new URL(request.url).pathname.endsWith("/auth/me")) return errorResponse(401, "unauthorized", "no session");
      return jsonResponse({ needsSetup: false, allowOpenSignup: false, oidc: { enabled: false }, instanceName: "H", version: "x" });
    });
    setup(1);
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/login"));
    expect(screen.queryByText("the workspace")).not.toBeInTheDocument();
  });

  it("when the server cannot be reached the cached identity is trusted (offline start)", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    setup(1);
    // The identity query retries a network failure once after a second before giving up on the server.
    expect(await screen.findByText("the workspace", {}, { timeout: 4000 })).toBeInTheDocument();
  });

  it("an identity obtained in this session (login) renders at once", () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => undefined));
    setup(Date.now() + 1000);
    expect(screen.getByText("the workspace")).toBeInTheDocument();
  });
});



