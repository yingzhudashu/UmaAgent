import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Session } from "@uma-agent/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBuiltinTools, safeFetch } from "../src/tools.js";
import { WorkspacePolicy } from "../src/workspace.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

function text(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
}

async function execute(tools: AgentTool[], name: string, params: Record<string, unknown>) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool: ${name}`);
  return (tool.execute as (...args: unknown[]) => Promise<unknown>)(
    "call",
    params,
    new AbortController().signal,
  );
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "uma-tools-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const session: Session = {
    id: "session-1",
    workspace: root,
    title: "tools",
    model: { provider: "test", id: "model" },
    thinkingLevel: "off",
    createdAt: 1,
    updatedAt: 1,
  };
  const attachments = new Map<string, { path: string; name: string; mimeType: string }>();
  const database = {
    sessionOwner: vi.fn(() => "system"),
    searchMemory: vi.fn(() => ["remembered fact"]),
    validateAttachmentForSession: vi.fn(),
    getAttachment: vi.fn((id: string) => {
      const item = attachments.get(id);
      return item ? { id, name: item.name, mimeType: item.mimeType } : undefined;
    }),
    getAttachmentPath: vi.fn((id: string) => attachments.get(id)?.path),
  };
  const knowledge = { search: vi.fn(() => [{ filePath: "notes.md", content: "known answer" }]) };
  const skills = { read: vi.fn(() => "skill instructions") };
  const search = {
    search: vi.fn(() =>
      Promise.resolve([
        { title: "Result", url: "https://example.com", snippet: "summary", source: "tavily" },
      ]),
    ),
  };
  const scheduleManage = vi.fn(() => ({ ok: true }));
  const memoryWrite = vi.fn((scope: string, content: string) => ({ id: `${scope}:${content}` }));
  const workspacePolicy = new WorkspacePolicy([root]);
  await workspacePolicy.initialize();
  const tools = createBuiltinTools({
    session,
    database: database as never,
    knowledge: knowledge as never,
    skills: skills as never,
    workspacePolicy,
    toolTimeoutMs: 5_000,
    search: search as never,
    scheduleManage,
    memoryWrite: memoryWrite as never,
  });
  return { root, tools, database, knowledge, skills, search, scheduleManage, memoryWrite, attachments };
}

describe("builtin tools", () => {
  it("exposes the complete Agent toolset for a workspace session", async () => {
    const value = await fixture();
    expect(value.tools.map((tool) => tool.name)).toEqual([
      "history_search",
      "history_read",
      "read",
      "write",
      "edit",
      "list",
      "search",
      "shell",
      "http_get",
      "memory_write",
      "memory_search",
      "knowledge_search",
      "skill_read",
      "attachment_read",
      "web_search",
      "schedule_manage",
    ]);
    expect(text(await execute(value.tools, "memory_write", { content: "fact" }))).toBe("Memory stored");
    expect(text(await execute(value.tools, "memory_write", { content: "fact", scope: "global" }))).toBe(
      "Memory stored",
    );
    expect(text(await execute(value.tools, "memory_search", { query: "fact" }))).toContain("remembered");
    value.database.searchMemory.mockReturnValueOnce([]);
    expect(text(await execute(value.tools, "memory_search", { query: "none", limit: 1 }))).toBe(
      "No memories found",
    );
    expect(text(await execute(value.tools, "knowledge_search", { query: "known" }))).toContain(
      "known answer",
    );
    value.knowledge.search.mockReturnValueOnce([]);
    expect(text(await execute(value.tools, "knowledge_search", { query: "none", limit: 1 }))).toBe(
      "No knowledge found",
    );
    expect(text(await execute(value.tools, "skill_read", { name: "testing" }))).toBe("skill instructions");
    expect(text(await execute(value.tools, "web_search", { query: "UmaAgent" }))).toContain(
      "https://example.com",
    );
    value.search.search.mockReturnValueOnce(Promise.resolve([]));
    expect(
      text(
        await execute(value.tools, "web_search", {
          query: "none",
          provider: "stackexchange",
          limit: 1,
        }),
      ),
    ).toBe("No search results");
    expect(text(await execute(value.tools, "schedule_manage", { operation: "list" }))).toContain(
      '"ok": true',
    );
  });

  it("reads owned text attachments and rejects missing or binary attachments", async () => {
    const value = await fixture();
    const utf8 = join(value.root, "utf8.txt");
    const utf16 = join(value.root, "utf16.txt");
    await writeFile(utf8, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello")]));
    await writeFile(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("wide", "utf16le")]));
    value.attachments.set("utf8", { path: utf8, name: "utf8.txt", mimeType: "text/plain" });
    value.attachments.set("utf16", { path: utf16, name: "utf16.txt", mimeType: "application/json" });
    value.attachments.set("binary", { path: utf8, name: "image.png", mimeType: "image/png" });
    expect(text(await execute(value.tools, "attachment_read", { attachmentId: "utf8" }))).toBe("hello");
    expect(text(await execute(value.tools, "attachment_read", { attachmentId: "utf16" }))).toBe("wide");
    await expect(execute(value.tools, "attachment_read", { attachmentId: "missing" })).rejects.toThrow(
      "Attachment not found",
    );
    await expect(execute(value.tools, "attachment_read", { attachmentId: "binary" })).rejects.toThrow(
      "not readable text",
    );
  });

  it("executes workspace file, search, shell, memory, knowledge, skill and adapter tools", async () => {
    const value = await fixture();
    await mkdir(join(value.root, "src"));
    await writeFile(join(value.root, "src", "file.txt"), "first\nneedle\nthird");
    await mkdir(join(value.root, "node_modules"));
    await writeFile(join(value.root, "node_modules", "ignored.txt"), "needle");

    expect(text(await execute(value.tools, "read", { path: "src/file.txt", offset: 2, limit: 1 }))).toBe(
      "needle",
    );
    expect(
      text(await execute(value.tools, "write", { path: "nested/out.txt", content: "output" })),
    ).toContain("Wrote 6");
    expect(
      text(
        await execute(value.tools, "edit", {
          path: "src/file.txt",
          oldText: "needle",
          newText: "changed",
        }),
      ),
    ).toContain("Edited");
    await expect(
      execute(value.tools, "edit", { path: "src/file.txt", oldText: "missing", newText: "x" }),
    ).rejects.toThrow("not found");
    await writeFile(join(value.root, "duplicate.txt"), "same same");
    await expect(
      execute(value.tools, "edit", { path: "duplicate.txt", oldText: "same", newText: "x" }),
    ).rejects.toThrow("not unique");
    expect(text(await execute(value.tools, "list", {}))).toContain("src\\file.txt");
    expect(text(await execute(value.tools, "search", { query: "changed", path: "src" }))).toContain(
      "file.txt:2:changed",
    );
    expect(text(await execute(value.tools, "search", { query: "absent" }))).toBe("No matches");
    expect(text(await execute(value.tools, "shell", { command: "Write-Output tool-ok" }))).toContain(
      "tool-ok",
    );
    expect(text(await execute(value.tools, "memory_write", { content: "fact" }))).toBe("Memory stored");
    expect(text(await execute(value.tools, "memory_search", { query: "fact", limit: 1 }))).toContain(
      "remembered",
    );
    value.database.searchMemory.mockReturnValueOnce([]);
    expect(text(await execute(value.tools, "memory_search", { query: "missing" }))).toBe("No memories found");
    expect(text(await execute(value.tools, "knowledge_search", { query: "known", limit: 1 }))).toContain(
      "known answer",
    );
    value.knowledge.search.mockReturnValueOnce([]);
    expect(text(await execute(value.tools, "knowledge_search", { query: "missing" }))).toBe(
      "No knowledge found",
    );
    expect(text(await execute(value.tools, "skill_read", { name: "testing" }))).toBe("skill instructions");
    expect(text(await execute(value.tools, "schedule_manage", { operation: "list" }))).toContain("ok");

    const attachmentPath = join(value.root, "attachment.txt");
    await writeFile(attachmentPath, "workspace attachment");
    value.attachments.set("text", {
      path: attachmentPath,
      name: "attachment.txt",
      mimeType: "text/plain",
    });
    value.attachments.set("binary", {
      path: attachmentPath,
      name: "image.png",
      mimeType: "image/png",
    });
    expect(text(await execute(value.tools, "attachment_read", { attachmentId: "text" }))).toBe(
      "workspace attachment",
    );
    await expect(execute(value.tools, "attachment_read", { attachmentId: "missing" })).rejects.toThrow(
      "not found",
    );
    await expect(execute(value.tools, "attachment_read", { attachmentId: "binary" })).rejects.toThrow(
      "not readable",
    );
  });

  it("blocks unsafe URL schemes and private IPv4 and IPv6 targets", async () => {
    await expect(safeFetch("file:///etc/passwd")).rejects.toThrow("Only HTTP");
    for (const address of [
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.0.1",
      "172.16.0.1",
      "192.0.0.1",
      "192.0.2.1",
      "192.168.0.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "[::1]",
      "[::ffff:127.0.0.1]",
      "[fc00::1]",
      "[fd00::1]",
      "[fe80::1]",
      "[ff00::1]",
    ])
      await expect(safeFetch(`http://${address}/`)).rejects.toThrow("Private");
  });
});
