import type { TranscriptItem } from "@uma-agent/protocol";
import { Bot, Check, ChevronRight, Copy, Pencil, UserRound, X } from "lucide-react";
import { useState } from "react";
import { Markdown } from "../Markdown.js";
import { type QualityOperationView, QualityPanel } from "./QualityPanel.js";

export function MessageBubble({
  item,
  onRetry,
  onAttachment,
  onReview,
  onImprove,
  onEdit,
  qualityOperation,
  onQualityRetry,
}: {
  item: TranscriptItem;
  onRetry: (() => void) | undefined;
  onAttachment: ((id: string) => void) | undefined;
  onReview: (() => void) | undefined;
  onImprove: (() => void) | undefined;
  onEdit: ((text: string) => Promise<void>) | undefined;
  qualityOperation?: QualityOperationView;
  onQualityRetry?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.content);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string>();
  const isUser = item.role === "user";
  const isTool = item.role === "tool";
  const toolSummary =
    item.status === "error" ? "执行失败" : item.status === "streaming" ? "执行中" : "已完成";
  const copy = async () => {
    await navigator.clipboard?.writeText(item.content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };
  return (
    <article className={`message-row message-row--${item.role}`}>
      <div className="message-avatar" aria-hidden="true">
        {isUser ? <UserRound size={16} /> : <Bot size={16} />}
      </div>
      <div className="message-content">
        <div className="message-meta">
          <strong>{isUser ? "你" : isTool ? (item.name ?? "工具") : "UmaAgent"}</strong>
          <time dateTime={new Date(item.createdAt).toISOString()}>
            {new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </time>
          {item.status === "streaming" && <span className="streaming">正在生成</span>}
          {item.status === "error" && <span className="message-status error-text">失败</span>}
        </div>
        <div className={`message-body ${isUser ? "user-bubble" : isTool ? "tool-output" : "assistant-body"}`}>
          {isTool ? (
            <details className="tool-details">
              <summary>
                <ChevronRight size={14} aria-hidden="true" />
                <span>{toolSummary}</span>
                <small>{item.content.length.toLocaleString()} 字符</small>
              </summary>
              <pre>{item.content}</pre>
            </details>
          ) : isUser ? (
            editing ? (
              <div className="message-editor">
                <small>编辑后会从此消息创建新分支并重新运行。</small>
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  rows={5}
                  disabled={saving}
                />
                {editError && <p className="error-text">{editError}</p>}
              </div>
            ) : (
              <p>{item.content}</p>
            )
          ) : (
            <Markdown
              content={item.content}
              {...(onAttachment ? { onAttachmentDownload: onAttachment } : {})}
            />
          )}
          {item.status === "streaming" && <output className="stream-caret" aria-label="正在生成" />}
        </div>
        <div className="message-actions">
          {isUser && !editing && (
            <button type="button" className="text-action" onClick={() => void copy()} title="复制内容">
              {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "已复制" : "复制"}
            </button>
          )}
          {!isUser && (
            <button type="button" className="text-action" onClick={() => void copy()} title="复制内容">
              {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "已复制" : "复制"}
            </button>
          )}
          {item.status === "error" && onRetry && (
            <button type="button" className="text-action" onClick={onRetry}>
              重试
            </button>
          )}
          {isUser && onEdit && !editing && item.status === "complete" && (
            <button
              type="button"
              className="text-action"
              onClick={() => {
                setDraft(item.content);
                setEditing(true);
              }}
            >
              <Pencil size={13} /> 编辑
            </button>
          )}
          {isUser && editing && onEdit && (
            <>
              <button
                type="button"
                className="text-action"
                onClick={() => {
                  setSaving(true);
                  setEditError(undefined);
                  void onEdit(draft)
                    .then(() => setEditing(false))
                    .catch((error: unknown) =>
                      setEditError(error instanceof Error ? error.message : "保存并重跑失败"),
                    )
                    .finally(() => setSaving(false));
                }}
                disabled={!draft.trim() || saving}
              >
                <Check size={13} /> {saving ? "正在重跑…" : "保存并重跑"}
              </button>
              <button
                type="button"
                className="text-action"
                onClick={() => setEditing(false)}
                disabled={saving}
              >
                <X size={13} /> 取消
              </button>
            </>
          )}
          {!isUser && !isTool && onReview && (
            <button type="button" className="text-action" onClick={onReview}>
              审查
            </button>
          )}
          {!isUser && !isTool && onImprove && (
            <button type="button" className="text-action" onClick={onImprove}>
              改进
            </button>
          )}
          {!isUser && !isTool && qualityOperation && onQualityRetry && (
            <QualityPanel operation={qualityOperation} onRetry={onQualityRetry} />
          )}
          {item.attachments.map((attachment) => (
            <button
              type="button"
              className="attachment-chip"
              key={attachment.id}
              onClick={() => onAttachment?.(attachment.id)}
            >
              {attachment.name}
            </button>
          ))}
        </div>
      </div>
    </article>
  );
}
