import { readStorage, removeStorage, writeStorage } from "../storage";
import { OFFLINE_KEYS } from "./keys";
import { createStore, type ExternalStore } from "./store";

/**
 * "Install the app" state: the captured `beforeinstallprompt` event (Chromium, Android, desktop), the iOS
 * "Add to Home Screen" fallback (Safari never fires that event), whether the app already runs installed, and
 * whether the user waved the card away (remembered in localStorage; every access is try/catch-guarded in
 * lib/storage.ts, so private mode just means "ask again next time").
 */

/** The non-standard event Chromium fires when the app is installable. */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** How long a dismissed install card stays away. */
export const INSTALL_DISMISS_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

export type InstallPlatform = "ios" | "other";

export interface InstallEligibility {
  /** Already launched as an installed app (standalone window / iOS home-screen app). */
  standalone: boolean;
  /** A `beforeinstallprompt` event is waiting to be used. */
  promptAvailable: boolean;
  platform: InstallPlatform;
  /** When the card was last dismissed (ms since epoch), or null. */
  dismissedAt: number | null;
  now: number;
}

export type InstallCardKind = "prompt" | "ios" | null;

/** Which install card (if any) to show. Pure. */
export function installCardKind(input: InstallEligibility): InstallCardKind {
  if (input.standalone) return null;
  if (input.dismissedAt !== null && input.now - input.dismissedAt < INSTALL_DISMISS_COOLDOWN_MS) return null;
  if (input.promptAvailable) return "prompt";
  return input.platform === "ios" ? "ios" : null;
}

/** iPhone/iPad, including iPadOS 13+ which reports itself as a Mac with a touch screen. */
export function detectPlatform(ua: string, platform: string, maxTouchPoints: number): InstallPlatform {
  if (/iPhone|iPad|iPod/.test(ua)) return "ios";
  if (platform === "MacIntel" && maxTouchPoints > 1) return "ios";
  return "other";
}

export interface InstallSnapshot {
  standalone: boolean;
  promptAvailable: boolean;
  platform: InstallPlatform;
  dismissedAt: number | null;
}

const SERVER_SNAPSHOT: InstallSnapshot = { standalone: false, promptAvailable: false, platform: "other", dismissedAt: null };

let deferred: BeforeInstallPromptEvent | null = null;
let started = false;
const store: ExternalStore<InstallSnapshot> = createStore<InstallSnapshot>(SERVER_SNAPSHOT);

export const installStore: ExternalStore<InstallSnapshot> = store;
export const installServerSnapshot = (): InstallSnapshot => SERVER_SNAPSHOT;

function readDismissedAt(): number | null {
  const raw = readStorage(OFFLINE_KEYS.installDismissedAt);
  const value = raw === null ? NaN : Number(raw);
  return Number.isFinite(value) ? value : null;
}

function isStandalone(): boolean {
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia("(display-mode: standalone)").matches || window.matchMedia("(display-mode: window-controls-overlay)").matches;
}

function refresh() {
  store.set({
    standalone: isStandalone(),
    promptAvailable: deferred !== null,
    platform: detectPlatform(navigator.userAgent, navigator.platform, navigator.maxTouchPoints ?? 0),
    dismissedAt: readDismissedAt(),
  });
}

/** Attach the window listeners once (browser only). Safe to call repeatedly. */
export function startInstallTracking(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  window.addEventListener("beforeinstallprompt", (event) => {
    // Keep the native mini-infobar out of the way; the card offers the same thing in context.
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    refresh();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    refresh();
  });
  const display = window.matchMedia("(display-mode: standalone)");
  display.addEventListener?.("change", refresh);
  refresh();
}

/** Show the browser's install dialog. Resolves to what the user chose. */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const event = deferred;
  if (!event) return "unavailable";
  // The event can be used once, whatever the outcome.
  deferred = null;
  refresh();
  try {
    await event.prompt();
    const choice = await event.userChoice;
    if (choice.outcome === "dismissed") dismissInstallCard();
    return choice.outcome;
  } catch {
    return "dismissed";
  }
}

export function dismissInstallCard(now: number = Date.now()): void {
  writeStorage(OFFLINE_KEYS.installDismissedAt, String(now));
  refresh();
}

/** Test helper: forget the captured event and the dismissal (the window listeners stay attached). */
export function resetInstallStateForTests(): void {
  deferred = null;
  removeStorage(OFFLINE_KEYS.installDismissedAt);
  store.set(SERVER_SNAPSHOT);
}
