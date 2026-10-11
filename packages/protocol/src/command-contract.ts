import Type, { type Static } from "typebox";
import { Id, Strict } from "./schema-helpers.js";

export const CommandRequestSchema = Strict({
  command: Type.String({ minLength: 1, maxLength: 100_000 }),
  messageId: Type.Optional(Id),
});
export type CommandRequest = Static<typeof CommandRequestSchema>;

export const ShortcutRequestSchema = Strict({
  command: Type.String({ minLength: 1, maxLength: 500 }),
});
export type ShortcutRequest = Static<typeof ShortcutRequestSchema>;

export const ShortcutResponseSchema = Strict({
  command: Type.String({ minLength: 1, maxLength: 500 }),
  output: Type.String({ maxLength: 100_000 }),
});
export type ShortcutResponse = Static<typeof ShortcutResponseSchema>;

/** Canonical read-only shortcut names shared by Web, CLI, and channel adapters. */
export { AGENT_SHORTCUT_CATALOG, AGENT_SHORTCUT_COMMANDS, type AgentShortcutCommand } from "./commands.js";
