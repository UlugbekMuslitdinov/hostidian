import { vi } from "vitest";

/** Every API call made through `@/lib/api/client` lands here in tests (see vitest.setup.ts). */
export const fetchMock = vi.fn<(request: Request) => Promise<Response>>();

export function jsonResponse(body: unknown, status = 200): Response {
  if (status === 204) return new Response(null, { status });
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: Record<string, string>,
): Response {
  return jsonResponse({ error: { code, message, ...(details ? { details } : {}) } }, status);
}

/** Route-by-"METHOD /path" handler table; unknown routes fail the test loudly. */
export function routeFetch(routes: Record<string, (request: Request) => Response | Promise<Response>>) {
  fetchMock.mockImplementation(async (request) => {
    const url = new URL(request.url);
    const key = `${request.method} ${url.pathname.replace(/^\/api/, "")}`;
    const handler = routes[key];
    if (!handler) throw new Error(`Unexpected request: ${key}`);
    return handler(request);
  });
}
