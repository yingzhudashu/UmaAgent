import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { parseJson } from "./database-utils.js";

export function serializeUpdatedMessagePayload(
  current: { payload_json?: unknown; role?: unknown },
  patch: { content?: string; payload?: AgentMessage },
): string | null {
  if (patch.payload) return JSON.stringify(patch.payload);
  if (patch.content !== undefined && String(current.role) === "user" && current.payload_json) {
    return JSON.stringify({
      ...parseJson<Record<string, unknown>>(current.payload_json, {}),
      content: patch.content,
    });
  }
  return current.payload_json ? String(current.payload_json) : null;
}
