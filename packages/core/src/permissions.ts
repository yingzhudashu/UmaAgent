import type { InteractionMode } from "@uma-agent/protocol";

export type ToolClass =
  | "read"
  | "write"
  | "shell"
  | "http_get"
  | "attachment_read"
  | "memory_write"
  | "schedule"
  | "mcp";

export interface PermissionDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
}

const readTools = new Set([
  "read",
  "list",
  "search",
  "memory_search",
  "knowledge_search",
  "skill_read",
  "web_search",
  "history_search",
  "history_read",
]);
const writeTools = new Set(["write", "edit", "attachment_create_from_workspace"]);

export class PermissionPolicy {
  classify(toolName: string): ToolClass {
    if (readTools.has(toolName)) return "read";
    if (writeTools.has(toolName)) return "write";
    if (toolName === "shell") return "shell";
    if (toolName === "http_get") return "http_get";
    if (toolName === "attachment_read") return "attachment_read";
    if (toolName === "memory_write") return "memory_write";
    if (toolName === "schedule_manage") return "schedule";
    return "mcp";
  }

  decide(mode: InteractionMode, toolName: string): PermissionDecision {
    const kind = this.classify(toolName);
    if (mode !== "agent" && mode !== "plan")
      return { allowed: false, requiresApproval: false, reason: `${mode} mode does not execute tools` };
    if (kind === "mcp" && !toolName.startsWith("mcp_")) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: "Unknown tool is denied by capability policy",
      };
    }
    if (kind === "shell" || kind === "mcp" || kind === "memory_write" || kind === "schedule") {
      return {
        allowed: true,
        requiresApproval: true,
        reason:
          kind === "shell"
            ? "Shell execution always requires approval"
            : kind === "memory_write"
              ? "Explicit memory writes require approval"
              : kind === "schedule"
                ? "Schedule changes always require approval"
                : "MCP tools require approval",
      };
    }
    return { allowed: true, requiresApproval: false, reason: "Allowed by session policy" };
  }
}
