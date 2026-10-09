import { describe, expect, it } from "vitest";
import { classifyAuthFailure, deriveConnection, reconnectDelay, type ConnectionInputs } from "./connection";

const base: ConnectionInputs = {
  failure: null,
  online: true,
  wsConnected: true,
  authenticated: true,
  synced: true,
  hasUnsynced: false,
  settled: false,
};

describe("deriveConnection", () => {
  it("is synced when connected, authenticated and caught up", () => {
    expect(deriveConnection(base)).toBe("synced");
    expect(deriveConnection({ ...base, hasUnsynced: true })).toBe("syncing");
  });

  it("failures win over everything", () => {
    expect(deriveConnection({ ...base, failure: "no-access" })).toBe("no-access");
    expect(deriveConnection({ ...base, failure: "error", online: false })).toBe("error");
  });

  it("shows connecting during the grace period, then offline", () => {
    const down = { ...base, wsConnected: false, authenticated: false, synced: false };
    expect(deriveConnection({ ...down, settled: false })).toBe("connecting");
    expect(deriveConnection({ ...down, settled: true })).toBe("offline");
  });

  it("is offline immediately when the browser is offline", () => {
    expect(deriveConnection({ ...base, wsConnected: false, synced: false, online: false, settled: false })).toBe("offline");
  });

  it("stays connecting while the socket is open but not yet authenticated or synced", () => {
    expect(deriveConnection({ ...base, authenticated: false, synced: false, settled: true })).toBe("connecting");
  });
});

describe("classifyAuthFailure", () => {
  it("retries token problems and gives up on configuration errors", () => {
    expect(classifyAuthFailure("token-expired")).toBe("retry");
    expect(classifyAuthFailure("unauthorized")).toBe("retry");
    expect(classifyAuthFailure("internal")).toBe("retry");
    expect(classifyAuthFailure("forbidden-origin")).toBe("error");
    expect(classifyAuthFailure("forbidden-page")).toBe("error");
    expect(classifyAuthFailure("invalid-document")).toBe("error");
    expect(classifyAuthFailure("Failed to get token during sendToken(): ApiError")).toBe("retry");
  });
});

describe("reconnectDelay", () => {
  it("grows exponentially with jitter and caps at 30s", () => {
    expect(reconnectDelay(0, () => 0)).toBe(500);
    expect(reconnectDelay(0, () => 1)).toBe(1000);
    expect(reconnectDelay(3, () => 1)).toBe(8000);
    expect(reconnectDelay(20, () => 1)).toBe(30_000);
    expect(reconnectDelay(-5, () => 1)).toBe(1000);
  });
});
