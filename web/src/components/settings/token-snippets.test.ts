import { describe, expect, it } from "vitest";
import { claudeCodeCommand, claudeDesktopConfig, genericJsonConfig } from "./token-snippets";

const url = "https://notes.example.com/api/mcp";
const token = "hst_secret";

describe("token snippets", () => {
  it("builds the Claude Code command from the response's mcpUrl", () => {
    expect(claudeCodeCommand(url, token)).toBe(
      'claude mcp add --transport http hostidian https://notes.example.com/api/mcp --header "Authorization: Bearer hst_secret"',
    );
  });

  it("builds valid JSON configs carrying the url and bearer header", () => {
    expect(JSON.parse(genericJsonConfig(url, token))).toEqual({
      mcpServers: { hostidian: { type: "http", url, headers: { Authorization: "Bearer hst_secret" } } },
    });
    const desktop = JSON.parse(claudeDesktopConfig(url, token));
    expect(desktop.mcpServers.hostidian.args).toContain(url);
    expect(desktop.mcpServers.hostidian.env.HOSTIDIAN_AUTH).toBe("Bearer hst_secret");
  });
});
