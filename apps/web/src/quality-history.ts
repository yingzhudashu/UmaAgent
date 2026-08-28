import type { MessageQualityHistory, UmaClient } from "@uma-agent/client";
import type { TranscriptItem } from "@uma-agent/protocol";
import { useEffect } from "react";

export type RestoredQualityOperation = {
  kind: "review" | "improve";
  status: "completed" | "failed";
  runId: string;
  error?: string;
  assessments: MessageQualityHistory["assessments"];
  result?: string;
};

export async function loadQualityHistory(
  client: UmaClient,
  transcript: readonly TranscriptItem[],
): Promise<Record<string, RestoredQualityOperation>> {
  const messages = transcript.filter((item) => item.role === "assistant");
  const entries = await Promise.all(
    messages.map(async (message) => [message.id, await client.listMessageQuality(message.id)] as const),
  );
  const restored: Record<string, RestoredQualityOperation> = {};
  for (const [messageId, history] of entries) {
    const latest = [...history]
      .reverse()
      .find((item) => ["completed", "failed", "cancelled", "interrupted"].includes(item.status));
    if (!latest) continue;
    const result = transcript.find((item) => item.id === latest.resultMessageId)?.content;
    restored[messageId] = {
      kind: latest.kind,
      status: latest.status === "completed" ? "completed" : "failed",
      runId: latest.runId,
      assessments: latest.assessments,
      ...(latest.error ? { error: latest.error } : {}),
      ...(result !== undefined ? { result } : {}),
    };
  }
  return restored;
}

export function useQualityHistory(
  client: UmaClient,
  transcript: readonly TranscriptItem[] | undefined,
  enabled: boolean,
  key: string | undefined,
  onLoaded: (value: Record<string, RestoredQualityOperation>) => void,
) {
  useEffect(() => {
    if (!enabled || !key || !transcript?.length) return;
    let cancelled = false;
    void loadQualityHistory(client, transcript)
      .then((value) => {
        if (!cancelled) onLoaded(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, enabled, key, transcript, onLoaded]);
}
