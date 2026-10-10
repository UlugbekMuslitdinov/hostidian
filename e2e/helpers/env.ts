import path from "node:path";

/** Origin of the stack under test (Caddy). Must equal the stack's PUBLIC_URL: the API checks `Origin` on mutations. */
export const BASE_URL = (process.env.E2E_BASE_URL ?? "http://localhost:20080").replace(/\/+$/, "");

/**
 * The instance admin. On a fresh stack the onboarding spec creates it through the real setup form; on a stack
 * that was already set up with these credentials it just signs in, so the suite can be re-run without resetting.
 */
export const ADMIN = {
  name: "E2E Admin",
  email: process.env.E2E_ADMIN_EMAIL ?? "admin@e2e.test",
  password: process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin-password-1",
};

/** Password of every user the suite creates (they are throw-away accounts on a test stack). */
export const USER_PASSWORD = "e2e-user-password-1";

/** Session cookie of the admin, written by the onboarding spec and read by every other spec. */
export const ADMIN_STATE_FILE = path.join(__dirname, "..", ".auth", "admin.json");
