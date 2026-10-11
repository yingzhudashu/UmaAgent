import Type, { type Static } from "typebox";
import { Id, Strict, Timestamp } from "./schema-helpers.js";

export const SkillSummarySchema = Strict({
  name: Id,
  description: Type.String(),
  enabled: Type.Boolean(),
  diagnostics: Type.Array(Type.String()),
  keywords: Type.Optional(Type.Array(Type.String({ maxLength: 128 }), { maxItems: 64 })),
  scope: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  userInvocable: Type.Optional(Type.Boolean()),
  modelInvocable: Type.Optional(Type.Boolean()),
});
export type SkillSummary = Static<typeof SkillSummarySchema>;

export const SkillPackageSchema = Strict({
  id: Id,
  name: Id,
  version: Type.String({ minLength: 1, maxLength: 100 }),
  source: Strict({
    type: Type.Union([Type.Literal("local"), Type.Literal("clawhub")]),
    reference: Type.String({ minLength: 1 }),
  }),
  contentHash: Type.String({ minLength: 64, maxLength: 64 }),
  status: Type.Union([
    Type.Literal("staged"),
    Type.Literal("enabled"),
    Type.Literal("disabled"),
    Type.Literal("rejected"),
  ]),
  risk: Type.Union([
    Type.Literal("low"),
    Type.Literal("medium"),
    Type.Literal("high"),
    Type.Literal("extreme"),
  ]),
  diagnostics: Type.Array(Type.String()),
  installedAt: Timestamp,
  updatedAt: Timestamp,
});
export type SkillPackage = Static<typeof SkillPackageSchema>;

export const SkillInstallRequestSchema = Strict({
  source: Type.Union([Type.Literal("local"), Type.Literal("clawhub")]),
  reference: Type.String({ minLength: 1, maxLength: 2_000 }),
  version: Type.Optional(Type.String({ maxLength: 100 })),
});
export type SkillInstallRequest = Static<typeof SkillInstallRequestSchema>;
