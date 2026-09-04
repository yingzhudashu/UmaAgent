import type { QualityAssessment, Run } from "@uma-agent/protocol";

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
