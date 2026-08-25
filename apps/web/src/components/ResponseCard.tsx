import type { Response, ResponseStatus, Run, TranscriptItem } from "@uma-agent/protocol";
import { Bot, Check, ChevronRight, Copy, Download, FileText, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { Markdown } from "../Markdown.js";

export const responseStatusLabels: Record<ResponseStatus, string> = {
  queued: "正在回复",
  thinking: "正在分析",
  clarifying: "等待补充信息",
  planning: "正在制定计划",
  awaiting_confirmation: "等待确认执行计划",
  executing: "正在执行",
  awaiting_approval: "等待审批",
  verifying: "正在验证",
  completed: "已完成",
  failed: "执行失败",
  cancelled: "已取消",
};

function toolSummary(item: TranscriptItem): string {
  if (item.status === "error") return "执行失败";
  if (item.status === "streaming") return "执行中";
  return "已完成";
}

export function ResponseCard({
  response,
  run,
  items,
  onDownload,
  onConfirm,
  onReview,
  onImprove,
}: {
  response: Response;
  run: Run | undefined;
  items: TranscriptItem[];
  onDownload: (id: string) => void;
  onConfirm?: () => void;
  onReview?: (messageId: string) => void;
  onImprove?: (messageId: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const assistantItems = items.filter((item) => item.role === "assistant");
  const finalAssistant = assistantItems.at(-1);
  const finalContent = response.content || finalAssistant?.content || "";
  const intermediateItems = items
    .filter((item) => item.role !== "user" && item.id !== finalAssistant?.id)
    .sort((a, b) => a.sequence - b.sequence);
  const hasSteps = Boolean(run?.plan.length || intermediateItems.length);
  const terminal = (["completed", "failed", "cancelled"] as ResponseStatus[]).includes(response.status);
  const copy = async () => {
    await navigator.clipboard?.writeText(finalContent);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };
  const updatedAt = response.updatedAt || response.createdAt;

  return (
    <article className="message-row message-row--assistant response-card" aria-live="polite">
      <div className="message-avatar" aria-hidden="true">
        <Bot size={16} />
      </div>
      <div className="message-content">
        <div className="message-meta">
          <strong>UmaAgent</strong>
          <time dateTime={new Date(updatedAt).toISOString()}>
            {new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </time>
          {!terminal && <LoaderCircle size={14} className="spin" aria-hidden="true" />}
          <span className={response.status === "failed" ? "message-status error-text" : "streaming"}>
            {responseStatusLabels[response.status]}
          </span>
          {response.status === "awaiting_confirmation" && onConfirm && (
            <button type="button" className="primary compact" onClick={onConfirm}>
              确认执行
            </button>
          )}
        </div>

        <div className="message-body assistant-body response-card__content">
          {finalContent ? (
            <Markdown content={finalContent} />
          ) : (
            <span className="response-card__placeholder">正在准备回复…</span>
          )}
        </div>

        {hasSteps && (
          <details className="response-steps">
            <summary>
              <ChevronRight size={14} aria-hidden="true" />
              <span>执行步骤</span>
              <small>{intermediateItems.length + (run?.plan.length ?? 0)} 项</small>
            </summary>
            <div className="response-steps__body">
              {run?.plan.length ? (
                <ol className="response-plan">
                  {run.plan
                    .slice()
                    .sort((a, b) => a.position - b.position)
                    .map((step) => (
                      <li key={step.id} data-status={step.status}>
                        <span className="response-plan__marker">
                          {step.status === "completed" ? <Check size={13} /> : <span className="step-dot" />}
                        </span>
                        <span>{step.title}</span>
                      </li>
                    ))}
                </ol>
              ) : null}
              {intermediateItems.map((item) =>
                item.role === "tool" ? (
                  <details className="tool-details response-step" key={item.id}>
                    <summary>
                      <ChevronRight size={14} aria-hidden="true" />
                      <strong>{item.name ?? "工具"}</strong>
                      <span>{toolSummary(item)}</span>
                      <small>{item.content.length.toLocaleString()} 字符</small>
                    </summary>
                    <pre>{item.content}</pre>
                  </details>
                ) : (
                  <details className="response-step response-step--assistant" key={item.id}>
                    <summary>
                      <ChevronRight size={14} aria-hidden="true" />
                      <span>阶段回复</span>
                    </summary>
                    <Markdown content={item.content} />
                  </details>
                ),
              )}
            </div>
          </details>
        )}

        <div className="message-actions response-card__actions">
          <button type="button" className="text-action" onClick={() => void copy()} title="复制内容">
            {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "已复制" : "复制"}
          </button>
          {finalAssistant && onReview && (
            <button type="button" className="text-action" onClick={() => onReview(finalAssistant.id)}>
              审查
            </button>
          )}
          {finalAssistant && onImprove && (
            <button type="button" className="text-action" onClick={() => onImprove(finalAssistant.id)}>
              改进
            </button>
          )}
        </div>

        {response.attachments.length > 0 && (
          <div className="response-files">
            {response.attachments.map((attachment) => (
              <button
                type="button"
                className="response-file"
                key={attachment.id}
                onClick={() => onDownload(attachment.id)}
                title="下载文件"
              >
                <FileText size={16} aria-hidden="true" />
                <span className="response-file__name">{attachment.name}</span>
                <small className="response-file__size">
                  {Math.ceil(attachment.size / 1024).toLocaleString()} KB
                </small>
                <Download size={14} aria-hidden="true" />
              </button>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}
