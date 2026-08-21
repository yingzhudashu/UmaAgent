import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createFeishuMcp, type FeishuBusinessGateway } from "../src/service.js";

describe("Feishu MCP", () => {
  it("maps document, Bitable, Drive and attachment operations through injected gateways", async () => {
    const gateway: FeishuBusinessGateway = {
      request: vi.fn(async (method, path) => ({ method, path })),
      upload: vi.fn(async (_path, file) => ({ uploaded: file.name })),
      download: vi.fn(async () => ({
        name: "download.txt",
        type: "text/plain",
        bytes: new TextEncoder().encode("download"),
      })),
    };
    const core = {
      attachmentContent: vi.fn(async () => new Blob(["upload"])),
      upload: vi.fn(async () => ({ id: "attachment", name: "download.txt" })),
    };
    const server = createFeishuMcp({ gateway, core: core as never });
    const client = new Client({ name: "test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    expect(listed.tools.length).toBeGreaterThanOrEqual(30);
    const generic = {
      input: {
        documentId: "doc",
        blockId: "block",
        appToken: "app",
        tableId: "table",
        recordId: "record",
        fieldId: "field",
        fileToken: "file",
        memberId: "member",
      },
    };
    for (const tool of listed.tools.filter((item) => !item.name.includes("attachment")))
      await client.callTool({ name: tool.name, arguments: generic });
    await client.callTool({ name: "doc_create", arguments: {} });
    const missing = await client.callTool({ name: "doc_read", arguments: { input: {} } });
    expect(missing.isError).toBe(true);
    await client.callTool({
      name: "drive_upload_attachment",
      arguments: { attachmentId: "source", name: "upload.txt", parentType: "explorer", parentNode: "" },
    });
    await client.callTool({
      name: "drive_download_to_attachment",
      arguments: { fileToken: "file", sessionId: "session" },
    });
    expect(gateway.request).toHaveBeenCalled();
    expect(gateway.upload).toHaveBeenCalled();
    expect(gateway.download).toHaveBeenCalled();
    expect(core.upload).toHaveBeenCalled();
    await client.close();
    await server.close();
  });
});
