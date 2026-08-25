import type { Response, ResponseStatus } from "@uma-agent/protocol";
import { Download, FileText, LoaderCircle } from "lucide-react";

const labels: Record<ResponseStatus, string> = {
  queued: "已排队",
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

export function ResponseCard({
  response,
  onDownload,
  onConfirm,
}: {
  response: Response;
  onDownload: (id: string) => void;
  onConfirm?: () => void;
}) {
  return (
    <article className="response-card" aria-live="polite">
      <div className="response-card__status">
        {!["completed", "failed", "cancelled"].includes(response.status) && (
          <LoaderCircle size={15} className="spin" aria-hidden="true" />
        )}
        <strong>{labels[response.status]}</strong>
        {response.status === "awaiting_confirmation" && onConfirm && (
          <button type="button" className="primary compact" onClick={onConfirm}>
            确认执行
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
    </article>
  );
}
