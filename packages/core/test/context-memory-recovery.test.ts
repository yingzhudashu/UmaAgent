import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateContextTokens } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { assertContextCapacity, ContextManager } from "../src/context-manager.js";
import { testDatabase } from "./test-database.js";

interface EvidenceMessage {
  id: string;
  sequence: number;
  role: "user" | "assistant" | "tool";
  content: string;
  payload_json: string | null;
  created_at: number;
}

interface Evidence {
  sessionId: string;
  summary: { through_sequence: number; content: string; updated_at: number };
  messages: EvidenceMessage[];
}

vi.mock("@earendil-works/pi-agent-core", async (original) => ({
  ...(await original<typeof import("@earendil-works/pi-agent-core")>()),
  generateSummary: vi.fn(async () => ({ ok: false, error: "offline provider failure" })),
}));

describe("context memory recovery", () => {
  it.skipIf(!process.env.UMA_HALL_EVIDENCE)(
    "restores Hall's earlier dialogue from the read-only production fixture during provider failure",
    async () => {
      const evidencePath = process.env.UMA_HALL_EVIDENCE;
      if (!evidencePath) throw new Error("Fixture path is missing");
      const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as Evidence;
      const currentRow = evidence.messages.filter((row) => row.role === "user").at(-1);
      if (!currentRow) throw new Error("Fixture has no user message");
      const entries = evidence.messages
        .filter((row) => row.sequence < currentRow.sequence)
        .map((row) => ({
          id: row.id,
          sequence: row.sequence,
          message: row.payload_json
            ? JSON.parse(row.payload_json)
            : ({
                role: row.role === "tool" ? "toolResult" : row.role,
                content: row.role === "user" ? row.content : [{ type: "text", text: row.content }],
                timestamp: row.created_at,
              } as AgentMessage),
        }));
      const previous = {
        sessionId: evidence.sessionId,
        throughSequence: evidence.summary.through_sequence,
        content: evidence.summary.content,
        updatedAt: evidence.summary.updated_at,
      };
      const put = vi.fn();
      const database = {
        getContextSummary: () => previous,
        putContextSummary: put,
        getMessageWithAgentContext: () => ({ transcript: { ...currentRow, status: "complete" } }),
        listAgentMessages: (_id: string, options: { afterSequence?: number }) =>
          entries.filter((entry) => entry.sequence > (options.afterSequence ?? 0)),
      };
      const model = { provider: "openai", id: "gpt-6.1-sol", contextWindow: 500_000, maxTokens: 128_000 };
      const manager = new ContextManager(database as never, { models: {}, get: () => model } as never);
      const result = await manager.buildForMessage(
        { id: evidence.sessionId } as never,
        currentRow.id,
        new AbortController().signal,
        model as never,
      );
      const users = result.messages.filter((message) => message.role === "user");
      const expected = entries.filter((entry) => entry.message.role === "user");
      console.log(
        `HALL recovered_user_messages=${users.length}/${expected.length}; context_tokens=${estimateContextTokens(result.messages).tokens}; persisted_summary_writes=${put.mock.calls.length}`,
      );
      for (const entry of expected) expect(users).toContainEqual(entry.message);
      expect(
        result.messages.some(
          (message) => message.role === "assistant" && JSON.stringify(message).includes("STK"),
        ),
      ).toBe(true);
      expect(result.messages.some((message) => message.role === "compactionSummary")).toBe(false);
      expect(estimateContextTokens(result.messages).tokens).toBeLessThan(400_000);
      expect(() => assertContextCapacity(model as never, result.messages)).not.toThrow();
      expect(put).not.toHaveBeenCalled();
    },
  );

  it("does not reuse an unscoped legacy summary or a summary from another branch", () => {
    const root = mkdtempSync(resolve(tmpdir(), "uma-memory-"));
    const db = testDatabase(root);
    try {
      const session = db.createSession({
        title: "history",
        workspace: root,
        model: { provider: "test", id: "model" },
        thinkingLevel: "off",
      });
      db.db
        .prepare(
          "INSERT INTO context_summaries(session_id,through_sequence,content,updated_at) VALUES(?,?,?,?)",
        )
        .run(session.id, 810, "已有摘要：已有摘要：%PDF", 1);
      expect(db.getContextSummary(session.id)).toBeUndefined();
      db.putContextSummary(session.id, 12, "Verified history");
      expect(db.getContextSummary(session.id)?.throughSequence).toBe(12);
      db.db
        .prepare(
          "INSERT INTO conversation_branches(id,session_id,name,created_at,updated_at) VALUES(?,?,?,?,?)",
        )
        .run("other", session.id, "other", 1, 1);
      db.db.prepare("UPDATE sessions SET active_branch_id=? WHERE id=?").run("other", session.id);
      expect(db.getContextSummary(session.id)).toBeUndefined();
      db.putContextSummary(session.id, 8, "Other branch history");
      expect(db.getContextSummary(session.id)?.content).toBe("Other branch history");
      expect(() => db.putContextSummary(session.id, 100, "Stale completion", session.activeBranchId)).toThrow(
        "Context branch changed",
      );
      expect(db.getContextSummary(session.id)?.content).toBe("Other branch history");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("configures GPT-6.1 Sol at 500k across versioned release templates", () => {
    // 单元测试只校验仓库合同；本机私有配置可以按供应商额度设置不同窗口，
    // 不读取其中的凭据，也不要求开发者为运行测试修改实际运行配置。
    for (const file of [
      "uma.config.example.json",
      "docker/uma.config.json",
      "deploy/uma.config.native.example.json",
      "deploy/uma.config.production.example.json",
      "deploy/uma.config.staging.example.json",
    ]) {
      const config = JSON.parse(readFileSync(resolve(process.cwd(), file), "utf8"));
      expect(config.models["gpt-6.1-sol"].contextWindow, file).toBe(500_000);
    }
  });
});
