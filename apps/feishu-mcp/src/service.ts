import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UmaClient } from "@uma-agent/client";
import { z } from "zod";
import { markdownToFeishuBlocks } from "./markdown.js";

export interface FeishuBusinessGateway {
  request(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, input?: unknown): Promise<unknown>;
  upload(
    path: string,
    file: { name: string; type: string; bytes: Uint8Array },
    input?: unknown,
  ): Promise<unknown>;
  download(path: string): Promise<{ name: string; type: string; bytes: Uint8Array }>;
}

export function isFeishuRateLimit(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as Record<string, unknown>;
  const response = value.response as Record<string, unknown> | undefined;
  return value.status === 429 || response?.status === 429 || value.code === 99991400;
}

export async function retryFeishuOperation<T>(
  operation: () => Promise<T>,
  options: { attempts?: number; delay?: (milliseconds: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = options.attempts ?? 4;
  const delay =
    options.delay ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isFeishuRateLimit(error) || attempt === attempts - 1) throw error;
      await delay(250 * 2 ** attempt);
    }
  }
  throw lastError;
}

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const object = z.record(z.string(), z.unknown()).optional();
const field = (value: Record<string, unknown>, name: string): string => {
  const result = value[name];
  if (typeof result !== "string" || !result) throw new Error(`${name} is required`);
  return encodeURIComponent(result);
};
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const normalizePage = (value: unknown) => {
  const root = record(value);
  const data = record(root.data ?? root);
  return {
    items: Array.isArray(data.items) ? data.items : [],
    nextPageToken:
      typeof data.page_token === "string"
        ? data.page_token
        : typeof data.pageToken === "string"
          ? data.pageToken
          : undefined,
    hasMore: Boolean(data.has_more ?? data.hasMore),
  };
};
const documentId = (value: unknown): string => {
  const root = record(value);
  const data = record(root.data ?? root);
  const document = record(data.document ?? data);
  const id = document.document_id ?? document.documentId;
  if (typeof id !== "string" || !id) throw new Error("Feishu did not return a document id");
  return id;
};

const createdBlocks = (value: unknown): Array<Record<string, unknown>> => {
  const root = record(value);
  const data = record(root.data ?? root);
  const values = data.children ?? data.items ?? root.children;
  return Array.isArray(values) ? values.map(record) : [];
};

async function appendMarkdown(input: {
  gateway: FeishuBusinessGateway;
  core: UmaClient;
  documentId: string;
  blockId: string;
  markdown: string;
  index?: number;
}) {
  const converted = markdownToFeishuBlocks(input.markdown);
  const pendingImages = converted.flatMap((block, index) => {
    const id = block.__umaAttachmentId;
    return typeof id === "string" ? [{ attachmentId: id, index }] : [];
  });
  const children = converted.map((block) => {
    const { __umaAttachmentId: _attachmentId, __umaAlt: _alt, ...publicBlock } = block;
    return publicBlock;
  });
  const appended = await input.gateway.request(
    "POST",
    `/open-apis/docx/v1/documents/${encodeURIComponent(input.documentId)}/blocks/${encodeURIComponent(input.blockId)}/children`,
    { children, ...(input.index === undefined ? {} : { index: input.index }) },
  );
  const returnedBlocks = createdBlocks(appended);
  const images = [];
  for (const pending of pendingImages) {
    const created = returnedBlocks[pending.index];
    const blockId = created?.block_id ?? created?.blockId;
    if (typeof blockId !== "string" || !blockId)
      throw new Error("Feishu did not return the created image block id; the attachment was not uploaded");
    const blob = await input.core.attachmentContent(pending.attachmentId);
    const uploaded = await input.gateway.upload(
      "/open-apis/drive/v1/medias/upload_all",
      {
        name: `${pending.attachmentId}.${blob.type.split("/")[1] || "bin"}`,
        type: blob.type || "application/octet-stream",
        bytes: new Uint8Array(await blob.arrayBuffer()),
      },
      { parentType: "docx_image", parentNode: blockId },
    );
    images.push({ attachmentId: pending.attachmentId, blockId, uploaded });
  }
  return { blockCount: children.length, appended, images };
}

export function createFeishuMcp(input: { gateway: FeishuBusinessGateway; core: UmaClient }): McpServer {
  const server = new McpServer({ name: "uma-feishu-mcp", version: "1.2.0" });
  const requestTool = (
    name: string,
    description: string,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: (value: Record<string, unknown>) => string,
    paged = false,
  ) =>
    server.registerTool(name, { description, inputSchema: { input: object } }, async ({ input: value }) =>
      json(
        await input.gateway
          .request(method, path(value ?? {}), value ?? {})
          .then((result) => (paged ? normalizePage(result) : result)),
      ),
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
  requestTool("drive_list", "List Feishu Drive files.", "GET", () => "/open-apis/drive/v1/files", true);
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
  requestTool(
    "drive_search",
    "Search Feishu Drive files.",
    "POST",
    () => "/open-apis/drive/v1/files/search",
    true,
  );
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
    true,
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
    true,
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
    true,
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
  for (const operation of ["batch_create", "batch_update", "batch_delete"] as const)
    requestTool(
      `bitable_records_${operation}`,
      `Perform a Bitable records ${operation.replace("_", " ")} operation.`,
      "POST",
      (value) =>
        `/open-apis/bitable/v1/apps/${field(value, "appToken")}/tables/${field(value, "tableId")}/records/${operation}`,
    );

  server.registerTool(
    "doc_create_from_markdown",
    {
      description: "Create a Feishu document and append converted Markdown blocks.",
      inputSchema: { title: z.string().min(1), markdown: z.string() },
    },
    async ({ title, markdown }) => {
      const created = await input.gateway.request("POST", "/open-apis/docx/v1/documents", { title });
      const id = documentId(created);
      const appended = await appendMarkdown({
        gateway: input.gateway,
        core: input.core,
        documentId: id,
        blockId: id,
        markdown,
        index: 0,
      });
      return json({ documentId: id, created, ...appended });
    },
  );
  server.registerTool(
    "doc_append_markdown",
    {
      description: "Append converted Markdown blocks to a Feishu document block.",
      inputSchema: {
        documentId: z.string().min(1),
        blockId: z.string().min(1).optional(),
        markdown: z.string(),
      },
    },
    async ({ documentId: id, blockId, markdown }) => {
      const result = await appendMarkdown({
        gateway: input.gateway,
        core: input.core,
        documentId: id,
        blockId: blockId ?? id,
        markdown,
      });
      return json({ documentId: id, ...result });
    },
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
