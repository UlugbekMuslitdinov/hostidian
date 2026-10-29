import { describe, expect, it } from "vitest";
import { connectionStatus } from "./github-status";

const base = { enabled: true, lastError: null, backfilled: true, lastSyncedAt: "2026-10-01T10:00:00Z" };

describe("connectionStatus", () => {
  it("is active once imported and error-free", () => {
    expect(connectionStatus(base)).toEqual({ label: "Active", variant: "success" });
  });

  it("puts a pause above everything, then errors, then the import", () => {
    expect(connectionStatus({ ...base, enabled: false, lastError: "boom" }).label).toBe("Paused");
    expect(connectionStatus({ ...base, lastError: "boom", backfilled: false }).label).toBe("Needs attention");
    expect(connectionStatus({ ...base, backfilled: false }).label).toBe("Importing issues…");
    expect(connectionStatus({ ...base, backfilled: false, lastSyncedAt: null }).label).toBe("Starting…");
  });
});
