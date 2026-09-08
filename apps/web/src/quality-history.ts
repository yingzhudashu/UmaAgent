import type { MessageQualityHistory, UmaClient } from "@uma-agent/client";
import type { QualityAssessment, TranscriptItem } from "@uma-agent/protocol";
import { useEffect, useRef } from "react";

export type QualityOperation = {
  kind: "review" | "improve";
  status: "running" | "completed" | "failed";
  runId?: string;
  error?: string;
  assessments?: readonly QualityAssessment[];
  result?: string;
};
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
  sessionId: string,
  transcript: readonly TranscriptItem[],
): Promise<Record<string, RestoredQualityOperation>> {
  const histories = await client.listSessionMessageQuality(sessionId);
  const restored: Record<string, RestoredQualityOperation> = {};
  for (const message of transcript) {
    if (message.role !== "assistant") continue;
    const history = histories[message.id] ?? [];
    const latest = [...history]
      .reverse()
      .find((item) => ["completed", "failed", "cancelled", "interrupted"].includes(item.status));
    if (!latest) continue;
    const result = transcript.find((item) => item.id === latest.resultMessageId)?.content;
    restored[message.id] = {
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
  const cached = useRef(new Map<string, Record<string, RestoredQualityOperation>>());
  const inFlight = useRef(new Map<string, Promise<Record<string, RestoredQualityOperation>>>());
  const cachedClient = useRef<UmaClient | undefined>(undefined);

  useEffect(() => {
    if (!enabled) {
      cached.current.clear();
      inFlight.current.clear();
      cachedClient.current = undefined;
      return;
    }
    if (!key || !transcript?.length) return;
    if (cachedClient.current !== client) {
      cached.current.clear();
      inFlight.current.clear();
      cachedClient.current = client;
    }
    if (cached.current.has(key) || inFlight.current.has(key)) return;
    const request = loadQualityHistory(client, key, transcript);
    inFlight.current.set(key, request);
    let cancelled = false;
    void request
      .then((value) => {
        if (cachedClient.current !== client) return;
        cached.current.set(key, value);
        if (!cancelled && Object.keys(value).length > 0) onLoaded(value);
      })
      .catch(() => undefined);
    void request
      .finally(() => {
        if (inFlight.current.get(key) === request) inFlight.current.delete(key);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, enabled, key, transcript, onLoaded]);
}
