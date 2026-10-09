import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PresenceProvider, PresenceStack, usePresence, usePublishPresence, type PresenceUser } from "./presence";

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
