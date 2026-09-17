import shortcuts from "./commands.json" with { type: "json" };

/** Web、Android 和 CLI 使用同一目录；权限标记只用于说明，Core 仍独立鉴权。 */
export const AGENT_SHORTCUT_CATALOG = shortcuts;
export const AGENT_SHORTCUT_COMMANDS = shortcuts.map((item) => item.command);
export type AgentShortcutCommand = (typeof AGENT_SHORTCUT_COMMANDS)[number];
