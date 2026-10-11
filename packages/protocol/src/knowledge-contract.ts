import Type, { type Static } from "typebox";
import { Id, Strict, Timestamp } from "./schema-helpers.js";

export const MemoryRollupSchema = Strict({
  id: Id,
  sessionId: Id,
  kind: Type.Union([Type.Literal("turn"), Type.Literal("day"), Type.Literal("session")]),
  fromSequence: Type.Integer({ minimum: 1 }),
  toSequence: Type.Integer({ minimum: 1 }),
  summary: Type.String(),
  createdAt: Timestamp,
});
export type MemoryRollup = Static<typeof MemoryRollupSchema>;

export const KnowledgeSourceSchema = Strict({
  id: Id,
  name: Type.String({ minLength: 1 }),
  path: Type.String({ minLength: 1 }),
  documentCount: Type.Integer({ minimum: 0 }),
  status: Type.Union([
    Type.Literal("queued"),
    Type.Literal("parsing"),
    Type.Literal("indexed"),
    Type.Literal("failed"),
  ]),
  error: Type.Optional(Type.String()),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type KnowledgeSource = Static<typeof KnowledgeSourceSchema>;

export const KnowledgeSearchHitSchema = Strict({
  sourceId: Id,
  sourceName: Type.String({ minLength: 1 }),
  filePath: Type.String({ minLength: 1 }),
  content: Type.String(),
});
export type KnowledgeSearchHit = Static<typeof KnowledgeSearchHitSchema>;

export const SearchCitationSchema = Strict({
  title: Type.String({ minLength: 1 }),
  url: Type.String({ minLength: 1 }),
  snippet: Type.String(),
  source: Type.Union([Type.Literal("tavily"), Type.Literal("stackexchange")]),
});
export type SearchCitation = Static<typeof SearchCitationSchema>;
