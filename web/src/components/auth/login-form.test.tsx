import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { qk } from "@/lib/api/keys";
import { errorResponse, fetchMock, jsonResponse, routeFetch } from "@/test/fetch-mock";
import { makeMe } from "@/test/factories";
import { navigation } from "@/test/navigation-mock";
import { renderWithApp } from "@/test/render";
import { LoginForm } from "./login-form";

const info = (overrides: Record<string, unknown> = {}) => ({
  needsSetup: false,
  instanceName: "Acme Notes",
  allowOpenSignup: false,
  oidc: { enabled: false },
  version: "0.1.0",
  ...overrides,
});

function mockServer(options: { info?: Record<string, unknown>; login?: () => Response } = {}) {
  routeFetch({
    "GET /instance/info": () => jsonResponse(info(options.info)),
    "GET /auth/me": () => errorResponse(401, "unauthorized", "Not signed in"),
    "POST /auth/login": options.login ?? (() => jsonResponse(makeMe())),
  });
}

const fill = (email: string, password: string) => {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
};
const submit = () => fireEvent.click(screen.getByRole("button", { name: "Log in" }));
const loginCalls = () => fetchMock.mock.calls.filter(([r]) => r.method === "POST" && r.url.endsWith("/auth/login"));

beforeEach(() => {
  navigation.search = new URLSearchParams();
});

describe("LoginForm", () => {
  it("validates before calling the API", async () => {
    mockServer();
    renderWithApp(<LoginForm />, { workspace: null });
    submit();
    expect(await screen.findByText("Enter your email address.")).toBeInTheDocument();
    expect(screen.getByText("Enter your password.")).toBeInTheDocument();

    fill("not-an-email", "x");
    submit();
    expect(await screen.findByText("Enter a valid email address.")).toBeInTheDocument();
    expect(loginCalls()).toHaveLength(0);
  });

  it("shows a friendly error for wrong credentials and keeps the form usable", async () => {
    mockServer({ login: () => errorResponse(401, "unauthorized", "invalid credentials") });
    renderWithApp(<LoginForm />, { workspace: null });
    fill("ada@example.com", "wrong-password");
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect email or password.");
    expect(screen.getByRole("button", { name: "Log in" })).toBeEnabled();
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("explains rate limiting", async () => {
    mockServer({ login: () => errorResponse(429, "rate_limited", "slow down") });
    renderWithApp(<LoginForm />, { workspace: null });
    fill("ada@example.com", "whatever-long");
    submit();
    expect(await screen.findByText(/too many attempts/i)).toBeInTheDocument();
  });

  it("stores the session and continues to the requested page on success", async () => {
    navigation.search = new URLSearchParams("next=/w/acme/p/123");
    mockServer();
    const { qc } = renderWithApp(<LoginForm />, { workspace: null });
    fill(" ada@example.com ", "correct-horse");
    submit();
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/w/acme/p/123"));
    expect(qc.getQueryData(qk.me())).toMatchObject({ user: { email: "ada@example.com" } });
    const body = await loginCalls()[0]![0].clone().json();
    expect(body).toEqual({ email: "ada@example.com", password: "correct-horse" });
  });

  it("never redirects to an off-site `next` target", async () => {
    navigation.search = new URLSearchParams("next=//evil.example");
    mockServer();
    renderWithApp(<LoginForm />, { workspace: null });
    fill("ada@example.com", "correct-horse");
    submit();
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/"));
  });

  it("offers single sign-on only when the instance has OIDC enabled", async () => {
    mockServer({ info: { oidc: { enabled: true, name: "Acme SSO" } } });
    renderWithApp(<LoginForm />, { workspace: null });
    const link = await screen.findByRole("link", { name: /acme sso/i });
    expect(link).toHaveAttribute("href", "/api/auth/oidc/login?next=%2F");
  });

  it("hides single sign-on when disabled", async () => {
    mockServer();
    renderWithApp(<LoginForm />, { workspace: null });
    await screen.findByText(/Acme Notes/);
    expect(screen.queryByRole("link", { name: /single sign-on/i })).not.toBeInTheDocument();
  });

  it("sends first-run installs to /setup", async () => {
    mockServer({ info: { needsSetup: true } });
    renderWithApp(<LoginForm />, { workspace: null });
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/setup"));
  });

  it("offers account creation only with open sign-up", async () => {
    mockServer({ info: { allowOpenSignup: true } });
    renderWithApp(<LoginForm />, { workspace: null });
    expect(await screen.findByRole("link", { name: "Create an account" })).toHaveAttribute("href", "/register");
  });
});
