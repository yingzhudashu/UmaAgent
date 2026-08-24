import type { TranscriptItem } from "@uma-agent/protocol";
import { Bot, Check, ChevronRight, Copy, UserRound } from "lucide-react";
import { useState } from "react";
import { Markdown } from "../Markdown.js";

export function MessageBubble({
  item,
  onRetry,
  onAttachment,
  onReview,
  onImprove,
}: {
  item: TranscriptItem;
  onRetry: (() => void) | undefined;
  onAttachment: ((id: string) => void) | undefined;
  onReview: (() => void) | undefined;
  onImprove: (() => void) | undefined;
}) {
  const [copied, setCopied] = useState(false);
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
          {item.status === "streaming" && <span className="streaming">生成中</span>}
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
            <p>{item.content}</p>
          ) : (
            <Markdown content={item.content} />
          )}
          {item.status === "streaming" && <output className="stream-caret" aria-label="正在生成" />}
        </div>
        <div className="message-actions">
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
