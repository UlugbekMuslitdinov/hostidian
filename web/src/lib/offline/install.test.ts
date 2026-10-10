import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INSTALL_DISMISS_COOLDOWN_MS,
  detectPlatform,
  dismissInstallCard,
  installCardKind,
  installStore,
  promptInstall,
  resetInstallStateForTests,
  startInstallTracking,
  type BeforeInstallPromptEvent,
  type InstallEligibility,
} from "./install";
import { OFFLINE_KEYS } from "./keys";

const base: InstallEligibility = { standalone: false, promptAvailable: false, platform: "other", dismissedAt: null, now: 1_000_000_000_000 };

describe("installCardKind", () => {
  it("offers the native prompt when the browser provided one", () => {
    expect(installCardKind({ ...base, promptAvailable: true })).toBe("prompt");
  });

  it("explains Add to Home Screen on iOS, where no prompt exists", () => {
    expect(installCardKind({ ...base, platform: "ios" })).toBe("ios");
    expect(installCardKind({ ...base, platform: "ios", promptAvailable: true })).toBe("prompt");
  });

  it("shows nothing when there is nothing to offer, or the app is already installed", () => {
    expect(installCardKind(base)).toBeNull();
    expect(installCardKind({ ...base, promptAvailable: true, standalone: true })).toBeNull();
    expect(installCardKind({ ...base, platform: "ios", standalone: true })).toBeNull();
  });

  it("stays away after being dismissed, and comes back after the cooldown", () => {
    const dismissed = { ...base, promptAvailable: true, dismissedAt: base.now - 1000 };
    expect(installCardKind(dismissed)).toBeNull();
    expect(installCardKind({ ...dismissed, now: dismissed.dismissedAt! + INSTALL_DISMISS_COOLDOWN_MS + 1 })).toBe("prompt");
  });
});

describe("detectPlatform", () => {
  it("recognises iPhone, iPad and iPadOS (which poses as a Mac)", () => {
    expect(detectPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", "iPhone", 5)).toBe("ios");
    expect(detectPlatform("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)", "iPad", 5)).toBe("ios");
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel", 5)).toBe("ios");
  });

  it("does not mistake desktops and Android for iOS", () => {
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel", 0)).toBe("other");
    expect(detectPlatform("Mozilla/5.0 (Linux; Android 14)", "Linux armv8l", 5)).toBe("other");
    expect(detectPlatform("Mozilla/5.0 (Windows NT 10.0)", "Win32", 0)).toBe("other");
  });
});

describe("install tracking", () => {
  beforeAll(() => {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
    startInstallTracking();
  });
  beforeEach(() => resetInstallStateForTests());

  function fireInstallPrompt(outcome: "accepted" | "dismissed") {
    const prompt = vi.fn(async () => undefined);
    const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
      prompt,
      userChoice: Promise.resolve({ outcome }),
    }) as BeforeInstallPromptEvent;
    window.dispatchEvent(event);
    return { event, prompt };
  }

  it("captures beforeinstallprompt (suppressing the mini-infobar) and uses it once", async () => {
    expect(installStore.get().promptAvailable).toBe(false);
    const { event, prompt } = fireInstallPrompt("accepted");
    expect(event.defaultPrevented).toBe(true);
    expect(installStore.get().promptAvailable).toBe(true);

    expect(await promptInstall()).toBe("accepted");
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(installStore.get().promptAvailable).toBe(false);
    expect(await promptInstall()).toBe("unavailable");
  });

  it("remembers a declined install prompt", async () => {
    fireInstallPrompt("dismissed");
    expect(await promptInstall()).toBe("dismissed");
    expect(installStore.get().dismissedAt).not.toBeNull();
    expect(window.localStorage.getItem(OFFLINE_KEYS.installDismissedAt)).not.toBeNull();
  });

  it("forgets the prompt once the app is installed", () => {
    fireInstallPrompt("accepted");
    window.dispatchEvent(new Event("appinstalled"));
    expect(installStore.get().promptAvailable).toBe(false);
  });

  it("persists the dismissal, and survives localStorage throwing", () => {
    dismissInstallCard(1234);
    expect(installStore.get().dismissedAt).toBe(1234);

    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => dismissInstallCard(5678)).not.toThrow();
    spy.mockRestore();
  });
});
