import type { BackgroundTask } from "@uma-agent/protocol";
import { ExternalLink, Plus, Trash2, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { displayStatus, taskStatusLabels } from "../statusLabels.js";

export function BackgroundTaskArea({
  tasks,
  disabled,
  create,
  cancel,
  remove,
  openRun,
}: {
  tasks: BackgroundTask[];
  disabled: boolean;
  create: (prompt: string) => void;
  cancel: (id: string) => void;
  remove: (id: string) => void;
  openRun: (task: BackgroundTask) => void;
}) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = prompt.trim();
    if (!value) return;
    create(value);
    setPrompt("");
    setOpen(false);
  };
  return (
    <section className="settings-section settings-section--operation">
      <div className="settings-section-heading">
        <div>
          <h3>后台任务</h3>
          <p>在当前会话的后台队列中处理非即时工作。</p>
        </div>
      </div>
      <details
        className="settings-disclosure"
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary>
          <Plus size={14} aria-hidden="true" /> 新建后台任务
        </summary>
        <form className="settings-form settings-form--compact" onSubmit={submit}>
          <label htmlFor="background-task-prompt">任务内容</label>
          <textarea
            id="background-task-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={3}
            placeholder="描述需要在后台完成的工作"
          />
          <div className="settings-form-actions">
            <span className="settings-help">任务会在当前会话的后台队列中执行。</span>
            <button type="submit" className="primary settings-primary" disabled={disabled || !prompt.trim()}>
              创建任务
            </button>
          </div>
        </form>
      </details>
      {tasks.length === 0 ? (
        <p className="settings-empty">暂无后台任务。</p>
      ) : (
        <div className="settings-list settings-list--operation">
          {tasks.map((task) => {
            const active = task.status === "pending" || task.status === "running";
            return (
              <article className="settings-record" key={task.id}>
                <div className="settings-record__heading">
                  <strong>{taskStatusLabels[task.status] ?? displayStatus(task.status)}</strong>
                  <small>{new Date(task.updatedAt).toLocaleString()}</small>
                </div>
                <p className="settings-record__content">{task.prompt}</p>
                {task.error && <p className="settings-record__error">{task.error}</p>}
                <div className="settings-record__actions">
                  {task.runId && (
                    <button
                      type="button"
                      className="settings-icon-button"
                      title="打开运行"
                      aria-label="打开运行"
                      onClick={() => openRun(task)}
                    >
                      <ExternalLink size={14} aria-hidden="true" />
                    </button>
                  )}
                  {active ? (
                    <button
                      type="button"
                      className="settings-icon-button"
                      title="取消任务"
                      aria-label="取消任务"
                      disabled={disabled}
                      onClick={() => cancel(task.id)}
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="settings-icon-button"
                      title="删除记录"
                      aria-label="删除记录"
                      disabled={disabled}
                      onClick={() => remove(task.id)}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
