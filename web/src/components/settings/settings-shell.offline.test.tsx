import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AppUIProvider } from "@/components/layout/app-ui";
import { connectivityStore } from "@/lib/offline/connectivity-store";
import { renderWithApp } from "@/test/render";
import { SettingsShell } from "./settings-shell";

afterEach(() => act(() => connectivityStore.set({ online: true })));

describe("SettingsShell offline", () => {
  const form = (
    <form>
      <input aria-label="Name" />
      <button type="submit">Save</button>
    </form>
  );

  const renderShell = (area: "settings" | "admin", title: string) =>
    renderWithApp(
      <SettingsShell area={area} title={title}>
        {form}
      </SettingsShell>,
      { wrap: (children) => <AppUIProvider>{children}</AppUIProvider> },
    );

  it("is untouched online", () => {
    renderShell("settings", "Profile");
    expect(screen.getByLabelText("Name")).toBeEnabled();
    expect(screen.queryByTestId("settings-offline-note")).not.toBeInTheDocument();
  });

  it("makes every form control read-only and explains why when offline", () => {
    connectivityStore.set({ online: false });
    renderShell("settings", "Profile");
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByTestId("settings-offline-note")).toHaveTextContent(/offline/i);
  });

  it("says admin needs a connection", () => {
    connectivityStore.set({ online: false });
    renderShell("admin", "Users");
    expect(screen.getByTestId("settings-offline-note")).toHaveTextContent(/administration needs a connection/i);
  });
});
