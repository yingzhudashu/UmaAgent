import type { Response, ResponseStatus, Run, Session, TranscriptItem } from "@uma-agent/protocol";
import { Check, ChevronRight, Copy, Download, FileText, LoaderCircle, Wrench } from "lucide-react";
import { useState } from "react";
import defaultAvatarUrl from "../assets/cat-avatar.jpg";
import { Markdown } from "../Markdown.js";
import { responseStatusLabels } from "../statusLabels.js";
import { type QualityOperationView, QualityPanel } from "./QualityPanel.js";

function toolStatus(item: TranscriptItem): string {
  if (item.status === "error") return "执行失败";
  if (item.status === "streaming") return "执行中";
  return "已完成";
}

function toolLabel(name?: string): string {
  const labels: Record<string, string> = {
    read: "读取文件",
    write: "写入文件",
    edit: "编辑文件",
    shell: "执行命令",
    skill_read: "读取技能说明",
    http_get: "获取网页",
    search: "搜索",
    mcp_browser_open: "打开网页",
    mcp_browser_extract: "提取网页",
    mcp_browser_click: "点击网页元素",
    mcp_browser_fill: "填写网页表单",
    mcp_browser_screenshot: "网页截图",
    mcp_browser_close: "关闭网页",
  };
  return labels[name ?? ""] ?? name ?? "工具";
}

function planStepParts(title: string): { summary: string; details: string } {
  const lines = title
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const summary = lines[0] ?? title;
  const details = lines.slice(1).join("\n").trim() || title;
  return { summary, details };
}

export function ResponseCard({
  response,
  session,
  run,
  items,
  onDownload,
  onConfirm,
  onReview,
  onImprove,
  isCurrentSegment = true,
  qualityOperation,
  onQualityRetry,
}: {
  response: Response;
  session: Session | undefined;
  run: Run | undefined;
  items: TranscriptItem[];
  onDownload: (id: string) => void;
  onConfirm?: () => void;
  onReview?: (messageId: string) => void;
  onImprove?: (messageId: string) => void;
  isCurrentSegment?: boolean;
  qualityOperation?: QualityOperationView;
  onQualityRetry?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const assistantItems = items.filter((item) => item.role === "assistant");
  const finalAssistant = assistantItems.at(-1);
  const finalContent = finalAssistant?.content || response.content || "";
  const intermediateItems = items
    .filter((item) => item.role !== "user" && item.id !== finalAssistant?.id)
    .sort((a, b) => a.sequence - b.sequence);
  const planItems = (run?.plan ?? []).map((step) => ({
    kind: "plan" as const,
    id: step.id,
    sequence: step.startedAt ?? Number.MAX_SAFE_INTEGER,
    position: step.position,
    step,
  }));
  const timeline = intermediateItems
    .map((item) => ({
      kind: "transcript" as const,
      id: item.id,
      sequence: item.sequence,
      item,
    }))
    .sort((a, b) => a.sequence - b.sequence);
  const hasSteps = timeline.length > 0;
  const hasPlan = planItems.length > 0 && run?.interactionMode === "plan";
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
        <img
          src={
            session?.assistantAvatarAttachmentId
              ? `/api/v15/attachments/${encodeURIComponent(session.assistantAvatarAttachmentId)}/content`
              : defaultAvatarUrl
          }
          alt=""
        />
      </div>
      <div className="message-content">
        <div className="message-meta">
          <strong>{session?.assistantName ?? "UmaAgent"}</strong>
          <time dateTime={new Date(updatedAt).toISOString()}>
            {new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </time>
          {!terminal && isCurrentSegment && <LoaderCircle size={14} className="spin" aria-hidden="true" />}
          {isCurrentSegment && (
            <span className={response.status === "failed" ? "message-status error-text" : "streaming"}>
              {responseStatusLabels[response.status]}
            </span>
          )}
          {response.status === "awaiting_confirmation" && onConfirm && (
            <button type="button" className="primary compact" onClick={onConfirm}>
              确认执行
            </button>
          )}
        </div>

        {hasPlan && (
          <section className="response-plan-box">
            <div className="response-plan-box__heading">
              <strong>执行计划</strong>
              <small>{planItems.length} 步</small>
            </div>
            <div className="response-plan-box__body">
              {planItems
                .sort((a, b) => a.position - b.position)
                .map((entry) => (
                  <details className="response-plan-step" key={entry.id} data-status={entry.step.status}>
                    <summary>
                      <ChevronRight size={14} className="response-step-chevron" aria-hidden="true" />
                      <span className="response-plan__index">{entry.position + 1}</span>
                      <span className="response-plan__title">{planStepParts(entry.step.title).summary}</span>
                      <span className="response-step-status">
                        {entry.step.status === "completed"
                          ? "已完成"
                          : entry.step.status === "failed"
                            ? "执行失败"
                            : entry.step.status === "running"
                              ? "进行中"
                              : "待执行"}
                      </span>
                    </summary>
                    <div className="response-plan-step__body">
                      <Markdown
                        content={planStepParts(entry.step.title).details}
                        onAttachmentDownload={onDownload}
                      />
                      {entry.step.error && <p className="error-text">{entry.step.error}</p>}
                    </div>
                  </details>
                ))}
            </div>
          </section>
        )}

        {hasSteps && (
          <details className="response-steps">
            <summary>
              <ChevronRight size={14} aria-hidden="true" />
              <span>执行步骤</span>
              <small>{intermediateItems.length} 项</small>
            </summary>
            <div className="response-steps__body">
              {timeline.map((entry) =>
                entry.item.role === "tool" ? (
                  <details className="tool-details response-step" key={entry.id}>
                    <summary>
                      <ChevronRight size={14} aria-hidden="true" />
                      <Wrench size={14} aria-hidden="true" />
                      <strong>{toolLabel(entry.item.name)}</strong>
                      <span
                        className={`response-step-status ${entry.item.status === "error" ? "error-text" : ""}`}
                      >
                        {toolStatus(entry.item)}
                      </span>
                      <small>{entry.item.content.length.toLocaleString()} 字符</small>
                    </summary>
                    <pre>{entry.item.content}</pre>
                  </details>
                ) : (
                  <div className="response-step response-step--assistant" key={entry.id}>
                    <Markdown content={entry.item.content} onAttachmentDownload={onDownload} />
                  </div>
                ),
              )}
            </div>
          </details>
        )}

        <div className="message-body assistant-body response-card__content">
          {finalContent ? (
            <Markdown content={finalContent} onAttachmentDownload={onDownload} />
          ) : (
            <span className="response-card__placeholder">正在准备回复…</span>
          )}
        </div>

        <div className="message-actions response-card__actions">
          <button type="button" className="text-action" onClick={() => void copy()} title="复制内容">
            {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "已复制" : "复制"}
          </button>
          {finalAssistant && onReview && (
            <button
              type="button"
              className="text-action"
              disabled={qualityOperation?.status === "running"}
              title="只分析答案，不修改内容"
              onClick={() => onReview(finalAssistant.id)}
            >
              {qualityOperation?.status === "running" && qualityOperation.kind === "review"
                ? "审查中…"
                : "审查"}
            </button>
          )}
          {finalAssistant && onImprove && (
            <button
              type="button"
              className="text-action"
              disabled={qualityOperation?.status === "running"}
              title="根据审查建议生成新答案"
              onClick={() => onImprove(finalAssistant.id)}
            >
              {qualityOperation?.status === "running" && qualityOperation.kind === "improve"
                ? "改进中…"
                : "改进"}
            </button>
          )}
        </div>
        {qualityOperation && onQualityRetry && (
          <QualityPanel operation={qualityOperation} onRetry={onQualityRetry} />
        )}

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
