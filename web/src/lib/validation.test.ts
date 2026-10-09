import { describe, expect, it } from "vitest";
import { validateEmail, validateName, validatePassword, validatePasswordConfirmation } from "./validation";

describe("validation", () => {
  it("requires passwords of at least 10 characters (conventions §2)", () => {
    expect(validatePassword("123456789")).toMatch(/at least 10/i);
    expect(validatePassword("1234567890")).toBeNull();
    expect(validatePassword("")).not.toBeNull();
    expect(validatePassword("x".repeat(201))).toMatch(/at most 200/i);
  });

  it("checks email shape", () => {
    expect(validateEmail("")).not.toBeNull();
    expect(validateEmail("nope")).not.toBeNull();
    expect(validateEmail("a@b")).not.toBeNull();
    expect(validateEmail(" ada@example.com ")).toBeNull();
  });

  it("checks names and confirmations", () => {
    expect(validateName("   ")).not.toBeNull();
    expect(validateName("Ada")).toBeNull();
    expect(validatePasswordConfirmation("a", "b")).not.toBeNull();
    expect(validatePasswordConfirmation("a", "a")).toBeNull();
  });
});
