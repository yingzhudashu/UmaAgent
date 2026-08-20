import type { AgentTool } from "@earendil-works/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  instances: [] as Array<{
    connect: ReturnType<typeof vi.fn>;
    listTools: ReturnType<typeof vi.fn>;
    callTool: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = vi.fn(() => Promise.resolve());
    listTools = vi.fn(() =>
      Promise.resolve({
        tools: [
          { name: "echo.tool", description: "Echo", inputSchema: { type: "object" } },
          { name: "empty", inputSchema: { type: "object" } },
        ],
      }),
    );
    callTool = vi.fn(() => Promise.resolve({ content: [{ type: "text", text: "ok" }] }));
    close = vi.fn(() => Promise.resolve());
    constructor() {
      state.instances.push(this);
    }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    constructor(readonly options: unknown) {}
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(readonly url: URL) {}
  },
}));

import { McpManager } from "../src/mcp.js";

async function execute(tool: AgentTool, signal?: AbortSignal) {
  return (tool.execute as (...args: unknown[]) => Promise<unknown>)("call", { value: 1 }, signal);
}

describe("McpManager", () => {
  beforeEach(() => {
    state.instances.length = 0;
  });

  it("connects stdio and HTTP servers, namespaces tools, invokes them and closes clients", async () => {
    const manager = new McpManager();
    await manager.connect(
      [
        { name: "local server", transport: "stdio", command: "node", args: ["server.js"], env: { X: "1" } },
        { name: "remote", transport: "http", url: "https://mcp.example" },
      ],
      1_000,
    );
    expect(manager.status()).toEqual([
      { name: "local server", connected: true, toolCount: 2 },
      { name: "remote", connected: true, toolCount: 2 },
    ]);
    expect(manager.tools().map((tool) => tool.name)).toEqual([
      "mcp_local_server_echo_tool",
      "mcp_local_server_empty",
      "mcp_remote_echo_tool",
      "mcp_remote_empty",
    ]);
    const result = (await execute(manager.tools()[0] as AgentTool, new AbortController().signal)) as {
      content: Array<{ text: string }>;
      details: unknown;
    };
    expect(result.content[0]?.text).toBe("ok");
    expect(result.details).toEqual({ server: "local server", tool: "echo.tool" });

    state.instances[0]?.callTool.mockResolvedValueOnce({ content: [] });
    expect(
      ((await execute(manager.tools()[1] as AgentTool)) as { content: Array<{ text: string }> }).content[0]
        ?.text,
    ).toBe("MCP tool completed");
    state.instances[0]?.callTool.mockResolvedValueOnce({ content: { value: true } });
    expect(
      ((await execute(manager.tools()[0] as AgentTool)) as { content: Array<{ text: string }> }).content[0]
        ?.text,
    ).toContain("value");
    state.instances[0]?.callTool.mockResolvedValueOnce({
      isError: true,
      content: [{ type: "text", text: "remote failure" }, { type: "image" }],
    });
    await expect(execute(manager.tools()[0] as AgentTool)).rejects.toThrow("remote failure");
    await manager.close();
    expect(manager.tools()).toEqual([]);
    expect(state.instances.every((client) => client.close.mock.calls.length === 1)).toBe(true);
  });

  it("records connection errors and continues with later configurations", async () => {
    const manager = new McpManager();
    const originalPush = state.instances.push.bind(state.instances);
    let count = 0;
    vi.spyOn(state.instances, "push").mockImplementation((...items) => {
      count++;
      if (count === 1) items[0]?.connect.mockRejectedValueOnce("connection failed");
      return originalPush(...items);
    });
    await manager.connect(
      [
        { name: "broken", transport: "http", url: "https://broken.example" },
        { name: "working", transport: "stdio", command: "node" },
      ],
      100,
    );
    expect(manager.status()).toEqual([
      { name: "broken", connected: false, toolCount: 0, error: "connection failed" },
      { name: "working", connected: true, toolCount: 2 },
    ]);
  });
});
