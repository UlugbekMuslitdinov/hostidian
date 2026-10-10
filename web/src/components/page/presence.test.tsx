import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConnectionIndicator, connectionLabel } from "@/components/editor/connection-indicator";
import type { ConnectionState } from "@/lib/collab/connection";
import {
  PresenceProvider,
  PresenceStack,
  usePresence,
  usePublishConnection,
  usePublishPresence,
  type PresenceUser,
} from "./presence";

const ada: PresenceUser = { id: "u1", name: "Ada Lovelace", color: "#64b5f6" };
const grace: PresenceUser = { id: "u2", name: "Grace Hopper", color: "#81c784" };

function Editor({ users }: { users: PresenceUser[] }) {
  usePublishPresence(users);
  return null;
}

function Header() {
  return <PresenceStack users={usePresence()} max={2} />;
}

function Harness({ initial }: { initial: PresenceUser[] }) {
  const [users, setUsers] = useState(initial);
  return (
    <TooltipProvider>
      <PresenceProvider>
        <Header />
        <Editor users={users} />
        <button onClick={() => setUsers([ada, grace, { id: "u3", name: "Linus Torvalds", color: "#e57373" }])}>
          more
        </button>
        <button onClick={() => setUsers([])}>none</button>
      </PresenceProvider>
    </TooltipProvider>
  );
}

describe("presence slot", () => {
  it("renders whatever the editor publishes, without render loops", () => {
    render(<Harness initial={[ada]} />);
    expect(screen.getByRole("list", { name: "1 other person here" })).toBeInTheDocument();
    expect(screen.getByTitle("Ada Lovelace")).toBeInTheDocument();
  });

  it("collapses overflow into +N and clears when the editor publishes nobody", () => {
    render(<Harness initial={[ada]} />);
    fireEvent.click(screen.getByText("more"));
    expect(screen.getByText("+1")).toBeInTheDocument();
    fireEvent.click(screen.getByText("none"));
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("renders nothing outside a provider or without users", () => {
    const { container } = render(<PresenceStack users={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("connection pipe", () => {
  function Publisher({ state }: { state: ConnectionState }) {
    usePublishConnection(state);
    return null;
  }

  it("shows nothing until the editor publishes, then follows its state, then clears on unmount", () => {
    const { rerender } = render(
      <PresenceProvider>
        <ConnectionIndicator editable />
      </PresenceProvider>,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    const tree = (state: ConnectionState | null) => (
      <PresenceProvider>
        <ConnectionIndicator editable />
        {state ? <Publisher state={state} /> : null}
      </PresenceProvider>
    );
    rerender(tree("syncing"));
    expect(screen.getByRole("status")).toHaveAttribute("data-connection", "syncing");
    expect(screen.getByRole("status")).toHaveTextContent("Saving…");
    rerender(tree("offline"));
    expect(screen.getByRole("status")).toHaveAttribute("data-connection", "offline");
    rerender(tree(null));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("words a healthy connection as Live for people who cannot edit", () => {
    expect(connectionLabel("synced", true)).toBe("Saved");
    expect(connectionLabel("synced", false)).toBe("Live");
    expect(connectionLabel("offline", false)).toMatch(/Offline/);
  });
});
