import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { errorResponse, fetchMock, jsonResponse, routeFetch } from "@/test/fetch-mock";
import { makeMe } from "@/test/factories";
import { navigation } from "@/test/navigation-mock";
import { renderWithApp } from "@/test/render";
import { RegisterForm } from "./register-form";

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("RegisterForm", () => {
  it("enforces the 10 character minimum and matching confirmation", async () => {
    renderWithApp(<RegisterForm inviteToken="tok" />, { workspace: null });
    type("Name", "Grace");
    type("Email", "grace@example.com");
    type("Password", "123456789");
    type("Confirm password", "123456789");
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("Use at least 10 characters.")).toBeInTheDocument();

    type("Password", "1234567890");
    type("Confirm password", "different-one");
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("The passwords don't match.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("registers with the invite token and enters the app", async () => {
    routeFetch({ "POST /auth/register": () => jsonResponse(makeMe(), 201) });
    renderWithApp(<RegisterForm inviteToken="invite-123" />, { workspace: null });
    type("Name", "Grace Hopper");
    type("Email", "grace@example.com");
    type("Password", "a-long-password");
    type("Confirm password", "a-long-password");
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/"));
    await expect(fetchMock.mock.calls[0]![0].clone().json()).resolves.toEqual({
      name: "Grace Hopper",
      email: "grace@example.com",
      password: "a-long-password",
      inviteToken: "invite-123",
    });
  });

  it("locks the email when the invite is restricted to one address", () => {
    renderWithApp(<RegisterForm inviteToken="t" lockedEmail="only@example.com" />, { workspace: null });
    const email = screen.getByLabelText("Email");
    expect(email).toHaveValue("only@example.com");
    expect(email).toHaveAttribute("readonly");
  });

  it("explains an already-registered email", async () => {
    routeFetch({ "POST /auth/register": () => errorResponse(409, "conflict", "exists") });
    renderWithApp(<RegisterForm />, { workspace: null });
    type("Name", "Grace");
    type("Email", "grace@example.com");
    type("Password", "a-long-password");
    type("Confirm password", "a-long-password");
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already exists/i);
  });
});
