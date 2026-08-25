import type { SQLInputValue, StatementSync } from "node:sqlite";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  Attachment,
  PlanStep,
  RunAction,
  RunCheckpoint,
  ScheduleDefinition,
  ScheduledTask,
  ScheduledTaskRun,
  Session,
} from "@uma-agent/protocol";

export type Row = Record<string, unknown>;

export function rows(statement: StatementSync, ...params: SQLInputValue[]): Row[] {
  return statement.all(...params) as Row[];
}

export function row(statement: StatementSync, ...params: SQLInputValue[]): Row | undefined {
  return statement.get(...params) as Row | undefined;
}

export function text(value: unknown): string {
  return String(value ?? "");
}

export function integer(value: unknown): number {
  return Number(value ?? 0);
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function ftsQuery(value: string): string | undefined {
  const terms =
    value
      .normalize("NFKC")
      .match(/[\p{L}\p{N}_]{3,}/gu)
      ?.slice(0, 12) ?? [];
  if (terms.length === 0) return undefined;
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

export function redactAudit(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/(Bearer\s+)[^\s]+/gi, "$1[REDACTED]")
      .replace(/(api[_-]?key|password|secret|token)(\s*[:=]\s*)[^\s,}]+/gi, "$1$2[REDACTED]");
  }
  if (Array.isArray(value)) return value.map(redactAudit);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) =>
        /(authorization|cookie|api[_-]?key|password|secret|token)/i.test(key)
          ? [key, "[REDACTED]"]
          : [key, redactAudit(item)],
      ),
    );
  }
  return value;
}

export function toSession(value: Row): Session {
  return {
    id: text(value.id),
    title: text(value.title),
    ...(value.workspace ? { workspace: text(value.workspace) } : {}),
    model: { provider: text(value.model_provider), id: text(value.model_id) },
    thinkingLevel: text(value.thinking_level) as ThinkingLevel,
    queueMode: text(value.queue_mode || "queue") as Session["queueMode"],
    createdAt: integer(value.created_at),
    updatedAt: integer(value.updated_at),
  };
}

export function toAttachment(value: Row): Attachment {
  return {
    id: text(value.id),
    name: text(value.name),
    mimeType: text(value.mime_type),
    size: integer(value.size),
    createdAt: integer(value.created_at),
    ...(value.owner_user_id ? { ownerUserId: text(value.owner_user_id) } : {}),
    ...(value.response_id ? { responseId: text(value.response_id) } : {}),
    ...(value.sha256 ? { sha256: text(value.sha256) } : {}),
    ...(value.status ? { status: text(value.status) as NonNullable<Attachment["status"]> } : {}),
    ...(value.expires_at ? { expiresAt: integer(value.expires_at) } : {}),
  };
}

export function attachmentIdsFrom(value: Row): string[] {
  return parseJson<string[]>(value.attachment_ids_json, []);
}

export function toScheduledTask(value: Row): ScheduledTask {
  return {
    id: text(value.id),
    name: text(value.name),
    prompt: text(value.prompt),
    messageMode: "agent",
    schedule: parseJson(value.schedule_json, { kind: "once", at: 0 }) as ScheduleDefinition,
    enabled: integer(value.enabled) === 1,
    ...(value.next_run_at !== null && value.next_run_at !== undefined
      ? { nextRunAt: integer(value.next_run_at) }
      : {}),
    ...(value.last_run_at !== null && value.last_run_at !== undefined
      ? { lastRunAt: integer(value.last_run_at) }
      : {}),
    createdAt: integer(value.created_at),
    updatedAt: integer(value.updated_at),
  };
}

export function toScheduledTaskRun(value: Row): ScheduledTaskRun {
  const resume = value.resume_json
    ? parseJson<ScheduledTaskRun["resume"] | undefined>(value.resume_json, undefined)
    : undefined;
  return {
    id: text(value.id),
    scheduledTaskId: text(value.scheduled_task_id),
    trigger: text(value.trigger) as ScheduledTaskRun["trigger"],
    ...(value.background_task_id ? { backgroundTaskId: text(value.background_task_id) } : {}),
    ...(value.run_id ? { runId: text(value.run_id) } : {}),
    status: text(value.status) as ScheduledTaskRun["status"],
    ...(resume ? { resume } : {}),
    scheduledFor: integer(value.scheduled_for),
    ...(value.started_at ? { startedAt: integer(value.started_at) } : {}),
    ...(value.completed_at ? { completedAt: integer(value.completed_at) } : {}),
    ...(value.error ? { error: text(value.error) } : {}),
  };
}

export function toPlanStep(value: Row): PlanStep {
  return {
    id: text(value.id),
    position: integer(value.position),
    title: text(value.title),
    status: text(value.status) as PlanStep["status"],
    ...(value.started_at ? { startedAt: integer(value.started_at) } : {}),
    ...(value.completed_at ? { completedAt: integer(value.completed_at) } : {}),
    ...(value.error ? { error: text(value.error) } : {}),
  };
}

export function toRunAction(value: Row): RunAction {
  return {
    id: text(value.id),
    runId: text(value.run_id),
    ...(value.checkpoint_id ? { checkpointId: text(value.checkpoint_id) } : {}),
    toolCallId: text(value.tool_call_id),
    toolName: text(value.tool_name),
    toolClass: text(value.tool_class),
    idempotencyKey: text(value.idempotency_key),
    ...(value.input_json ? { input: redactAudit(parseJson(value.input_json, null)) } : {}),
    ...(value.result_json ? { result: redactAudit(parseJson(value.result_json, null)) } : {}),
    status: text(value.status) as RunAction["status"],
    ...(value.started_at ? { startedAt: integer(value.started_at) } : {}),
    ...(value.completed_at ? { completedAt: integer(value.completed_at) } : {}),
    ...(value.error ? { error: text(value.error) } : {}),
  };
}

export function toRunCheckpoint(value: Row): RunCheckpoint {
  return {
    id: text(value.id),
    runId: text(value.run_id),
    checkpointNo: integer(value.checkpoint_no),
    phase: text(value.phase) as RunCheckpoint["phase"],
    ...(value.plan_step_id ? { planStepId: text(value.plan_step_id) } : {}),
    turnCount: integer(value.turn_count),
    lastMessageSequence: integer(value.last_message_sequence),
    ...(value.context_summary_sequence
      ? { contextSummarySequence: integer(value.context_summary_sequence) }
      : {}),
    safeToResume: integer(value.safe_to_resume) === 1,
    createdAt: integer(value.created_at),
  };
}
