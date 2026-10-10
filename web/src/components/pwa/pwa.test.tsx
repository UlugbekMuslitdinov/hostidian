import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OfflineRuntimeProvider } from "@/lib/offline/context";
import { connectivityStore } from "@/lib/offline/connectivity-store";
import { dismissInstallCard, resetInstallStateForTests, startInstallTracking, type BeforeInstallPromptEvent } from "@/lib/offline/install";
import { writePrefetchRecords } from "@/lib/offline/prefetch";
import { createOfflineRuntime } from "@/lib/offline/runtime";
import { createMemoryStore } from "@/lib/offline/test-helpers";
import { persistStatus } from "@/lib/offline/persister";
import { renderWithApp } from "@/test/render";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConnectionStatus } from "./connection-status";
import { InstallCard } from "./install-card";
import { OfflineBanner, useBannerState } from "./offline-banner";
import { OnlineOnly } from "./online-only";
import { bannerText, describeSync } from "./sync-copy";

function setup(ui: React.ReactElement) {
  const runtime = createOfflineRuntime({
    queryClient: new QueryClient(),
    store: createMemoryStore(),
    scope: { get: () => "user-1", set() {}, clear() {}, refresh() {} },
    window: null,
  });
  const view = renderWithApp(<OfflineRuntimeProvider runtime={runtime}>{ui}</OfflineRuntimeProvider>);
  return { runtime, ...view };
}

afterEach(() => {
  act(() => {
    connectivityStore.set({ online: true });
    persistStatus.set({ state: "ok" });
  });
});

describe("sync copy", () => {
  it("describes each state", () => {
    expect(describeSync("online", 0).label).toBe("Online");
    expect(describeSync("offline", 0).label).toBe("Offline");
    expect(describeSync("offline", 3).label).toBe("Offline · 3 changes saved");
    expect(describeSync("syncing", 1).label).toBe("Syncing 1 change…");
    expect(describeSync("error", 0, "nope").detail).toContain("nope");
    expect(bannerText("online", 0)).toBeNull();
    expect(bannerText("offline", 2)).toMatch(/2 changes will sync/);
  });
});

describe("<ConnectionStatus/>", () => {
  it("shows online by default", () => {
    setup(<ConnectionStatus />);
    expect(screen.getByTestId("connection-status")).toHaveAttribute("data-sync-state", "online");
    expect(screen.getByTestId("connection-status")).toHaveTextContent("Online");
  });

  it("shows offline with the number of queued changes, and a Retry action in the popover", async () => {
    const view = setup(<ConnectionStatus />);
    act(() => connectivityStore.set({ online: false }));
    expect(screen.getByTestId("connection-status")).toHaveAttribute("data-sync-state", "offline");

    view.qc.getMutationCache(); // the runtime watches ITS client; queue one change there
    const { runtime } = view;
    runtime.queryClient.setMutationDefaults(["op"], { mutationFn: () => new Promise(() => undefined), networkMode: "offlineFirst" });
    act(() => {
      void runtime.queryClient.getMutationCache().build(runtime.queryClient, { mutationKey: ["op"] }).execute(1);
    });
    expect(screen.getByTestId("connection-status")).toHaveTextContent("Offline · 1 change saved");

    writePrefetchRecords("user-1", { a: 1, b: 2 });
    fireEvent.click(screen.getByTestId("connection-status"));
    expect(await screen.findByRole("button", { name: /retry now/i })).toBeInTheDocument();
    expect(screen.getByText(/2 pages available offline/)).toBeInTheDocument();
  });

  it("warns when offline storage is full or unavailable", async () => {
    setup(<ConnectionStatus />);
    act(() => persistStatus.set({ state: "quota" }));
    fireEvent.click(screen.getByTestId("connection-status"));
    expect(await screen.findByText(/almost full/i)).toBeInTheDocument();
  });
});

describe("<OfflineBanner/>", () => {
  function Banner() {
    const banner = useBannerState();
    return banner ? <OfflineBanner banner={banner} /> : <p>nothing</p>;
  }

  it("is absent when online and describes the situation otherwise", () => {
    setup(<Banner />);
    expect(screen.getByText("nothing")).toBeInTheDocument();
    act(() => connectivityStore.set({ online: false }));
    const banner = screen.getByTestId("offline-banner");
    expect(banner).toHaveAttribute("role", "status");
    expect(banner).toHaveTextContent(/offline/i);
    expect(banner).toHaveStyle({ paddingTop: "env(safe-area-inset-top, 0px)" });
  });
});

describe("<OnlineOnly/>", () => {
  it("leaves the control alone while online", () => {
    renderWithApp(
      <OnlineOnly reason="Sharing needs a connection.">
        <button type="button">Share</button>
      </OnlineOnly>,
    );
    expect(screen.getByRole("button", { name: "Share" })).toBeEnabled();
    expect(document.querySelector("[data-offline-disabled]")).toBeNull();
  });

  it("disables the control offline and explains why, without firing its handler", () => {
    const onClick = vi.fn();
    render(
      <TooltipProvider>
        <OnlineOnly reason="Sharing needs a connection.">
          <button type="button" onClick={onClick}>
            Share
          </button>
        </OnlineOnly>
      </TooltipProvider>,
    );
    act(() => connectivityStore.set({ online: false }));
    const button = screen.getByRole("button", { name: /share/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(screen.getAllByText("Sharing needs a connection.").length).toBeGreaterThan(0); // sr-only reason
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("<InstallCard/>", () => {
  beforeAll(() => {
    window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    startInstallTracking();
  });
  beforeEach(() => resetInstallStateForTests());

  function fireInstallable() {
    const prompt = vi.fn(async () => undefined);
    const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
      prompt,
      userChoice: Promise.resolve({ outcome: "accepted" as const }),
    }) as BeforeInstallPromptEvent;
    act(() => void window.dispatchEvent(event));
    return prompt;
  }

  it("renders nothing until the browser says the app is installable", () => {
    render(<InstallCard />);
    expect(screen.queryByTestId("install-card")).not.toBeInTheDocument();
  });

  it("offers the native install and hides after being dismissed", async () => {
    render(<InstallCard />);
    const prompt = fireInstallable();
    expect(screen.getByTestId("install-card")).toHaveAttribute("data-install-kind", "prompt");
    fireEvent.click(screen.getByRole("button", { name: /install$/i }));
    expect(prompt).toHaveBeenCalled();
  });

  it("remembers the dismissal", () => {
    const { unmount } = render(<InstallCard />);
    fireInstallable();
    fireEvent.click(screen.getByRole("button", { name: /not now/i }));
    expect(screen.queryByTestId("install-card")).not.toBeInTheDocument();
    unmount();
    render(<InstallCard />);
    expect(screen.queryByTestId("install-card")).not.toBeInTheDocument();
    dismissInstallCard(0);
  });

  it("shows the Share, Add to Home Screen instructions on iOS", () => {
    const nav = vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)");
    startInstallTracking(); // idempotent, but make sure the snapshot is recomputed
    act(() => void window.dispatchEvent(new Event("appinstalled")));
    render(<InstallCard />);
    const card = screen.getByTestId("install-card");
    expect(card).toHaveAttribute("data-install-kind", "ios");
    expect(card).toHaveTextContent(/Add to Home Screen/);
    expect(screen.getByRole("button", { name: /got it/i })).toBeInTheDocument();
    nav.mockRestore();
  });
});
