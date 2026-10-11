import Type, { type Static } from "typebox";
import { Strict, Timestamp } from "./schema-helpers.js";

export const AgentProfileSchema = Strict({
  content: Type.String({ maxLength: 50_000 }),
  updatedAt: Timestamp,
});
export type AgentProfile = Static<typeof AgentProfileSchema>;
