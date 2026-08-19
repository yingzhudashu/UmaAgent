import type { SessionMode } from "@uma-agent/protocol";

export type ToolClass = "read" | "write" | "shell" | "http_get" | "attachment_read" | "memory_write" | "mcp";

export interface PermissionDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
}

const readTools = new Set(["read", "list", "search", "memory_search", "knowledge_search"]);
const writeTools = new Set(["write", "edit"]);

export class PermissionPolicy {
  classify(toolName: string): ToolClass {
    if (readTools.has(toolName)) return "read";
    if (writeTools.has(toolName)) return "write";
    if (toolName === "shell") return "shell";
    if (toolName === "http_get") return "http_get";
    if (toolName === "attachment_read") return "attachment_read";
    if (toolName === "memory_write") return "memory_write";
    return "mcp";
  }

  decide(mode: SessionMode, toolName: string): PermissionDecision {
    const kind = this.classify(toolName);
    if (
      mode === "assistant" &&
      !["memory_write", "memory_search", "knowledge_search", "attachment_read"].includes(toolName)
    ) {
      return { allowed: false, requiresApproval: false, reason: "Tool is unavailable in assistant sessions" };
    }
    if (kind === "shell" || kind === "mcp") {
      return {
        allowed: true,
        requiresApproval: true,
        reason: kind === "shell" ? "Shell execution always requires approval" : "MCP tools require approval",
      };
    }
    return { allowed: true, requiresApproval: false, reason: "Allowed by session policy" };
  }
}
