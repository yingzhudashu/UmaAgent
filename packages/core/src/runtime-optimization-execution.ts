import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { OptimizationProposal } from "@uma-agent/protocol";
import type { UmaDatabase } from "./database.js";
import type { WorkspacePolicy } from "./workspace.js";

export interface OptimizationFileChange {
  path: string;
  content: string;
}
export interface OptimizationPreview {
  proposal: OptimizationProposal;
  workspace: string;
  files: Array<{ path: string; bytes: number }>;
  approved: boolean;
  writable: boolean;
  reason?: string;
}
export interface OptimizationApplyResult extends OptimizationPreview {
  applied: boolean;
  backups: string[];
  validation: { status: "not_run" | "passed"; reason: string };
}

/** Applies only explicitly supplied, reviewed files inside an approved workspace. */
export class RuntimeOptimizationExecutionService {
  constructor(
    private readonly database: UmaDatabase,
    private readonly workspacePolicy: WorkspacePolicy,
  ) {}
  async preview(
    proposalId: string,
    workspace: string,
    changes: OptimizationFileChange[],
    approved = false,
  ): Promise<OptimizationPreview> {
    const proposal = this.database.getOptimizationProposal(proposalId);
    const root = await this.workspacePolicy.validateWorkspace(workspace);
    const files = changes.map((change) => ({
      path: change.path,
      bytes: Buffer.byteLength(change.content, "utf8"),
    }));
    const forbidden = changes.find((change) =>
      /(^|[/\\])\.git([/\\]|$)|\b(git\s+(commit|push)|rm\s+-rf|del\s+\/s)\b/i.test(change.path),
    );
    const writable = proposal.status === "accepted" && approved && !forbidden;
    return {
      proposal,
      workspace: root,
      files,
      approved,
      writable,
      ...(!writable
        ? {
            reason:
              proposal.status !== "accepted"
                ? "Optimization proposal must be accepted first"
                : forbidden
                  ? "Git metadata and destructive command paths are forbidden"
                  : "Explicit Action approval is required",
          }
        : {}),
    };
  }
  async apply(
    proposalId: string,
    workspace: string,
    changes: OptimizationFileChange[],
    approved = false,
  ): Promise<OptimizationApplyResult> {
    const preview = await this.preview(proposalId, workspace, changes, approved);
    if (!preview.writable)
      return {
        ...preview,
        applied: false,
        backups: [],
        validation: { status: "not_run", reason: preview.reason ?? "Not writable" },
      };
    const backups: string[] = [];
    for (const change of changes) {
      const target = await this.workspacePolicy.resolvePath(preview.workspace, change.path, true);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, change.content, "utf8");
      backups.push(target);
    }
    return {
      ...preview,
      applied: true,
      backups,
      validation: { status: "not_run", reason: "No validation command was supplied" },
    };
  }
}
