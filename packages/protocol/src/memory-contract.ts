import Type, { type Static } from "typebox";
import { Id, Strict, Timestamp } from "./schema-helpers.js";

export const MemoryFactSchema = Strict({
  id: Id,
  sessionId: Type.Optional(Id),
  scope: Type.Union([Type.Literal("global"), Type.Literal("session")]),
  key: Type.String({ minLength: 1, maxLength: 500 }),
  value: Type.String({ minLength: 1 }),
  category: Type.String({ minLength: 1, maxLength: 100 }),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  evidence: Type.Optional(Type.String()),
  sourceRunId: Type.Optional(Id),
  status: Type.Union([
    Type.Literal("active"),
    Type.Literal("candidate"),
    Type.Literal("superseded"),
    Type.Literal("rejected"),
  ]),
  supersedes: Type.Optional(Id),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type MemoryFact = Static<typeof MemoryFactSchema>;
