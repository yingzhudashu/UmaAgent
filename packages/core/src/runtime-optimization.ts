import type { OptimizationProposal } from "@uma-agent/protocol";
import type { UmaDatabase } from "./database.js";

/** Builds evidence-only proposals. It deliberately has no apply or mutation hook. */
export class RuntimeOptimizationService {
  constructor(
    private readonly database: UmaDatabase,
    private readonly invalidate: () => void,
  ) {}

  list(): OptimizationProposal[] {
    return this.database.listOptimizationProposals();
  }

  generate(from = 0, to = Date.now()): OptimizationProposal[] {
    const report = this.database.diagnosticsReport(from, to);
    const proposals: OptimizationProposal[] = [];
    for (const model of report.slowModels.filter((item) => item.averageDurationMs >= 5_000).slice(0, 3))
      proposals.push(
        this.database.addOptimizationProposal({
          title: `Investigate slow model ${model.provider}/${model.model}`,
          evidence: [`${model.calls} calls averaged ${Math.round(model.averageDurationMs)} ms`],
          risk: "low",
          recommendation:
            "Review provider latency, context size and role routing before changing configuration.",
          validation: ["Run the deterministic eval suite", "Compare p50 and p95 latency on the same sample"],
          status: "pending",
        }),
      );
    for (const tool of report.toolFailures.slice(0, 3))
      proposals.push(
        this.database.addOptimizationProposal({
          title: `Reduce failures in ${tool.tool}`,
          evidence: [
            `${tool.failures} public tool failures`,
            ...(tool.latestError ? [`Latest error: ${tool.latestError}`] : []),
          ],
          risk: "medium",
          recommendation:
            "Inspect the failing inputs and add a focused regression test before changing behavior.",
          validation: [
            "Reproduce with a sanitized fixture",
            "Confirm Action Ledger semantics remain unchanged",
          ],
          status: "pending",
        }),
      );
    if (report.recoveryFrequency > 0.05)
      proposals.push(
        this.database.addOptimizationProposal({
          title: "Review elevated recovery frequency",
          evidence: [`Recovery frequency is ${(report.recoveryFrequency * 100).toFixed(1)}%`],
          risk: "medium",
          recommendation: "Classify interruption causes and address the largest verified category first.",
          validation: ["Run crash-recovery fault matrix", "Verify uncertain side effects are never replayed"],
          status: "pending",
        }),
      );
    this.invalidate();
    return proposals;
  }

  decide(id: string, status: "accepted" | "rejected"): OptimizationProposal {
    const result = this.database.updateOptimizationProposal(id, status);
    this.invalidate();
    return result;
  }
}
