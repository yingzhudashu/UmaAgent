import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { Session } from "@uma-agent/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextManager } from "../src/context-manager.js";
import type { UmaDatabase } from "../src/database.js";
import type { KnowledgeService } from "../src/knowledge.js";
import type { ModelRegistry } from "../src/models.js";
import type { PermissionPolicy } from "../src/permissions.js";
import { RunContextBuilder } from "../src/run-context.js";
import type { SkillRegistry } from "../src/skills.js";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("run context builder", () => {
  it("reconstructs plans, persisted context, images and a read-only tool set", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-context-builder-"));
    temporary.push(root);
    const imagePath = join(root, "image.png");
    await writeFile(imagePath, new Uint8Array([1, 2, 3]));
    const model = {
      provider: "test",
      id: "model",
      contextWindow: 100_000,
      maxTokens: 4_096,
    } as Model<"openai-responses">;
    const database = {
      sessionOwner: vi.fn(() => "system"),
      getMessage: vi.fn(() => ({ sequence: 7 })),
      getRun: vi.fn(() => ({ model: { ref: { provider: "test", id: "model" } } })),
      listAgentMessages: vi.fn(() => []),
      searchMemory: vi.fn(() => ["likes deterministic tests"]),
      getAgentProfile: vi.fn(() => ({
        ownerName: "",
        identity: "",
        instructions: "",
        updatedAt: 1,
      })),
      listMemoryRollups: vi.fn(() => []),
      getAttachment: vi.fn((id: string) => ({
        id,
        name: id === "image" ? "diagram.png" : "notes.txt",
        mimeType: id === "image" ? "image/png" : "text/plain",
      })),
      getAttachmentPath: vi.fn(() => imagePath),
    } as unknown as UmaDatabase;
    const contextManager = {
      buildForMessage: vi.fn(async () => ({
        summary: { content: "persisted summary" },
        messages: [
          { role: "compactionSummary", summary: "persisted summary", tokensBefore: 0, timestamp: 1 },
          { role: "user", content: "history", timestamp: 1 },
        ],
        current: { id: "message", sequence: 7, message: { role: "user", content: "original", timestamp: 1 } },
      })),
      compact: vi.fn(async () => ({
        summary: { content: "persisted summary" },
        messages: [
          { role: "compactionSummary", summary: "persisted summary", tokensBefore: 0, timestamp: 1 },
          { role: "user", content: "history", timestamp: 1 },
        ],
      })),
    } as unknown as ContextManager;
    const builder = new RunContextBuilder(
      database,
      { fromSnapshot: vi.fn(() => model) } as unknown as ModelRegistry,
      contextManager,
      {
        search: vi.fn(() => [{ filePath: "notes.md", content: "known answer" }]),
      } as unknown as KnowledgeService,
      { systemPrompt: vi.fn(() => "\n<skills>safe</skills>") } as unknown as SkillRegistry,
      {
        classify: vi.fn((name: string) => (name === "attachment_read" ? "attachment_read" : name)),
      } as unknown as PermissionPolicy,
    );
    const session = {
      id: "session",
      title: "test",
      model: { provider: "test", id: "model" },
      thinkingLevel: "off",
      createdAt: 1,
      updatedAt: 1,
    } satisfies Session;
    const tools = [{ name: "read" }, { name: "write" }, { name: "attachment_read" }] as AgentTool[];
    const context = await builder.build({
      session,
      runId: "run",
      request: {
        messageId: "message",
        text: "original",
        attachmentIds: ["image", "text"],
      },
      decision: {
        taskClass: "complex",
        route: "plan",
        goal: "goal",
        reasoningSummary: "summary",
        successCriteria: ["done"],
        assumptions: [],
        questions: [],
        steps: ["first", "second"],
      },
      signal: new AbortController().signal,
      tools,
      promptOverride: "override",
      readOnly: true,
    });
    expect(context.prompt).toContain("override\n\nApproved execution plan:");
    expect(context.prompt).toContain("diagram.png (id: image, type: image/png)");
    expect(context.prompt).toContain("notes.txt (id: text, type: text/plain)");
    expect(context.systemPrompt).not.toContain("persisted summary");
    expect(context.messages[0]?.role).toBe("compactionSummary");
    expect(context.messages[0]).toMatchObject({ summary: "persisted summary" });
    expect(context.prompt).toContain("likes deterministic tests");
    expect(context.prompt).toContain("notes.md\nknown answer");
    expect(context.prompt.indexOf("override")).toBeLessThan(context.prompt.indexOf("<relevant_memory>"));
    expect(context.prompt.indexOf("<relevant_memory>")).toBeLessThan(
      context.prompt.indexOf("<relevant_knowledge>"),
    );
    expect(context.images).toEqual([{ type: "image", data: "AQID", mimeType: "image/png" }]);
    expect(context.tools.map((tool) => tool.name)).toEqual(["read", "attachment_read"]);
  });
});
