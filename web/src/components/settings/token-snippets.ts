/** Ready-to-paste connection snippets for an MCP client (conventions §13: Streamable HTTP + `Authorization: Bearer`). */

export function claudeCodeCommand(mcpUrl: string, token: string): string {
  return `claude mcp add --transport http hostidian ${mcpUrl} --header "Authorization: Bearer ${token}"`;
}

/** Cursor (`~/.cursor/mcp.json`) and most other clients that speak Streamable HTTP with static headers. */
export function genericJsonConfig(mcpUrl: string, token: string): string {
  return JSON.stringify(
    { mcpServers: { hostidian: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2,
  );
}

/**
 * Claude Desktop can't send a custom header to a remote server directly, so it goes through the `mcp-remote`
 * bridge (the header value lives in `env` so the argument has no space in it).
 */
export function claudeDesktopConfig(mcpUrl: string, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        hostidian: {
          command: "npx",
          args: ["-y", "mcp-remote", mcpUrl, "--header", "Authorization:${HOSTIDIAN_AUTH}"],
          env: { HOSTIDIAN_AUTH: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  );
}

export const EXPIRY_OPTIONS = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
  { value: "never", label: "Never expires" },
] as const;
