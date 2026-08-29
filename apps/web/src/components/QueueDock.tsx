import type { Run, SessionSnapshot, TranscriptItem } from "@uma-agent/protocol";
import { ArrowDown, ArrowUp, Check, ChevronsUp, GripVertical, Pencil, Trash2, X } from "lucide-react";
import { useState } from "react";

type QueueItem = SessionSnapshot["queue"][number];
type ActiveRun = Run | undefined;

const activeStatuses = new Set<Run["status"]>(["preflight", "running", "verifying"]);

function preview(message: TranscriptItem): string {
  return message.content.replace(/\s+/g, " ").trim() || "（无文字消息）";
}

function runLabel(run: Run): string {
  if (run.status === "preflight") return "准备中";
  if (run.status === "running") return "执行中";
  if (run.status === "verifying") return "校验中";
  return run.interactionMode === "plan" ? "计划" : "Agent";
}

function queueItemMeta(run: Run): string {
  return `${run.interactionMode === "plan" ? "计划" : "Agent"} · ${
    run.status === "queued" ? "等待处理" : runLabel(run)
  }`;
}

export function QueueDock({
  running,
  runningMessage,
  queue,
  disabled,
  reorder,
  prioritize,
  cancel,
  edit,
}: {
  running: ActiveRun;
  runningMessage?: TranscriptItem | undefined;
  queue: readonly QueueItem[];
  disabled: boolean;
  reorder: (runIds: string[]) => Promise<void>;
  prioritize: (runId: string) => Promise<void>;
  cancel: (runId: string) => Promise<void>;
  edit: (item: QueueItem, text: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [draggedId, setDraggedId] = useState<string>();
  const [editingId, setEditingId] = useState<string>();
  const [draft, setDraft] = useState("");
  const [pendingAction, setPendingAction] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const hasRunning = Boolean(running && activeStatuses.has(running.status));
  if (!hasRunning && queue.length === 0) return null;

  const perform = async (key: string, operation: () => Promise<void>) => {
    setPendingAction(key);
    setActionError(undefined);
    try {
      await operation();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "队列操作未完成");
    } finally {
      setPendingAction(undefined);
    }
  };
  const move = (index: number, offset: -1 | 1) => {
    const nextIndex = index + offset;
    if (nextIndex < 0 || nextIndex >= queue.length) return;
    const ids = queue.map((item) => item.run.id);
    [ids[index], ids[nextIndex]] = [ids[nextIndex] as string, ids[index] as string];
    void perform(`move:${ids[nextIndex]}`, () => reorder(ids));
  };
  const drop = (targetId: string) => {
    if (!draggedId || draggedId === targetId) return;
    const ids = queue.map((item) => item.run.id);
    const from = ids.indexOf(draggedId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, draggedId);
    void perform("reorder", () => reorder(ids));
    setDraggedId(undefined);
  };

  return (
    <section className={`queue-dock ${open ? "queue-dock--open" : ""}`} aria-label="消息队列">
      <button
        type="button"
        className="queue-dock__summary"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`queue-dock__indicator ${hasRunning ? "running" : ""}`} />
        <strong>{hasRunning ? `${runLabel(running as Run)}` : "等待执行"}</strong>
        <span className="queue-dock__count">{queue.length ? `${queue.length} 条待处理` : "队列为空"}</span>
        <span className="queue-dock__toggle">{open ? "收起" : "查看队列"}</span>
      </button>
      {open && (
        <div className="queue-dock__panel">
          <div className="queue-dock__header">
            <div>
              <strong>待处理消息</strong>
              <span>按顺序执行，运行中的内容不会被重新排列</span>
            </div>
            <button
              type="button"
              className="icon"
              onClick={() => setOpen(false)}
              title="收起队列"
              aria-label="收起队列"
            >
              <X size={16} />
            </button>
          </div>
          {actionError && (
            <p className="queue-dock__error" role="alert">
              {actionError}
            </p>
          )}
          {hasRunning && running && (
            <div className="queue-dock__running">
              <span className="queue-dock__running-indicator" />
              <div className="queue-dock__message">
                <strong>当前运行</strong>
                <span title={runningMessage?.content}>
                  {runningMessage ? preview(runningMessage) : "正在处理消息"}
                </span>
                <small>{queueItemMeta(running)}</small>
              </div>
            </div>
          )}
          {queue.length === 0 ? (
            <p className="queue-dock__empty">当前没有待处理消息。</p>
          ) : (
            <ul className="queue-dock__list">
              {queue.map((item, index) => {
                const editing = editingId === item.run.id;
                const busy = pendingAction !== undefined;
                return (
                  <li
                    className={`queue-dock__item ${draggedId === item.run.id ? "is-dragged" : ""}`}
                    key={item.run.id}
                    draggable={!disabled && !editing}
                    onDragStart={() => setDraggedId(item.run.id)}
                    onDragEnd={() => setDraggedId(undefined)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => drop(item.run.id)}
                  >
                    <span className="queue-dock__position">{item.position}</span>
                    <GripVertical className="queue-dock__handle" size={16} aria-hidden="true" />
                    {editing ? (
                      <input
                        className="queue-dock__editor"
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") setEditingId(undefined);
                          if (event.key === "Enter" && draft.trim()) {
                            void perform(`edit:${item.run.id}`, async () => {
                              await edit(item, draft.trim());
                              setEditingId(undefined);
                            });
                          }
                        }}
                      />
                    ) : (
                      <div className="queue-dock__message">
                        <span title={item.message.content}>{preview(item.message)}</span>
                        <small>{queueItemMeta(item.run)}</small>
                      </div>
                    )}
                    <div className="queue-dock__actions">
                      {editing ? (
                        <>
                          <button
                            type="button"
                            className="icon"
                            title="保存编辑"
                            aria-label="保存编辑"
                            disabled={busy || !draft.trim()}
                            onClick={() =>
                              void perform(`edit:${item.run.id}`, async () => {
                                await edit(item, draft.trim());
                                setEditingId(undefined);
                              })
                            }
                          >
                            <Check size={15} />
                          </button>
                          <button
                            type="button"
                            className="icon"
                            title="取消编辑"
                            aria-label="取消编辑"
                            disabled={busy}
                            onClick={() => setEditingId(undefined)}
                          >
                            <X size={15} />
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="icon"
                            title="编辑消息"
                            aria-label="编辑消息"
                            disabled={disabled || busy}
                            onClick={() => {
                              setEditingId(item.run.id);
                              setDraft(item.message.content);
                            }}
                          >
                            <Pencil size={15} />
                          </button>
                          <button
                            type="button"
                            className="icon"
                            title="移至队首"
                            aria-label="移至队首"
                            disabled={disabled || busy || index === 0}
                            onClick={() =>
                              void perform(`prioritize:${item.run.id}`, () => prioritize(item.run.id))
                            }
                          >
                            <ChevronsUp size={15} />
                          </button>
                          <button
                            type="button"
                            className="icon"
                            title="上移"
                            aria-label="上移"
                            disabled={disabled || busy || index === 0}
                            onClick={() => move(index, -1)}
                          >
                            <ArrowUp size={15} />
                          </button>
                          <button
                            type="button"
                            className="icon"
                            title="下移"
                            aria-label="下移"
                            disabled={disabled || busy || index === queue.length - 1}
                            onClick={() => move(index, 1)}
                          >
                            <ArrowDown size={15} />
                          </button>
                          <button
                            type="button"
                            className="icon danger-icon"
                            title="取消消息"
                            aria-label="取消消息"
                            disabled={disabled || busy}
                            onClick={() => void perform(`cancel:${item.run.id}`, () => cancel(item.run.id))}
                          >
                            <Trash2 size={15} />
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
