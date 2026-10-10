import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "./manifest";

const publicDir = join(process.cwd(), "public");
const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("web app manifest", () => {
  const m = manifest();

  it("meets the installability criteria", () => {
    expect(m.name).toBeTruthy();
    expect(m.short_name).toBeTruthy();
    expect(m.start_url).toBe("/");
    expect(m.scope).toBe("/");
    expect(m.display).toBe("standalone");
    const sizes = (m.icons ?? []).map((i) => `${i.sizes}:${i.purpose}`);
    expect(sizes).toContain("192x192:any");
    expect(sizes).toContain("512x512:any");
    expect(sizes).toContain("512x512:maskable");
  });

  it("only references icons that exist", () => {
    for (const icon of [...(m.icons ?? []), ...(m.shortcuts ?? []).flatMap((s) => s.icons ?? [])]) {
      expect(existsSync(join(publicDir, icon.src)), icon.src).toBe(true);
    }
  });

  it("has a New page shortcut that the app handles", () => {
    const shortcut = m.shortcuts?.find((s) => s.url.includes("action=new-page"));
    expect(shortcut).toBeDefined();
  });
});

describe("static assets served by the app itself (no third-party requests)", () => {
  it("ships the emoji data the picker loads, and the picker points at it", () => {
    for (const file of ["en/data.json", "en/messages.json"]) {
      const path = join(publicDir, "emoji", file);
      expect(statSync(path).size, file).toBeGreaterThan(1000);
      expect(() => JSON.parse(readFileSync(path, "utf8")), file).not.toThrow();
    }
    expect(existsSync(join(publicDir, "emoji", "LICENSE.txt"))).toBe(true);
    const picker = read("src/components/page/emoji-picker.tsx");
    expect(picker).toMatch(/const EMOJIBASE_URL = "\/emoji"/);
    expect(picker).not.toMatch(/jsdelivr|unpkg|cdn\./i);
  });

  it("has the offline fallback page and the service-worker source", () => {
    expect(existsSync(join(publicDir, "offline.html"))).toBe(true);
    expect(existsSync(join(process.cwd(), "src/app/sw.ts"))).toBe(true);
  });

  it("precaches public/ (icons, emoji data, offline page) in the service worker build", () => {
    const route = read("src/app/serwist/[path]/route.ts");
    expect(route).toContain('"public/**/*"');
    expect(route).toContain("PRECACHED_DOCUMENTS");
  });
});

describe("document head", () => {
  it("declares both color schemes' theme-color, safe-area cover and the iOS web-app meta", () => {
    const layout = read("src/app/layout.tsx");
    expect(layout).toContain('viewportFit: "cover"');
    expect(layout).toContain("(prefers-color-scheme: light)");
    expect(layout).toContain("(prefers-color-scheme: dark)");
    expect(layout).toContain("appleWebApp");
    expect(layout).toContain('manifest: "/manifest.webmanifest"');
  });

  it("the standalone app does not rubber-band or pull to refresh, and uses dynamic viewport units", () => {
    const css = read("src/app/globals.css");
    expect(css).toMatch(/overscroll-behavior:\s*none/);
    expect(css).toMatch(/100dvh/);
    expect(css).toContain("env(safe-area-inset-top");
  });
});
