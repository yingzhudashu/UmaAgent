import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import {
  createFeishuMcp,
  type FeishuBusinessGateway,
  isFeishuRateLimit,
  retryFeishuOperation,
} from "../src/service.js";

describe("Feishu MCP", () => {
  it("retries documented Feishu rate limits with bounded exponential backoff", async () => {
    const delays: number[] = [];
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({ status: 429 })
      .mockRejectedValueOnce({ response: { status: 429 } })
      .mockRejectedValueOnce({ code: 99991400 })
      .mockResolvedValue("ok");
    await expect(
      retryFeishuOperation(operation, {
        delay: async (milliseconds) => {
          delays.push(milliseconds);
        },
      }),
    ).resolves.toBe("ok");
    expect(delays).toEqual([250, 500, 1_000]);
    expect(isFeishuRateLimit(undefined)).toBe(false);
    await expect(
      retryFeishuOperation(async () => Promise.reject(new Error("permanent")), {
        delay: async () => {},
      }),
    ).rejects.toThrow("permanent");
    await expect(
      retryFeishuOperation(async () => Promise.reject({ status: 429 }), {
        attempts: 1,
        delay: async () => {},
      }),
    ).rejects.toEqual({ status: 429 });
  });

  it("maps document, Bitable, Drive and attachment operations through injected gateways", async () => {
    const gateway: FeishuBusinessGateway = {
      request: vi.fn(async (method, path) =>
        method === "POST" && path === "/open-apis/docx/v1/documents"
          ? { data: { document: { document_id: "created-doc" } } }
          : { method, path, data: { items: [], has_more: false } },
      ),
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
    await client.callTool({
      name: "doc_create_from_markdown",
      arguments: { title: "Test", markdown: "# Heading\n\nBody" },
    });
    await client.callTool({
      name: "doc_append_markdown",
      arguments: { documentId: "doc", markdown: "- item" },
    });
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

  it("normalizes both Feishu pagination shapes and rejects malformed document creation", async () => {
    let pageShape: "snake" | "camel" = "snake";
    const gateway: FeishuBusinessGateway = {
      request: vi.fn(async (method, path) => {
        if (method === "POST" && path === "/open-apis/docx/v1/documents")
          return pageShape === "snake" ? {} : { data: { document: {} } };
        return pageShape === "snake"
          ? { data: { items: ["snake"], page_token: "next-snake", has_more: 1 } }
          : { items: ["camel"], pageToken: "next-camel", hasMore: true };
      }),
      upload: vi.fn(),
      download: vi.fn(),
    };
    const server = createFeishuMcp({ gateway, core: {} as never });
    const client = new Client({ name: "pagination-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const snake = await client.callTool({ name: "drive_list", arguments: {} });
    expect(snake.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({ items: ["snake"], nextPageToken: "next-snake", hasMore: true }),
      },
    ]);
    const malformedRoot = await client.callTool({
      name: "doc_create_from_markdown",
      arguments: { title: "Missing ID", markdown: "body" },
    });
    expect(malformedRoot.isError).toBe(true);

    pageShape = "camel";
    const camel = await client.callTool({ name: "drive_list", arguments: {} });
    expect(camel.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({ items: ["camel"], nextPageToken: "next-camel", hasMore: true }),
      },
    ]);
    const malformedNested = await client.callTool({
      name: "doc_create_from_markdown",
      arguments: { title: "Missing nested ID", markdown: "body" },
    });
    expect(malformedNested.isError).toBe(true);

    await client.close();
    await server.close();
  });

  it("uploads Uma attachment images into the image blocks created from Markdown", async () => {
    const gateway: FeishuBusinessGateway = {
      request: vi.fn(async (method, path) => {
        if (method === "POST" && path === "/open-apis/docx/v1/documents")
          return { data: { document: { document_id: "image-doc" } } };
        return { data: { children: [{ block_id: "image-block" }] } };
      }),
      upload: vi.fn(async () => ({ file_token: "image-token" })),
      download: vi.fn(),
    };
    const core = {
      attachmentContent: vi.fn(async () => new Blob(["png"], { type: "image/png" })),
    };
    const server = createFeishuMcp({ gateway, core: core as never });
    const client = new Client({ name: "image-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: "doc_create_from_markdown",
      arguments: { title: "Image", markdown: "![diagram](uma-attachment://attachment_123)" },
    });
    expect(result.isError).not.toBe(true);
    expect(core.attachmentContent).toHaveBeenCalledWith("attachment_123");
    expect(gateway.upload).toHaveBeenCalledWith(
      "/open-apis/drive/v1/medias/upload_all",
      expect.objectContaining({ name: "attachment_123.png", type: "image/png" }),
      { parentType: "docx_image", parentNode: "image-block" },
    );

    await client.close();
    await server.close();
  });
});
