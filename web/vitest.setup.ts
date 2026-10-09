import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { fetchMock } from "@/test/fetch-mock";
import { navigation, resetNavigation } from "@/test/navigation-mock";

// All API traffic goes through the fetch mock; relative "/api" URLs can't be parsed by Node's Request.
vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  const { fetchMock: mock } = await import("@/test/fetch-mock");
  return {
    ...actual,
    api: actual.createApiClient({ baseUrl: "http://localhost/api", fetch: (request) => mock(request) }),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: navigation.push,
    replace: navigation.replace,
    back: navigation.back,
    refresh: navigation.refresh,
    prefetch: navigation.prefetch,
  }),
  usePathname: () => navigation.pathname,
  useParams: () => navigation.params,
  useSearchParams: () => navigation.search,
  redirect: vi.fn(),
}));

beforeEach(() => {
  fetchMock.mockReset();
  resetNavigation();
});

afterEach(() => {
  cleanup();
});

// jsdom lacks several browser APIs that Radix UI / cmdk rely on.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}
if (typeof window !== "undefined") {
  window.HTMLElement.prototype.scrollIntoView ??= function scrollIntoView() {};
  window.HTMLElement.prototype.hasPointerCapture ??= () => false;
  window.HTMLElement.prototype.releasePointerCapture ??= () => {};
  window.HTMLElement.prototype.setPointerCapture ??= () => {};
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}
