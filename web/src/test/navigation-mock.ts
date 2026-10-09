import { vi } from "vitest";

/** Mutable router state behind the global `next/navigation` mock (see vitest.setup.ts). */
export const navigation = {
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  refresh: vi.fn(),
  prefetch: vi.fn(),
  pathname: "/",
  params: {} as Record<string, string>,
  search: new URLSearchParams(),
};

export function resetNavigation() {
  navigation.push.mockReset();
  navigation.replace.mockReset();
  navigation.pathname = "/";
  navigation.params = {};
  navigation.search = new URLSearchParams();
}
