/** Canonical shortcut names shared by Web, CLI, and channel adapters. */
export const AGENT_SHORTCUT_COMMANDS = [
  "/help",
  "/status",
  "/doctor",
  "/config",
  "/model",
  "/reload-config",
  "/session list",
  "/session status",
  "/queue status",
  "/btw status",
  "/schedule list",
  "/kb list",
  "/memory status",
  "/stats",
  "/test list",
  "/self-opt proposals",
  "/reload-skills",
] as const;
export type AgentShortcutCommand = (typeof AGENT_SHORTCUT_COMMANDS)[number];
