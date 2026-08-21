import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Type, { type TSchema } from "typebox";
import type { McpServerConfig } from "./types.js";

type Connected = { name: string; client: Client; tools: AgentTool[]; error?: string };

function textResult(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .flatMap((item) => {
      if (item && typeof item === "object" && "text" in item && typeof item.text === "string")
        return [item.text];
      return [];
    })
    .join("\n");
}

export class McpManager {
  private connections: Connected[] = [];

  async connect(configs: McpServerConfig[], toolTimeoutMs: number): Promise<void> {
    await this.close();
    for (const config of configs) {
      const client = new Client({ name: "uma-agent", version: "0.8.0" });
      try {
        const transport =
          config.transport === "stdio"
            ? new StdioClientTransport({
                command: config.command as string,
                args: config.args ?? [],
                ...(config.env ? { env: { ...process.env, ...config.env } as Record<string, string> } : {}),
              })
            : new StreamableHTTPClientTransport(new URL(config.url as string), {
                ...(config.authTokenEnv
                  ? {
                      requestInit: {
                        headers: {
                          authorization: `Bearer ${process.env[config.authTokenEnv] as string}`,
                        },
                      },
                    }
                  : {}),
              });
        await client.connect(transport as Parameters<Client["connect"]>[0]);
        const listed = await client.listTools();
        const tools = listed.tools.map((tool): AgentTool => {
          const name = `mcp_${config.name}_${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, "_");
          return {
            name,
            label: `${config.name}: ${tool.name}`,
            description: tool.description ?? `MCP tool ${tool.name}`,
            parameters: Type.Unsafe(tool.inputSchema as TSchema),
            executionMode: "sequential",
            async execute(_id, params, signal) {
              const response = await client.callTool(
                {
                  name: tool.name,
                  arguments: params as Record<string, unknown>,
                },
                undefined,
                {
                  ...(signal ? { signal } : {}),
                  timeout: toolTimeoutMs,
                  maxTotalTimeout: toolTimeoutMs,
                },
              );
              const output = textResult(response.content);
              if (response.isError) throw new Error(output || `MCP tool ${tool.name} failed`);
              return {
                content: [{ type: "text", text: output || "MCP tool completed" }],
                details: { server: config.name, tool: tool.name },
              };
            },
          };
        });
        this.connections.push({ name: config.name, client, tools });
      } catch (error) {
        this.connections.push({
          name: config.name,
          client,
          tools: [],
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  tools(): AgentTool[] {
    return this.connections.flatMap((connection) => connection.tools);
  }

  status(): Array<{ name: string; connected: boolean; toolCount: number; error?: string }> {
    return this.connections.map((connection) => ({
      name: connection.name,
      connected: !connection.error,
      toolCount: connection.tools.length,
      ...(connection.error ? { error: connection.error } : {}),
    }));
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.connections.map((connection) => connection.client.close()));
    this.connections = [];
  }
}
