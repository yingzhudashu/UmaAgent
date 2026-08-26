import type { BackgroundTask } from "@uma-agent/protocol";
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
    <div className="settings-panel settings-panel--nested">
      <details
        className="settings-form-disclosure"
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary>新建后台任务</summary>
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
        <div className="settings-list settings-list--stacked">
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
                    <button type="button" onClick={() => openRun(task)}>
                      打开运行
                    </button>
                  )}
                  {active ? (
                    <button type="button" disabled={disabled} onClick={() => cancel(task.id)}>
                      取消
                    </button>
                  ) : (
                    <button type="button" disabled={disabled} onClick={() => remove(task.id)}>
                      删除记录
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
