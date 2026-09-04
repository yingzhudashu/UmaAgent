import type { UmaClient } from "@uma-agent/client";
import type { TranscriptItem } from "@uma-agent/protocol";
import { describe, expect, it } from "vitest";
import { loadQualityHistory } from "../src/quality-history.js";

function assistant(id: string): TranscriptItem {
  return {
    id,
    sequence: Number(id),
    role: "assistant",
    status: "complete",
    content: `answer ${id}`,
    attachments: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("loadQualityHistory", () => {
  it("loads a session batch and restores only completed operations", async () => {
    const listSessionMessageQuality = async (id: string) => {
      expect(id).toBe("session-1");
      return {
        "1": [
          {
            kind: "review" as const,
            runId: "run-1",
            status: "completed" as const,
            assessments: [],
            resultMessageId: "2",
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        hidden: [
          {
            kind: "improve" as const,
            runId: "run-hidden",
            status: "completed" as const,
            assessments: [],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      };
    };
    const client = {
      listSessionMessageQuality,
    } as unknown as UmaClient;
    const transcript = Array.from({ length: 9 }, (_, index) => assistant(String(index + 1)));

    await expect(loadQualityHistory(client, "session-1", transcript)).resolves.toEqual({
      "1": {
        kind: "review",
        status: "completed",
        runId: "run-1",
        assessments: [],
        result: "answer 2",
      },
    });
  });
});
