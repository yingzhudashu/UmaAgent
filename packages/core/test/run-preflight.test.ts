import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { Session } from "@uma-agent/protocol";
import { describe, expect, it, vi } from "vitest";
import type { ContextManager } from "../src/context-manager.js";
import type { UmaDatabase } from "../src/database.js";
import type { ModelCallService } from "../src/model-calls.js";
import type { ModelRegistry } from "../src/models.js";
import { RunPreflight } from "../src/run-preflight.js";

const session: Session = {
  id: "session",
  title: "Test",
  workspace: "C:/workspace",
  model: { provider: "faux", id: "model" },
  thinkingLevel: "off",
  queueMode: "queue",
  createdAt: 1,
  updatedAt: 1,
};

function fixture(responses: string[] = ['{"taskClass":"simple"}']) {
  const database = {
    searchMemory: vi.fn(() => []),
    addAudit: vi.fn(),
  };
  const models = {
    forRole: vi.fn(() => ({ provider: "faux", id: "model", contextWindow: 100_000 })),
  };
  const history: AgentMessage[] = [
    { role: "user", content: "请读取 report.docx", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "text", text: "我会查看 report.docx" }],
      api: "openai-responses",
      provider: "faux",
      model: "model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    } as AgentMessage,
  ];
  const contextManager = {
    buildForMessage: vi.fn(async () => ({
      messages: history,
      current: {
        id: "current",
        sequence: 3,
        message: { role: "user", content: "这个文件的标题是什么？", timestamp: 3 },
      },
    })),
  };
  const complete = vi.fn(async () => fauxAssistantMessage(responses.shift() ?? "{}"));
  const modelCalls = { complete };
  const preflight = new RunPreflight(
    database as unknown as UmaDatabase,
    models as unknown as ModelRegistry,
    contextManager as unknown as ContextManager,
    modelCalls as unknown as ModelCallService,
  );
  return { preflight, database, complete, contextManager };
}

describe("RunPreflight", () => {
  it("passes the complete current-session history to classification and planning", async () => {
    const { preflight, complete, contextManager } = fixture([
      '{"taskClass":"standard"}',
      JSON.stringify({
        taskClass: "standard",
        goal: "读取 report.docx",
        reasoningSummary: "已有文件上下文",
        successCriteria: ["回答标题"],
        assumptions: [],
        questions: [],
        steps: [],
      }),
    ]);
    const result = await preflight.decide(
      session,
      { messageId: "current", text: "这个文件的标题是什么？", mode: "agent" },
      new AbortController().signal,
      "run",
    );
    expect(result.route).toBe("direct");
    expect(contextManager.buildForMessage).toHaveBeenCalledWith(
      session,
      "current",
      expect.any(AbortSignal),
      expect.anything(),
    );
    expect(complete.mock.calls[0]?.[0].messages).toHaveLength(3);
    expect(JSON.stringify(complete.mock.calls[0]?.[0].messages)).toContain("report.docx");
  });

  it("uses the same context prefix when repairing invalid JSON", async () => {
    const { preflight, complete } = fixture(["invalid", '{"taskClass":"simple"}']);
    await preflight.decide(
      session,
      { messageId: "current", text: "继续", mode: "agent" },
      new AbortController().signal,
      "run",
    );
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1]?.[0].messages.slice(0, 3)).toEqual(complete.mock.calls[0]?.[0].messages);
  });

  it("generates a plan route from structured planning output", async () => {
    const { preflight } = fixture([
      JSON.stringify({
        taskClass: "complex",
        goal: "完成文件检查",
        reasoningSummary: "需要步骤",
        successCriteria: ["完成"],
        assumptions: [],
        questions: [],
        steps: ["读取文件\n范围/输入：report.docx\n预期产出：标题\n验证：标题非空"],
      }),
    ]);
    await expect(
      preflight.decide(
        session,
        { messageId: "current", text: "检查文件", mode: "plan" },
        new AbortController().signal,
        "run",
      ),
    ).resolves.toMatchObject({ route: "plan", steps: [expect.stringContaining("report.docx")] });
  });
});
