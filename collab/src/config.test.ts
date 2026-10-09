import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config";

const valid = {
  DATABASE_URL: "postgres://hostidian:pw@postgres:5432/hostidian?sslmode=disable",
  COLLAB_JWT_SECRET: "a-long-enough-secret-value",
  INTERNAL_TOKEN: "another-long-enough-secret",
  PUBLIC_URL: "https://notes.example.com",
};

function problemsFor(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
}

describe("loadConfig", () => {
  it("applies the documented defaults", () => {
    const config = loadConfig(valid);
    expect(config).toMatchObject({
      port: 1234,
      internalPort: 1235,
      apiInternalUrl: "http://api:8081",
      logLevel: "info",
      databaseUrl: valid.DATABASE_URL,
      jwtSecret: valid.COLLAB_JWT_SECRET,
      internalToken: valid.INTERNAL_TOKEN,
    });
    expect([...config.allowedOrigins]).toEqual(["https://notes.example.com"]);
  });

  it("reads every setting from the environment", () => {
    const config = loadConfig({
      ...valid,
      COLLAB_PORT: "4000",
      COLLAB_INTERNAL_PORT: "4001",
      API_INTERNAL_URL: "http://localhost:9000/",
      LOG_LEVEL: "DEBUG",
    });
    expect(config).toMatchObject({ port: 4000, internalPort: 4001, apiInternalUrl: "http://localhost:9000", logLevel: "debug" });
  });

  it("builds the allowed-origin set from PUBLIC_URL and ALLOWED_ORIGINS, normalised to origins", () => {
    const config = loadConfig({
      ...valid,
      PUBLIC_URL: "https://Notes.Example.com/some/path",
      ALLOWED_ORIGINS: " http://localhost:3000 , http://localhost:3000/ ,, https://other.example.com:8443/x ",
    });
    expect([...config.allowedOrigins].sort()).toEqual(
      ["http://localhost:3000", "https://notes.example.com", "https://other.example.com:8443"].sort(),
    );
  });

  it.each(["DATABASE_URL", "COLLAB_JWT_SECRET", "INTERNAL_TOKEN", "PUBLIC_URL"])("fails fast when %s is missing", (name) => {
    expect(problemsFor({ ...valid, [name]: undefined })).toContain(`${name} is required`);
    expect(problemsFor({ ...valid, [name]: "   " })).toContain(`${name} is required`);
  });

  it("reports all problems at once", () => {
    const env = { COLLAB_PORT: "nope", LOG_LEVEL: "loud" };
    const problems = problemsFor(env);
    expect(problems).toEqual(
      expect.arrayContaining([
        "DATABASE_URL is required",
        "COLLAB_JWT_SECRET is required",
        "INTERNAL_TOKEN is required",
        "PUBLIC_URL is required",
        expect.stringContaining("COLLAB_PORT"),
        expect.stringContaining("LOG_LEVEL"),
      ]),
    );
    expect(() => loadConfig(env)).toThrow(/DATABASE_URL is required/);
  });

  it.each([
    [{ COLLAB_PORT: "70000" }, "COLLAB_PORT"],
    [{ COLLAB_INTERNAL_PORT: "-1" }, "COLLAB_INTERNAL_PORT"],
    [{ COLLAB_PORT: "12.5" }, "COLLAB_PORT"],
    [{ API_INTERNAL_URL: "not a url" }, "API_INTERNAL_URL"],
    [{ API_INTERNAL_URL: "ftp://api:8081" }, "API_INTERNAL_URL"],
    [{ PUBLIC_URL: "notes.example.com" }, "PUBLIC_URL"],
    [{ ALLOWED_ORIGINS: "http://ok.example.com,nope" }, "ALLOWED_ORIGINS"],
    [{ DATABASE_URL: "mysql://x" }, "DATABASE_URL"],
  ])("rejects invalid values: %j", (override, mention) => {
    const problems = problemsFor({ ...valid, ...override });
    expect(problems.some((p) => p.includes(mention))).toBe(true);
  });

  it("rejects identical public and internal ports", () => {
    expect(problemsFor({ ...valid, COLLAB_PORT: "5000", COLLAB_INTERNAL_PORT: "5000" })).toContain(
      "COLLAB_PORT and COLLAB_INTERNAL_PORT must differ",
    );
  });
});
