import type { Session, TranscriptItem } from "@uma-agent/protocol";
import { Check, ChevronRight, Copy, Pencil, UserRound, X } from "lucide-react";
import { useState } from "react";
import defaultAvatarUrl from "../assets/cat-avatar.png";
import { Markdown } from "../Markdown.js";
import { ActionMenu } from "./ActionMenu.js";
import { type QualityOperationView, QualityPanel } from "./QualityPanel.js";
import { useUnsavedForm } from "./UnsavedChanges.js";

export function MessageBubble({
  item,
  session,
  onRetry,
  onAttachment,
  onReview,
  onImprove,
  onEdit,
  qualityOperation,
  onQualityRetry,
}: {
  item: TranscriptItem;
  session: Session | undefined;
  onRetry: (() => void) | undefined;
  onAttachment: ((id: string) => void) | undefined;
  onReview: (() => void) | undefined;
  onImprove: (() => void) | undefined;
  onEdit: ((text: string) => Promise<void>) | undefined;
  qualityOperation?: QualityOperationView;
  onQualityRetry?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.content);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string>();
  const leave = useUnsavedForm(editing && draft !== item.content, () => {
    setDraft(item.content);
    setEditing(false);
  });
  const isUser = item.role === "user";
  const isTool = item.role === "tool";
  const toolSummary =
    item.status === "error" ? "执行失败" : item.status === "streaming" ? "执行中" : "已完成";
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(item.content);
      setCopyError("");
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopyError("复制失败，请选择正文后手动复制。");
    }
  };
  return (
    <article className={`message-row message-row--${item.role}`}>
      <div className="message-avatar" aria-hidden="true">
        {isUser ? (
          <UserRound size={16} />
        ) : (
          <img
            src={
              session?.assistantAvatarAttachmentId
                ? `/api/v16/attachments/${encodeURIComponent(session.assistantAvatarAttachmentId)}/content`
                : defaultAvatarUrl
            }
            alt=""
          />
        )}
      </div>
      <div className="message-content">
        <div className="message-meta">
          <strong>
            {isUser ? "你" : isTool ? (item.name ?? "工具") : (session?.assistantName ?? "UmaAgent")}
          </strong>
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
          {!editing && (
            <button type="button" className="text-action" onClick={() => void copy()} title="复制内容">
              {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "已复制" : "复制"}
            </button>
          )}
          {!editing &&
            ((item.status === "error" && onRetry) ||
              (isUser && onEdit && item.status === "complete") ||
              (!isUser && !isTool && (onReview || onImprove))) && (
              <ActionMenu label="消息更多操作">
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
                {!isUser && !isTool && onReview && (
                  <button
                    type="button"
                    className="text-action"
                    onClick={onReview}
                    title="只分析答案，不修改内容"
                  >
                    审查
                  </button>
                )}
                {!isUser && !isTool && onImprove && (
                  <button
                    type="button"
                    className="text-action"
                    onClick={onImprove}
                    title="根据审查建议生成新答案"
                  >
                    改进
                  </button>
                )}
              </ActionMenu>
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
                onClick={() => leave(() => setEditing(false))}
                disabled={saving}
              >
                <X size={13} /> 取消
              </button>
            </>
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
        {copyError && <output className="error-text">{copyError}</output>}
      </div>
    </article>
  );
}
