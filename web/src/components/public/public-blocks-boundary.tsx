"use client";

import { Component, type ReactNode } from "react";

/**
 * A page whose stored blocks the renderer cannot build (an unknown block type from a newer version, corrupt JSON)
 * must not take the whole share page down with the generic error screen: the title and navigation stay usable.
 */
export class PublicBlocksBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("Couldn't render the shared page's content", error);
  }

  render() {
    if (this.state.failed) {
      return (
        <p role="status" className="mt-4 rounded-md border bg-muted px-3 py-3 text-sm text-muted-foreground">
          This page&apos;s content couldn&apos;t be displayed.
        </p>
      );
    }
    return this.props.children;
  }
}
