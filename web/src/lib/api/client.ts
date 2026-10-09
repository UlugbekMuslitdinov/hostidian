import createClient from "openapi-fetch";
import type { paths } from "@hostidian/api-types";

export interface ApiClientOptions {
  baseUrl?: string;
  fetch?: (input: Request) => Promise<Response>;
}

/** Typed client for api/openapi.yaml. Same-origin, cookie session (`hostidian_session`). */
export function createApiClient(options: ApiClientOptions = {}) {
  return createClient<paths>({
    baseUrl: options.baseUrl ?? "/api",
    credentials: "include",
    // Resolve fetch lazily so tests (and polyfills) can swap globalThis.fetch.
    fetch: options.fetch ?? ((request) => globalThis.fetch(request)),
  });
}

export type ApiClient = ReturnType<typeof createApiClient>;

export const api: ApiClient = createApiClient();
