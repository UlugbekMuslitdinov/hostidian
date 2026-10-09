import { describe, expect, it } from "vitest";
import { createLogger, errorFields } from "./logger";

describe("logger", () => {
  it("writes one JSON object per line with time, level, msg and bound fields", () => {
    const lines: string[] = [];
    const log = createLogger("info", { service: "collab" }, (line) => lines.push(line));
    log.child({ component: "x" }).info("hello", { pageId: "p1" });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ level: "info", msg: "hello", service: "collab", component: "x", pageId: "p1" });
    expect(new Date(JSON.parse(lines[0] ?? "").time).getTime()).not.toBeNaN();
  });

  it("filters by level", () => {
    const lines: string[] = [];
    const log = createLogger("warn", {}, (line) => lines.push(line));
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(lines.map((l) => JSON.parse(l).msg)).toEqual(["w", "e"]);
  });

  it("survives unserialisable fields", () => {
    const lines: string[] = [];
    const log = createLogger("info", {}, (line) => lines.push(line));
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    log.info("odd", { circular });
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ msg: "odd", logError: "unserialisable fields" });
  });

  it("flattens errors", () => {
    const error = Object.assign(new Error("boom"), { code: "ECONNRESET" });
    expect(errorFields(error)).toMatchObject({ err: "boom", errName: "Error", errCode: "ECONNRESET" });
    expect(errorFields("text")).toEqual({ err: "text" });
  });
});
