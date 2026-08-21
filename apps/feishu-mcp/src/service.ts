import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UmaClient } from "@uma-agent/client";
import { z } from "zod";

export interface FeishuBusinessGateway {
  request(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, input?: unknown): Promise<unknown>;
  upload(
    path: string,
    file: { name: string; type: string; bytes: Uint8Array },
    input?: unknown,
  ): Promise<unknown>;
  download(path: string): Promise<{ name: string; type: string; bytes: Uint8Array }>;
}

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const object = z.record(z.string(), z.unknown()).optional();
const field = (value: Record<string, unknown>, name: string): string => {
  const result = value[name];
  if (typeof result !== "string" || !result) throw new Error(`${name} is required`);
  return encodeURIComponent(result);
};

export function createFeishuMcp(input: { gateway: FeishuBusinessGateway; core: UmaClient }): McpServer {
  const server = new McpServer({ name: "uma-feishu-mcp", version: "1.0.0" });
  const requestTool = (
    name: string,
    description: string,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: (value: Record<string, unknown>) => string,
  ) =>
    server.registerTool(name, { description, inputSchema: { input: object } }, async ({ input: value }) =>
      json(await input.gateway.request(method, path(value ?? {}), value ?? {})),
    );

  requestTool("doc_create", "Create a Feishu cloud document.", "POST", () => "/open-apis/docx/v1/documents");
  requestTool(
    "doc_read",
    "Read raw content from a Feishu document.",
    "GET",
    (value) => `/open-apis/docx/v1/documents/${field(value, "documentId")}/raw_content`,
  );
  requestTool(
    "doc_blocks",
    "List blocks in a Feishu document.",
    "GET",
    (value) => `/open-apis/docx/v1/documents/${field(value, "documentId")}/blocks`,
  );
  requestTool(
    "doc_append",
    "Append child blocks to a Feishu document.",
    "POST",
    (value) =>
      `/open-apis/docx/v1/documents/${field(value, "documentId")}/blocks/${field(value, "blockId")}/children`,
  );
  requestTool(
    "doc_block_update",
    "Update a Feishu document block.",
    "PATCH",
    (value) => `/open-apis/docx/v1/documents/${field(value, "documentId")}/blocks/${field(value, "blockId")}`,
  );
  requestTool(
    "doc_replace",
    "Replace the public content of one Feishu document block.",
    "PATCH",
    (value) => `/open-apis/docx/v1/documents/${field(value, "documentId")}/blocks/${field(value, "blockId")}`,
  );
  requestTool(
    "doc_batch_update",
    "Apply documented batch block operations.",
    "POST",
    (value) => `/open-apis/docx/v1/documents/${field(value, "documentId")}/blocks/batch_update`,
  );
  requestTool("drive_list", "List Feishu Drive files.", "GET", () => "/open-apis/drive/v1/files");
  requestTool(
    "drive_copy",
    "Copy a Feishu Drive file.",
    "POST",
    (value) => `/open-apis/drive/v1/files/${field(value, "fileToken")}/copy`,
  );
  requestTool(
    "drive_move",
    "Move a Feishu Drive file.",
    "POST",
    (value) => `/open-apis/drive/v1/files/${field(value, "fileToken")}/move`,
  );
  requestTool("drive_search", "Search Feishu Drive files.", "POST", () => "/open-apis/drive/v1/files/search");
  requestTool(
    "drive_permission_list",
    "List collaborators for a Feishu Drive resource.",
    "GET",
    (value) => `/open-apis/drive/v1/permissions/${field(value, "fileToken")}/members`,
  );
  requestTool(
    "drive_permission_add",
    "Grant a collaborator access to a Feishu Drive resource.",
    "POST",
    (value) => `/open-apis/drive/v1/permissions/${field(value, "fileToken")}/members`,
  );
  requestTool(
    "drive_permission_delete",
    "Remove a collaborator from a Feishu Drive resource.",
    "DELETE",
    (value) =>
      `/open-apis/drive/v1/permissions/${field(value, "fileToken")}/members/${field(value, "memberId")}`,
  );
  requestTool(
    "bitable_metadata",
    "Read Bitable application metadata.",
    "GET",
    (value) => `/open-apis/bitable/v1/apps/${field(value, "appToken")}`,
  );
  requestTool(
    "bitable_fields",
    "List Bitable fields.",
    "GET",
    (value) =>
      `/open-apis/bitable/v1/apps/${field(value, "appToken")}/tables/${field(value, "tableId")}/fields`,
  );
  requestTool(
    "bitable_field_create",
    "Create a Bitable field.",
    "POST",
    (value) =>
      `/open-apis/bitable/v1/apps/${field(value, "appToken")}/tables/${field(value, "tableId")}/fields`,
  );
  requestTool(
    "bitable_field_update",
    "Update a Bitable field.",
    "PATCH",
    (value) =>
      `/open-apis/bitable/v1/apps/${field(value, "appToken")}/tables/${field(value, "tableId")}/fields/${field(value, "fieldId")}`,
  );
  requestTool(
    "bitable_field_delete",
    "Delete a Bitable field.",
    "DELETE",
    (value) =>
      `/open-apis/bitable/v1/apps/${field(value, "appToken")}/tables/${field(value, "tableId")}/fields/${field(value, "fieldId")}`,
  );
  requestTool(
    "bitable_tables",
    "List Bitable tables with the supplied pagination input.",
    "GET",
    (value) => `/open-apis/bitable/v1/apps/${field(value, "appToken")}/tables`,
  );
  requestTool(
    "bitable_table_create",
    "Create a Bitable table.",
    "POST",
    (value) => `/open-apis/bitable/v1/apps/${field(value, "appToken")}/tables`,
  );
  requestTool(
    "bitable_table_update",
    "Update a Bitable table.",
    "PATCH",
    (value) => `/open-apis/bitable/v1/apps/${field(value, "appToken")}/tables/${field(value, "tableId")}`,
  );
  requestTool(
    "bitable_table_delete",
    "Delete a Bitable table.",
    "DELETE",
    (value) => `/open-apis/bitable/v1/apps/${field(value, "appToken")}/tables/${field(value, "tableId")}`,
  );
  requestTool(
    "bitable_records",
    "List and filter Bitable records.",
    "GET",
    (value) =>
      `/open-apis/bitable/v1/apps/${field(value, "appToken")}/tables/${field(value, "tableId")}/records`,
  );
  requestTool(
    "bitable_record_create",
    "Create a Bitable record.",
    "POST",
    (value) =>
      `/open-apis/bitable/v1/apps/${field(value, "appToken")}/tables/${field(value, "tableId")}/records`,
  );
  requestTool(
    "bitable_record_update",
    "Update a Bitable record.",
    "PATCH",
    (value) =>
      `/open-apis/bitable/v1/apps/${field(value, "appToken")}/tables/${field(value, "tableId")}/records/${field(value, "recordId")}`,
  );
  requestTool(
    "bitable_record_delete",
    "Delete a Bitable record.",
    "DELETE",
    (value) =>
      `/open-apis/bitable/v1/apps/${field(value, "appToken")}/tables/${field(value, "tableId")}/records/${field(value, "recordId")}`,
  );

  server.registerTool(
    "drive_upload_attachment",
    {
      description: "Upload an Uma attachment to Feishu Drive.",
      inputSchema: {
        attachmentId: z.string().min(1),
        name: z.string().min(1),
        parentType: z.string().default("explorer"),
        parentNode: z.string().default(""),
      },
    },
    async ({ attachmentId, name, parentType, parentNode }) => {
      const blob = await input.core.attachmentContent(attachmentId);
      return json(
        await input.gateway.upload(
          "/open-apis/drive/v1/files/upload_all",
          {
            name,
            type: blob.type || "application/octet-stream",
            bytes: new Uint8Array(await blob.arrayBuffer()),
          },
          { parentType, parentNode },
        ),
      );
    },
  );
  server.registerTool(
    "drive_download_to_attachment",
    {
      description: "Download a Feishu Drive file into one Uma session attachment.",
      inputSchema: { fileToken: z.string().min(1), sessionId: z.string().min(1) },
    },
    async ({ fileToken, sessionId }) => {
      const file = await input.gateway.download(
        `/open-apis/drive/v1/files/${encodeURIComponent(fileToken)}/download`,
      );
      const attachment = await input.core.upload(
        new Blob([file.bytes.slice().buffer as ArrayBuffer], { type: file.type }),
        file.name,
        sessionId,
      );
      return json(attachment);
    },
  );
  requestTool(
    "im_send_file",
    "Send an uploaded Feishu file to a chat.",
    "POST",
    () => "/open-apis/im/v1/messages?receive_id_type=chat_id",
  );
  return server;
}
