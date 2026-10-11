import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { TranscriptItem } from "@uma-agent/protocol";
import type { UmaDatabase } from "./database.js";
import type { EventHub } from "./events.js";
import type { PermissionPolicy } from "./permissions.js";
import { injectRuntimeFault, textFromMessage } from "./runtime-support.js";
import type { ToolLoopGuard } from "./tool-loop-guard.js";
import type { TraceContext } from "./trace.js";

export type AgentEventBindingContext = {
  database: UmaDatabase;
  events: EventHub;
  permissions: PermissionPolicy;
  activeTraces: Map<string, TraceContext>;
};

export function bindAgentEvents(
  context: AgentEventBindingContext,
  agent: Agent,
  sessionId: string,
  runId: string,
  parentMessageId: string,
  turnCount: () => number = () => 0,
  loopGuard?: ToolLoopGuard,
): void {
  let assistantItem: TranscriptItem | undefined, pendingAssistant: AssistantMessage | undefined;
  let flushTimer: NodeJS.Timeout | undefined;
  let streamedLength = 0;
  const toolMessages = new Map<string, string>();
  const toolActions = new Map<string, string>();
  let activeModelCall: { id: string; startedAt: number } | undefined;
  let activeModelTrace: TraceContext | undefined;
  const toolTraces = new Map<string, TraceContext>();
  const rootTrace = context.activeTraces.get(runId);
  const responseId = context.database.responseForRun(runId)?.id;
  // Run 的模型快照在创建时固定；按模型事件反复读取并解码完整 Run 没有新信息。
  const run = context.database.getRun(runId);
  const modelRef = run.model.ref;
  const flushAssistant = () => {
    if (!assistantItem || !pendingAssistant) return;
    const message = pendingAssistant;
    const content = textFromMessage(message);
    const append = content.slice(streamedLength);
    const offset = streamedLength;
    streamedLength = content.length;
    pendingAssistant = undefined;
    flushTimer = undefined;
    if (!append) return;
    context.events.emitTransientDelta(sessionId, runId, {
      messageId: assistantItem.id,
      ...(responseId ? { responseId } : {}),
      append,
      offset,
      updatedAt: Date.now(),
    });
  };
  agent.subscribe((event: AgentEvent) => {
    if (event.type === "turn_start") {
      activeModelCall = {
        id: context.database.startModelCall({
          runId,
          provider: modelRef.provider,
          model: modelRef.id,
          role: "default",
        }),
        startedAt: Date.now(),
      };
      activeModelTrace = rootTrace?.child("model", "model", {
        provider: modelRef.provider,
        model: modelRef.id,
      });
      injectRuntimeFault("model.started");
    } else if (event.type === "message_start" && event.message.role === "assistant") {
      assistantItem = context.events.transaction(() => {
        const item = context.database.insertMessage({
          sessionId,
          runId,
          role: "assistant",
          status: "streaming",
          content: textFromMessage(event.message),
          // 每个模型回复都直接指向本次用户消息，质量操作和上下文构建据此找到问题。
          parentMessageId: parentMessageId || run.messageId,
        });
        streamedLength = item.content.length;
        context.events.emit(sessionId, runId, "message.started", item);
        if (responseId) {
          const activity = context.database.addResponseActivity({
            responseId,
            kind: "status",
            status: "thinking",
            text: "正在生成回复",
          });
          context.events.emit(sessionId, runId, "response.activity", { responseId, activity });
        }
        return item;
      });
    } else if (event.type === "message_update" && event.message.role === "assistant" && assistantItem) {
      pendingAssistant = event.message;
      assistantItem = {
        ...assistantItem,
        content: textFromMessage(event.message),
        updatedAt: Date.now(),
      };
      flushTimer ??= setTimeout(flushAssistant, 250);
    } else if (event.type === "message_end" && event.message.role === "assistant" && assistantItem) {
      const message = event.message;
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = undefined;
      pendingAssistant = undefined;
      const status =
        message.stopReason === "error"
          ? "error"
          : message.stopReason === "aborted"
            ? "cancelled"
            : "complete";
      context.events.transaction(() => {
        const item = context.database.updateMessage(assistantItem?.id as string, {
          content: textFromMessage(message),
          status,
          payload: message,
        });
        if (activeModelCall)
          context.database.finishModelCall(activeModelCall.id, {
            status:
              message.stopReason === "error" || message.stopReason === "aborted" ? "failed" : "completed",
            durationMs: Date.now() - activeModelCall.startedAt,
            usage: message.usage,
            ...(message.errorMessage ? { error: message.errorMessage } : {}),
          });
        activeModelTrace?.finish({
          status: message.stopReason === "error" || message.stopReason === "aborted" ? "error" : "ok",
          ...(message.stopReason === "error" || message.stopReason === "aborted"
            ? { error: { name: "ModelError", message: message.errorMessage ?? message.stopReason } }
            : {}),
        });
        activeModelTrace = undefined;
        context.database.addAudit({
          runId,
          kind: "model",
          name: `${modelRef.provider}/${modelRef.id}`,
          output: { text: item.content },
          status: message.stopReason,
          usage: message.usage,
          ...(message.errorMessage ? { error: message.errorMessage } : {}),
        });
        context.database.createCheckpoint({
          runId,
          phase: "model",
          turnCount: turnCount(),
          lastMessageSequence: item.sequence,
          contextSummarySequence: context.database.getContextSummary(sessionId)?.throughSequence,
          safeToResume: true,
        });
        context.events.emit(sessionId, runId, "message.completed", item);
      });
      injectRuntimeFault("model.completed");
      activeModelCall = undefined;
      assistantItem = undefined;
    } else if (event.type === "tool_execution_start") {
      const toolTrace = rootTrace?.child("tool", "tool", { tool: event.toolName });
      if (toolTrace) toolTraces.set(event.toolCallId, toolTrace);
      const created = context.events.transaction(() => {
        context.database.createToolCall({
          id: event.toolCallId,
          runId,
          name: event.toolName,
          args: event.args,
        });
        const action =
          context.database.getRunActionByToolCall(runId, event.toolCallId) ??
          context.database.createRunAction({
            runId,
            checkpointId: context.database.getLatestCheckpoint(runId)?.id,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            toolClass: context.permissions.classify(event.toolName),
            idempotencyKey: `${runId}:${event.toolCallId}`,
            input: event.args,
          });
        context.database.addAudit({
          runId,
          kind: "tool",
          name: event.toolName,
          input: event.args,
          status: "started",
        });
        const item = context.database.insertMessage({
          sessionId,
          runId,
          role: "tool",
          status: "streaming",
          name: event.toolName,
          content: JSON.stringify(event.args, null, 2),
        });
        context.events.emit(sessionId, runId, "tool.started", {
          item,
          action,
          toolCallId: event.toolCallId,
          input: event.args,
        });
        if (responseId) {
          const activity = context.database.addResponseActivity({
            responseId,
            kind: "tool",
            toolName: event.toolName,
            text: "正在调用工具",
            status: "executing",
          });
          context.events.emit(sessionId, runId, "response.activity", { responseId, activity });
        }
        return { actionId: action.id, messageId: item.id };
      });
      toolActions.set(event.toolCallId, created.actionId);
      toolMessages.set(event.toolCallId, created.messageId);
    } else if (event.type === "tool_execution_end") {
      loopGuard?.recordResult(`${runId}:${event.toolCallId}`, event.result);
      const messageId = toolMessages.get(event.toolCallId);
      if (messageId) {
        const toolMessage: ToolResultMessage = {
          role: "toolResult",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          content:
            event.result && typeof event.result === "object" && "content" in event.result
              ? (event.result as ToolResultMessage).content
              : [{ type: "text", text: JSON.stringify(event.result) }],
          isError: event.isError,
          timestamp: Date.now(),
        };
        context.events.transaction(() => {
          context.database.completeToolCall(event.toolCallId, event.result, event.isError);
          const actionId = toolActions.get(event.toolCallId);
          if (actionId)
            context.database.transitionRunAction(actionId, ["running"], {
              status: event.isError ? "failed" : "completed",
              result: event.result,
            });
          context.database.addAudit({
            runId,
            kind: "tool",
            name: event.toolName,
            output: event.result,
            status: event.isError ? "error" : "completed",
          });
          const item = context.database.updateMessage(messageId, {
            content: textFromMessage(toolMessage),
            status: event.isError ? "error" : "complete",
            payload: toolMessage,
          });
          context.database.createCheckpoint({
            runId,
            phase: "tool",
            turnCount: turnCount(),
            lastMessageSequence: item.sequence,
            contextSummarySequence: context.database.getContextSummary(sessionId)?.throughSequence,
            safeToResume: !event.isError,
          });
          context.events.emit(sessionId, runId, "tool.completed", {
            item,
            messageId: item.id,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            isError: event.isError,
            ...(event.isError ? { errorCategory: "tool_execution" } : {}),
          });
          if (responseId) {
            const activity = context.database.addResponseActivity({
              responseId,
              kind: "tool",
              toolName: event.toolName,
              text: event.isError ? "工具执行失败" : "工具执行完成",
              status: event.isError ? "failed" : "completed",
            });
            context.events.emit(sessionId, runId, "response.activity", { responseId, activity });
          }
          toolTraces.get(event.toolCallId)?.finish({ status: event.isError ? "error" : "ok" });
          toolTraces.delete(event.toolCallId);
        });
        injectRuntimeFault("tool.completed");
      }
    } else if (event.type === "message_end" && event.message.role === "toolResult") {
      const messageId = toolMessages.get(event.message.toolCallId);
      if (messageId) context.database.updateMessage(messageId, { payload: event.message });
    } else if (event.type === "agent_end" && activeModelCall) {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = undefined;
      pendingAssistant = undefined;
      context.database.finishModelCall(activeModelCall.id, {
        status: "failed",
        durationMs: Date.now() - activeModelCall.startedAt,
        error: "Agent ended before the model response completed",
      });
      if (assistantItem)
        context.database.updateMessage(assistantItem.id, {
          status: "error",
          content: assistantItem.content,
        });
      activeModelCall = undefined;
      activeModelTrace?.finish({
        status: "error",
        error: { name: "AgentError", message: "Agent ended before model response" },
      });
      activeModelTrace = undefined;
      assistantItem = undefined;
    }
  });
}
