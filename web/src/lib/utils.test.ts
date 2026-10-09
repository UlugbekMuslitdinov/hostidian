import { describe, expect, it } from "vitest";
import { filenameFromDisposition, sanitizeFilename } from "./download";
import { parseSnippet } from "./snippet";
import { slugify } from "./slug";
import { formatRelative } from "./time";
import { describeUserAgent } from "./user-agent";
import { initials, pageHref, safeNextPath } from "./utils";
import { coverBackground } from "./covers";

describe("safeNextPath", () => {
  it("keeps same-origin relative paths", () => {
    expect(safeNextPath("/w/acme/p/1?x=1")).toBe("/w/acme/p/1?x=1");
  });
  it.each(["//evil.com", "https://evil.com", "/\\evil.com", "javascript:alert(1)", "", null, undefined])(
    "rejects %s",
    (value) => {
      expect(safeNextPath(value as string | null | undefined)).toBe("/");
    },
  );
});

describe("misc helpers", () => {
  it("builds page links", () => {
    expect(pageHref("acme", "abc")).toBe("/w/acme/p/abc");
  });
  it("derives initials", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("  ada ")).toBe("A");
    expect(initials("")).toBe("?");
  });
  it("slugifies workspace names to the API pattern", () => {
    expect(slugify("Acme Inc.")).toBe("acme-inc");
    expect(slugify("  Crème  Brûlée!! ")).toBe("creme-brulee");
    expect(slugify("___")).toBe("");
  });
  it("resolves cover presets and ignores unknown ids", () => {
    expect(coverBackground("sunset")).toContain("linear-gradient");
    expect(coverBackground("future-kind")).toBeNull();
    expect(coverBackground(null)).toBeNull();
  });
  it("describes user agents", () => {
    expect(
      describeUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Chrome/120.0 Safari/537.36",
      ),
    ).toBe("Chrome on macOS");
    expect(
      describeUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Version/17.0 Safari/604.1"),
    ).toBe("Safari on iOS");
    expect(describeUserAgent("")).toBe("Unknown device");
  });
});

describe("formatRelative", () => {
  const now = Date.parse("2026-10-09T12:00:00Z");
  it("uses coarse relative units", () => {
    expect(formatRelative("2026-10-09T11:59:40Z", now)).toBe("just now");
    expect(formatRelative("2026-10-09T11:55:00Z", now)).toBe("5 min ago");
    expect(formatRelative("2026-10-09T09:00:00Z", now)).toBe("3 h ago");
    expect(formatRelative("2026-10-08T09:00:00Z", now)).toBe("yesterday");
    expect(formatRelative("garbage", now)).toBe("");
  });
});

describe("parseSnippet", () => {
  it("splits <mark> segments and decodes entities, never returning markup", () => {
    expect(parseSnippet("hello <mark>wor&amp;ld</mark> &lt;b&gt;x&lt;/b&gt;")).toEqual([
      { text: "hello ", mark: false },
      { text: "wor&ld", mark: true },
      { text: " <b>x</b>", mark: false },
    ]);
  });
  it("handles snippets without marks", () => {
    expect(parseSnippet("plain")).toEqual([{ text: "plain", mark: false }]);
    expect(parseSnippet("")).toEqual([]);
  });
});

describe("download helpers", () => {
  it("reads filenames from Content-Disposition", () => {
    expect(filenameFromDisposition('attachment; filename="export.zip"')).toBe("export.zip");
    expect(filenameFromDisposition("attachment; filename*=UTF-8''M%C3%A9mo.zip")).toBe("Mémo.zip");
    expect(filenameFromDisposition(null)).toBeNull();
  });
  it("sanitises unsafe characters", () => {
    expect(sanitizeFilename('a/b\\c:d*?"<>|')).toBe("a_b_c_d______");
    expect(sanitizeFilename("   ")).toBe("download");
  });
});
