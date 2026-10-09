import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import {
  AuthError,
  authenticate,
  createAuthExtension,
  documentNameFor,
  isOriginAllowed,
  pageIdFromDocumentName,
  type AuthOptions,
} from "./auth";
import {
  OTHER_PAGE_ID,
  PAGE_ID,
  PUBLIC_ORIGIN,
  SECRET,
  USER_ID,
  recordingLogger,
  signToken,
  silentLogger,
} from "./test-utils";

const options: AuthOptions = {
  secret: new TextEncoder().encode(SECRET),
  allowedOrigins: new Set([PUBLIC_ORIGIN, "http://localhost:3000"]),
};
const documentName = documentNameFor(PAGE_ID);

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AuthError) return error.reason;
    throw error;
  }
  throw new Error("expected authentication to fail");
}

const connect = (token: string, origin: string | null = PUBLIC_ORIGIN, name = documentName) =>
  authenticate(options, { token, documentName: name, origin });

describe("document names", () => {
  it("maps page ids to page:<uuid> and back", () => {
    expect(documentNameFor(PAGE_ID.toUpperCase())).toBe(`page:${PAGE_ID}`);
    expect(pageIdFromDocumentName(`page:${PAGE_ID}`)).toBe(PAGE_ID);
    expect(pageIdFromDocumentName(`page:${PAGE_ID.toUpperCase()}`)).toBe(PAGE_ID);
  });

  it.each(["", "page:", "page:not-a-uuid", `doc:${PAGE_ID}`, `page:${PAGE_ID}/extra`, PAGE_ID])("rejects %j", (name) => {
    expect(pageIdFromDocumentName(name)).toBeUndefined();
  });
});

describe("isOriginAllowed", () => {
  it("accepts configured origins exactly (normalised)", () => {
    expect(isOriginAllowed(PUBLIC_ORIGIN, options.allowedOrigins)).toBe(true);
    expect(isOriginAllowed("HTTPS://NOTES.EXAMPLE.COM", options.allowedOrigins)).toBe(true);
    expect(isOriginAllowed("http://localhost:3000", options.allowedOrigins)).toBe(true);
  });

  it.each([
    undefined,
    null,
    "",
    "null",
    "https://evil.example.com",
    "https://notes.example.com.evil.com",
    "http://notes.example.com",
    "https://notes.example.com:8443",
    "http://localhost:3001",
  ])("rejects %j", (origin) => {
    expect(isOriginAllowed(origin, options.allowedOrigins)).toBe(false);
  });
});

describe("authenticate", () => {
  it("accepts a valid token and returns the user", async () => {
    const result = await connect(await signToken({ name: "Grace Hopper", color: "#ff8800", role: "full" }));
    expect(result).toEqual({
      user: { id: USER_ID, name: "Grace Hopper", color: "#ff8800", role: "full" },
      readOnly: false,
    });
  });

  it.each([
    ["view", true],
    ["comment", true],
    ["edit", false],
    ["full", false],
  ])("role %s => readOnly %s", async (role, readOnly) => {
    expect((await connect(await signToken({ role }))).readOnly).toBe(readOnly);
  });

  it("accepts the page id in any letter case", async () => {
    await expect(connect(await signToken({ pageId: PAGE_ID.toUpperCase(), sub: USER_ID.toUpperCase() }))).resolves.toMatchObject({
      user: { id: USER_ID },
    });
  });

  it("rejects an expired token", async () => {
    expect(await reason(connect(await signToken({ expiresIn: -60 })))).toBe("token-expired");
  });

  it("tolerates a few seconds of clock skew only", async () => {
    await expect(connect(await signToken({ expiresIn: -2 }))).resolves.toBeDefined();
    expect(await reason(connect(await signToken({ expiresIn: -30 })))).toBe("token-expired");
  });

  it("rejects a wrong audience, issuer or signing secret", async () => {
    expect(await reason(connect(await signToken({ audience: "someone-else" })))).toBe("unauthorized");
    expect(await reason(connect(await signToken({ issuer: "evil" })))).toBe("unauthorized");
    expect(await reason(connect(await signToken({ secret: "a-completely-different-secret-value!!" })))).toBe("unauthorized");
  });

  it("rejects other HMAC algorithms (HS256 only)", async () => {
    expect(await reason(connect(await signToken({ alg: "HS512" })))).toBe("unauthorized");
    expect(await reason(connect(await signToken({ alg: "HS384" })))).toBe("unauthorized");
  });

  it("rejects an unsigned (alg none) token", async () => {
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const token = `${b64({ alg: "none", typ: "JWT" })}.${b64({
      iss: "hostidian-api",
      aud: "hostidian-collab",
      sub: USER_ID,
      pageId: PAGE_ID,
      role: "full",
      name: "x",
      color: "#fff",
      exp: Math.floor(Date.now() / 1000) + 100,
    })}.`;
    expect(await reason(connect(token))).toBe("unauthorized");
  });

  it.each(["sub", "pageId", "role", "name", "color", "expiresIn"] as const)("rejects a token without the %s claim", async (claim) => {
    const token = await signToken({ [claim === "expiresIn" ? "expiresIn" : claim]: null });
    expect(await reason(connect(token))).toBe("unauthorized");
  });

  it("rejects a token issued for another page", async () => {
    expect(await reason(connect(await signToken({ pageId: OTHER_PAGE_ID })))).toBe("forbidden-page");
  });

  it("rejects document names that are not page:<uuid>", async () => {
    const token = await signToken();
    expect(await reason(connect(token, PUBLIC_ORIGIN, "page:../../etc"))).toBe("invalid-document");
    expect(await reason(connect(token, PUBLIC_ORIGIN, PAGE_ID))).toBe("invalid-document");
  });

  it("rejects origins that are missing or not allowed, before looking at the token", async () => {
    const token = await signToken();
    expect(await reason(connect(token, "https://evil.example.com"))).toBe("forbidden-origin");
    expect(await reason(connect(token, null))).toBe("forbidden-origin");
    expect(await reason(connect("garbage", null))).toBe("forbidden-origin");
  });

  it("accepts the extra allowed origins", async () => {
    await expect(connect(await signToken(), "http://localhost:3000")).resolves.toBeDefined();
  });

  it("rejects garbage and empty tokens", async () => {
    expect(await reason(connect("not-a-jwt"))).toBe("unauthorized");
    expect(await reason(connect(""))).toBe("unauthorized");
  });

  it.each([
    ["role", { role: "owner" }],
    ["role", { role: "none" }],
    ["sub", { sub: "not-a-uuid" }],
    ["pageId", { pageId: "not-a-uuid" }],
    ["name", { name: "" }],
    ["name", { name: "x".repeat(201) }],
    ["color", { color: "red" }],
    ["color", { color: "#12" }],
    ["color", { color: "#1234567" }],
    ["color", { color: "#fff;background:url(x)" }],
  ])("rejects an invalid %s claim: %j", async (_claim, override) => {
    expect(await reason(connect(await signToken(override)))).toBe("unauthorized");
  });

  it("accepts 3, 4, 6 and 8 digit hex colours", async () => {
    for (const color of ["#fff", "#ffff", "#6366f1", "#6366f1aa"]) {
      await expect(connect(await signToken({ color }))).resolves.toBeDefined();
    }
  });
});

describe("auth extension", () => {
  const extension = createAuthExtension(options, silentLogger);

  const authPayload = (token: string, origin: string | null) => {
    const headers = new Headers();
    if (origin !== null) headers.set("origin", origin);
    const connectionConfig = { readOnly: false, isAuthenticated: false };
    return {
      payload: { token, documentName, request: new Request("http://collab.test/", { headers }), connectionConfig },
      connectionConfig,
    };
  };

  it("sets read-only mode from the role and returns the user as context", async () => {
    for (const [role, readOnly] of [["view", true], ["comment", true], ["edit", false], ["full", false]] as const) {
      const { payload, connectionConfig } = authPayload(await signToken({ role }), PUBLIC_ORIGIN);
      const context = await extension.onAuthenticate?.(payload as never);
      expect(connectionConfig.readOnly).toBe(readOnly);
      expect(context).toEqual({ user: { id: USER_ID, name: "Ada Lovelace", color: "#6366f1", role } });
    }
  });

  it("refuses with a reason the provider can show, and never logs the token", async () => {
    const { logger, lines } = recordingLogger();
    const guarded = createAuthExtension(options, logger);
    const token = await signToken({ pageId: OTHER_PAGE_ID });
    const { payload, connectionConfig } = authPayload(token, PUBLIC_ORIGIN);
    await expect(guarded.onAuthenticate?.(payload as never)).rejects.toEqual({ reason: "forbidden-page" });
    expect(connectionConfig.readOnly).toBe(false);
    expect(JSON.stringify(lines)).not.toContain(token);

    const bad = authPayload(await signToken(), "https://evil.example.com");
    await expect(guarded.onAuthenticate?.(bad.payload as never)).rejects.toEqual({ reason: "forbidden-origin" });
    const missing = authPayload(await signToken(), null);
    await expect(guarded.onAuthenticate?.(missing.payload as never)).rejects.toEqual({ reason: "forbidden-origin" });
  });

  it("overwrites the presence identity with the verified one", async () => {
    const states = new Map<number, Record<string, unknown>>([
      [1, { user: { name: "Mallory", color: "#000000" }, cursor: { anchor: 1 } }],
      [2, {}],
    ]);
    const user = { id: USER_ID, name: "Ada", color: "#6366f1", role: "edit" as const };
    await extension.beforeHandleAwareness?.({ context: { user }, states } as never);
    expect(states.get(1)).toEqual({ user: { id: USER_ID, name: "Ada", color: "#6366f1" }, cursor: { anchor: 1 } });
    expect(states.get(2)).toEqual({ user: { id: USER_ID, name: "Ada", color: "#6366f1" } });
    // Server-originated awareness (no connection context) is left alone.
    const untouched = new Map<number, Record<string, unknown>>([[3, { user: { name: "Server" } }]]);
    await extension.beforeHandleAwareness?.({ context: undefined, states: untouched } as never);
    expect(untouched.get(3)).toEqual({ user: { name: "Server" } });
  });

  function upgrade(url: string, origin?: string) {
    const socket = new PassThrough();
    const written: string[] = [];
    socket.on("data", (chunk: Buffer) => written.push(chunk.toString()));
    const request = { url, headers: origin ? { origin } : {} } as unknown as IncomingMessage;
    return { socket, request, written };
  }

  it("lets WebSocket upgrades through on / and /collab for allowed origins", async () => {
    for (const url of ["/", "/collab", "/collab/", "/?x=1", "/collab?x=1"]) {
      const { socket, request, written } = upgrade(url, PUBLIC_ORIGIN);
      await expect(extension.onUpgrade?.({ request, socket, head: Buffer.alloc(0) } as never)).resolves.toBeUndefined();
      expect(written).toEqual([]);
      expect(socket.destroyed).toBe(false);
    }
  });

  it("rejects upgrades on other paths (404) and from foreign or missing origins (403)", async () => {
    const wrongPath = upgrade("/admin", PUBLIC_ORIGIN);
    await expect(extension.onUpgrade?.({ ...wrongPath, head: Buffer.alloc(0) } as never)).rejects.toBeUndefined();
    expect(wrongPath.written.join("")).toContain("404");
    expect(wrongPath.socket.destroyed).toBe(true);

    for (const origin of ["https://evil.example.com", undefined]) {
      const foreign = upgrade("/collab", origin);
      await expect(extension.onUpgrade?.({ ...foreign, head: Buffer.alloc(0) } as never)).rejects.toBeUndefined();
      expect(foreign.written.join("")).toContain("403");
      expect(foreign.socket.destroyed).toBe(true);
    }
  });
});
