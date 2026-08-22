import { createHash } from "node:crypto";
import type {
  AgentProfile,
  BackgroundTask,
  CreateEvaluationReport,
  CreateScheduledTaskRequest,
  ModelRef,
  OptimizationProposal,
  PublicConfig,
  QualityAssessment,
  Run,
  RunAction,
  RunCheckpoint,
  Session,
  SessionEventPage,
  SessionHistoryPage,
  SessionSnapshot,
  SkillInstallRequest,
  SkillPackage,
  SkillSummary,
  TranscriptItem,
  UpdateScheduledTaskRequest,
} from "@uma-agent/protocol";
import { PROTOCOL_VERSION } from "@uma-agent/protocol";
import type { UmaDatabase } from "./database.js";
import type { EventHub, ResourceListener } from "./events.js";
import type { McpManager } from "./mcp.js";
import type { ModelRegistry } from "./models.js";
import type { RuntimeOptimizationService } from "./runtime-optimization.js";
import type { SchedulerService } from "./scheduler.js";
import type { SkillPackageService } from "./skill-packages.js";
import type { SkillRegistry } from "./skills.js";
import type { UmaConfig } from "./types.js";

type Resource = Parameters<ResourceListener>[0]["resource"];

export interface RuntimeResourceDependencies {
  database: UmaDatabase;
  events: EventHub;
  models: ModelRegistry;
  mcp: McpManager;
  scheduler: SchedulerService;
  skills: SkillRegistry;
  skillPackages: SkillPackageService;
  optimization: RuntimeOptimizationService;
  config: () => UmaConfig;
  invalidate: (resource: Resource) => void;
}

/** Read and resource mutations exposed by UmaRuntime's public facade. */
export class RuntimeResourceService {
  constructor(private readonly deps: RuntimeResourceDependencies) {}

  listSessions(): Session[] {
    return this.deps.database.listSessions();
  }

  getSnapshot(id: string): SessionSnapshot {
    return this.deps.database.getSnapshot(id);
  }

  listModels(): ModelRef[] {
    return this.deps.models.list();
  }

  listTasks(userId?: string): BackgroundTask[] {
    return this.deps.database.listBackgroundTasks(userId);
  }

  deleteTask(id: string): void {
    const task = this.deps.database.getBackgroundTask(id);
    this.deps.events.transaction(() => {
      this.deps.database.deleteBackgroundTask(id);
      this.deps.events.invalidate("tasks");
    });
    if (task.source?.scheduleRunId) this.deps.invalidate("schedules");
  }

  listEvaluationReports(limit?: number) {
    return this.deps.database.listEvaluationReports(limit);
  }

  getEvaluationReport(id: string) {
    return this.deps.database.getEvaluationReport(id);
  }

  createEvaluationReport(input: CreateEvaluationReport) {
    return this.deps.events.transaction(() => {
      const report = this.deps.database.createEvaluationReport(input);
      this.deps.events.invalidate("evaluations");
      return report;
    });
  }

  publicConfig(): PublicConfig {
    const models = this.listModels();
    const config = this.deps.config();
    const skills = this.deps.skills.list();
    const roles = config.roles;
    const mcp = this.deps.mcp.status().map((item) => ({
      name: item.name,
      connected: item.connected,
      toolCount: item.toolCount,
    }));
    return {
      revision: `${PROTOCOL_VERSION}:${createHash("sha256")
        .update(JSON.stringify({ models, roles, skills, mcp }))
        .digest("hex")
        .slice(0, 16)}`,
      defaultModel: config.defaultModel,
      roles,
      models,
      skills,
      mcp,
    };
  }

  listScheduledTasks() {
    return this.deps.scheduler.list();
  }

  createScheduledTask(input: CreateScheduledTaskRequest) {
    return this.deps.scheduler.create(input);
  }

  updateScheduledTask(id: string, input: UpdateScheduledTaskRequest) {
    return this.deps.scheduler.update(id, input);
  }

  deleteScheduledTask(id: string): void {
    this.deps.scheduler.delete(id);
  }

  runScheduledTask(id: string) {
    return this.deps.scheduler.runNow(id);
  }

  listScheduledTaskRuns(id: string) {
    return this.deps.scheduler.runs(id);
  }

  getScheduledTaskRun(id: string) {
    return this.deps.scheduler.getRun(id);
  }

  cancelScheduledTaskRun(id: string) {
    return this.deps.scheduler.cancelRun(id);
  }

  listSessionEvents(sessionId: string, afterSequence: number, limit?: number): SessionEventPage {
    return this.deps.database.listEvents(sessionId, afterSequence, limit);
  }

  listSessionHistory(sessionId: string, beforeSequence?: number, limit?: number): SessionHistoryPage {
    return this.deps.database.listHistory(sessionId, beforeSequence, limit);
  }

  getRun(runId: string): Run {
    return this.deps.database.getRun(runId);
  }

  listRunActions(runId: string): RunAction[] {
    this.deps.database.getRun(runId);
    return this.deps.database.listRunActions(runId);
  }

  listRunCheckpoints(runId: string): RunCheckpoint[] {
    return this.deps.database.listRunCheckpoints(runId);
  }

  listMemoryFacts(status?: "active" | "candidate" | "superseded" | "rejected") {
    return this.deps.database.listMemoryFacts(status);
  }

  audit(runId: string) {
    return this.deps.database.listAudit(runId);
  }

  listSkills(): SkillSummary[] {
    return this.deps.skills.list();
  }

  refreshSkills(): Promise<SkillSummary[]> {
    return this.deps.skills.refresh();
  }

  listSkillPackages(): SkillPackage[] {
    return this.deps.skillPackages.list();
  }

  searchSkills(query: string): Promise<Array<Record<string, unknown>>> {
    return this.deps.skillPackages.search(query);
  }

  installSkill(input: SkillInstallRequest): Promise<SkillPackage> {
    return this.deps.skillPackages.install(input);
  }

  setSkillStatus(id: string, status: "enabled" | "disabled" | "rejected"): Promise<SkillPackage> {
    return this.deps.skillPackages.setStatus(id, status);
  }

  getAgentProfile(): AgentProfile {
    return this.deps.database.getAgentProfile();
  }

  updateAgentProfile(content: string): AgentProfile {
    if (content.length > 50_000) throw new Error("Agent profile is too large");
    return this.deps.events.transaction(() => {
      const profile = this.deps.database.putAgentProfile(content);
      this.deps.events.invalidate("profile");
      return profile;
    });
  }

  searchHistory(sessionId: string, query: string, limit?: number): TranscriptItem[] {
    return this.deps.database.searchHistory(sessionId, query, limit);
  }

  listActivity(sessionId: string, limit?: number): Array<Record<string, unknown>> {
    return this.deps.database.listActivity(sessionId, limit);
  }

  listOptimizationProposals(): OptimizationProposal[] {
    return this.deps.optimization.list();
  }

  generateOptimizationProposals(from = 0, to = Date.now()): OptimizationProposal[] {
    return this.deps.optimization.generate(from, to);
  }

  decideOptimizationProposal(id: string, status: "accepted" | "rejected"): OptimizationProposal {
    return this.deps.optimization.decide(id, status);
  }

  listQualityAssessments(runId: string): QualityAssessment[] {
    this.deps.database.getRun(runId);
    return this.deps.database.listQualityAssessments(runId);
  }
}
