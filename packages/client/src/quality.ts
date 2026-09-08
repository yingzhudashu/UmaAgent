import type { QualityAssessment, Run } from "@uma-agent/protocol";

export const qualityPath = (scope: "runs" | "messages" | "sessions", id: string) =>
  `/${scope}/${encodeURIComponent(id)}/quality`;

export interface MessageQualityHistory {
  kind: "review" | "improve";
  runId: string;
  status: Run["status"];
  resultMessageId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  assessments: QualityAssessment[];
}
