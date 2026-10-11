import Type, { type Static } from "typebox";
import { Id, Strict, Timestamp } from "./schema-helpers.js";

export const AgentProfileSchema = Strict({
  content: Type.String({ maxLength: 50_000 }),
  updatedAt: Timestamp,
});
export type AgentProfile = Static<typeof AgentProfileSchema>;

export const QualityIssueSchema = Strict({
  type: Type.Union([
    Type.Literal("knowledge_error"),
    Type.Literal("logic_error"),
    Type.Literal("clarity"),
    Type.Literal("omission"),
  ]),
  description: Type.String({ minLength: 1, maxLength: 2_000 }),
});
export type QualityIssue = Static<typeof QualityIssueSchema>;

export const QualityAssessmentSchema = Strict({
  id: Id,
  runId: Id,
  targetMessageId: Id,
  passed: Type.Boolean(),
  issues: Type.Array(QualityIssueSchema),
  suggestions: Type.Array(Type.String()),
  iteration: Type.Integer({ minimum: 1, maximum: 3 }),
  createdAt: Timestamp,
});
export type QualityAssessment = Static<typeof QualityAssessmentSchema>;
