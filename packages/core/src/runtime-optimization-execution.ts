import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { OptimizationApplication, OptimizationProposal } from "@uma-agent/protocol";
import type { UmaDatabase } from "./database.js";
import type { WorkspacePolicy } from "./workspace.js";

const execFileAsync = promisify(execFile);
const VALIDATION_COMMANDS = ["test", "check", "build", "test:eval:faux", "test:perf"] as const;
type ValidationCommand = (typeof VALIDATION_COMMANDS)[number];

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
  validationCommand: ValidationCommand;
  reason?: string;
}
export interface OptimizationApplyResult extends OptimizationPreview {
  applied: boolean;
  application?: OptimizationApplication;
}

function isValidationCommand(value: string): value is ValidationCommand {
  return (VALIDATION_COMMANDS as readonly string[]).includes(value);
}

/** 优化写入按备份、原子替换、固定验证、失败回滚顺序执行，禁止任意 shell 输入。 */
export class RuntimeOptimizationExecutionService {
  constructor(
    private readonly database: UmaDatabase,
    private readonly workspacePolicy: WorkspacePolicy,
  ) {}

  async preview(
    proposalId: string,
    workspace: string,
    changes: OptimizationFileChange[],
    validationCommand: string,
    approved = false,
  ): Promise<OptimizationPreview> {
    if (!isValidationCommand(validationCommand))
      throw new Error("Unsupported optimization validation command");
    const proposal = this.database.getOptimizationProposal(proposalId);
    const root = await this.workspacePolicy.validateWorkspace(workspace);
    const files = changes.map((change) => ({
      path: change.path,
      bytes: Buffer.byteLength(change.content, "utf8"),
    }));
    const forbidden = changes.find((change) =>
      /(^|[/\\])\.git([/\\]|$)|\b(git\s+(commit|push)|rm\s+-rf|del\s+\/s)\b/i.test(change.path),
    );
    const writable = proposal.status === "accepted" && approved && !forbidden && changes.length > 0;
    return {
      proposal,
      workspace: root,
      files,
      approved,
      writable,
      validationCommand,
      ...(!writable
        ? {
            reason:
              proposal.status !== "accepted"
                ? "Optimization proposal must be accepted first"
                : forbidden
                  ? "Git metadata and destructive command paths are forbidden"
                  : changes.length === 0
                    ? "At least one file change is required"
                    : "Explicit Action approval is required",
          }
        : {}),
    };
  }

  async apply(
    proposalId: string,
    workspace: string,
    changes: OptimizationFileChange[],
    validationCommand: string,
    approved = false,
  ): Promise<OptimizationApplyResult> {
    const preview = await this.preview(proposalId, workspace, changes, validationCommand, approved);
    if (!preview.writable) return { ...preview, applied: false };
    const applicationId = randomUUID();
    const backupRoot = join(this.database.stateDir, "optimization-backups", applicationId);
    const backups: Array<{ path: string; existed: boolean; backupPath?: string }> = [];
    try {
      await mkdir(backupRoot, { recursive: true });
      for (const change of changes) {
        const target = await this.workspacePolicy.resolvePath(preview.workspace, change.path, true);
        let existed = true;
        try {
          await access(target);
        } catch {
          existed = false;
        }
        const backupPath = join(backupRoot, `${backups.length}.bak`);
        if (existed) await copyFile(target, backupPath);
        backups.push({ path: change.path, existed, ...(existed ? { backupPath } : {}) });
        await mkdir(dirname(target), { recursive: true });
        const temporary = `${target}.uma-${applicationId}.tmp`;
        await writeFile(temporary, change.content, "utf8");
        await rename(temporary, target);
      }
      const validation = await this.runValidation(preview.workspace, validationCommand as ValidationCommand);
      const application = this.database.addOptimizationApplication({
        proposalId,
        workspace: preview.workspace,
        changes: preview.files,
        backups: backups.map(({ path, existed }) => ({ path, existed })),
        validationCommand,
        validationStatus: "passed",
        validationOutput: validation.output.slice(0, 4_000),
        status: "applied",
        rollbackStatus: "not_requested",
        completedAt: Date.now(),
      });
      return { ...preview, applied: true, application };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let rollbackError: string | undefined;
      try {
        // 回滚按反向写入顺序执行，避免部分写入失败时覆盖尚未恢复的文件；不改变持久化清单顺序。
        for (const backup of [...backups].reverse()) {
          const target = await this.workspacePolicy.resolvePath(preview.workspace, backup.path, true);
          if (backup.existed && backup.backupPath) {
            await mkdir(dirname(target), { recursive: true });
            await copyFile(backup.backupPath, target);
          } else await rm(target, { force: true });
        }
      } catch (rollback) {
        rollbackError = rollback instanceof Error ? rollback.message : String(rollback);
      }
      const application = this.database.addOptimizationApplication({
        proposalId,
        workspace: preview.workspace,
        changes: preview.files,
        backups: backups.map(({ path, existed }) => ({ path, existed })),
        validationCommand,
        validationStatus: "failed",
        validationOutput: message.slice(0, 4_000),
        status: rollbackError ? "failed" : "rolled_back",
        rollbackStatus: rollbackError ? "failed" : "completed",
        error: (rollbackError ? `${message}; rollback: ${rollbackError}` : message).slice(0, 2_000),
        completedAt: Date.now(),
      });
      throw Object.assign(
        new Error(rollbackError ? `${message}; rollback failed: ${rollbackError}` : message),
        { application },
      );
    }
  }

  list(limit = 100): OptimizationApplication[] {
    return this.database.listOptimizationApplications(limit);
  }

  async rollback(
    applicationId: string,
  ): Promise<{ application: OptimizationApplication; rolledBack: boolean }> {
    const application = this.database.getOptimizationApplication(applicationId);
    if (application.status !== "applied") return { application, rolledBack: false };
    const backupRoot = join(this.database.stateDir, "optimization-backups", applicationId);
    try {
      for (let index = application.backups.length - 1; index >= 0; index--) {
        const backup = application.backups[index];
        if (!backup) continue;
        const target = await this.workspacePolicy.resolvePath(application.workspace, backup.path, true);
        if (backup.existed) await copyFile(join(backupRoot, `${index}.bak`), target);
        else await rm(target, { force: true });
      }
      const updated = this.database.updateOptimizationApplication(applicationId, {
        status: "rolled_back",
        rollbackStatus: "completed",
        completedAt: Date.now(),
      });
      await rm(backupRoot, { recursive: true, force: true });
      return { application: updated, rolledBack: true };
    } catch (error) {
      const updated = this.database.updateOptimizationApplication(applicationId, {
        rollbackStatus: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return { application: updated, rolledBack: false };
    }
  }

  private async runValidation(workspace: string, command: ValidationCommand): Promise<{ output: string }> {
    const npmCli =
      process.platform === "win32"
        ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
        : undefined;
    const executable = npmCli && (await this.fileExists(npmCli)) ? process.execPath : "npm";
    const args = npmCli && executable === process.execPath ? [npmCli, "run", command] : ["run", command];
    const result = await execFileAsync(executable, args, {
      cwd: workspace,
      shell: false,
      timeout: 15 * 60_000,
      maxBuffer: 2_000_000,
    });
    return { output: `${result.stdout}\n${result.stderr}` };
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }
}
