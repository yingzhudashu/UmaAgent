import type { CreateScheduledTaskRequest, ScheduledTask, ScheduledTaskRun } from "@uma-agent/protocol";
import { type FormEvent, useState } from "react";
import { displayStatus, scheduleKindLabels, scheduleRunStatusLabels } from "../statusLabels.js";

export function ScheduleArea({
  schedules,
  disabled,
  create,
  toggle,
  run,
  remove,
  loadRuns,
  cancelRun,
}: {
  schedules: ScheduledTask[];
  disabled: boolean;
  create: (input: CreateScheduledTaskRequest) => void;
  toggle: (id: string, enabled: boolean) => void;
  run: (id: string) => void;
  remove: (id: string) => void;
  loadRuns: (id: string) => Promise<ScheduledTaskRun[]>;
  cancelRun: (id: string) => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<"once" | "interval" | "cron">("interval");
  const [value, setValue] = useState("3600000");
  const [timezone, setTimezone] = useState("Asia/Shanghai");
  const [history, setHistory] = useState<Record<string, ScheduledTaskRun[]>>({});
  const submit = (event: FormEvent) => {
    event.preventDefault();
    let schedule: CreateScheduledTaskRequest["schedule"];
    if (kind === "once") schedule = { kind, at: Date.parse(value) };
    else if (kind === "interval") schedule = { kind, everyMs: Number(value) };
    else schedule = { kind, expression: value, timezone };
    create({ name: name.trim(), prompt: prompt.trim(), schedule });
    setShowForm(false);
    setName("");
    setPrompt("");
  };
  return (
    <div className="settings-panel settings-panel--nested">
      <details
        className="settings-form-disclosure"
        open={showForm}
        onToggle={(event) => setShowForm(event.currentTarget.open)}
      >
        <summary>新建调度</summary>
        <form className="settings-form settings-form--compact" onSubmit={submit}>
          <label>
            名称
            <input required value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            任务
            <textarea required value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          </label>
          <label>
            类型
            <select
              value={kind}
              onChange={(event) => {
                const next = event.target.value as typeof kind;
                setKind(next);
                setValue(
                  next === "once"
                    ? new Date(Date.now() + 60_000).toISOString()
                    : next === "cron"
                      ? "0 9 * * *"
                      : "3600000",
                );
              }}
            >
              <option value="once">一次性</option>
              <option value="interval">按间隔</option>
              <option value="cron">Cron</option>
            </select>
          </label>
          <label>
            {kind === "once" ? "ISO 时间" : kind === "cron" ? "Cron 表达式" : "间隔毫秒"}
            <input required value={value} onChange={(event) => setValue(event.target.value)} />
          </label>
          {kind === "cron" && (
            <label>
              时区
              <input required value={timezone} onChange={(event) => setTimezone(event.target.value)} />
            </label>
          )}
          <div className="approval-actions">
            <button type="button" onClick={() => setShowForm(false)}>
              取消
            </button>
            <button className="primary" type="submit" disabled={disabled}>
              创建
            </button>
          </div>
        </form>
      </details>
      {schedules.length === 0 ? (
        <p className="settings-empty">暂无调度任务。</p>
      ) : (
        <div className="settings-list settings-list--stacked">
          {schedules.map((item) => {
            const runs = history[item.id];
            return (
              <article key={item.id} className="settings-record">
                <div className="settings-record__heading">
                  <strong>{item.name}</strong>
                  <small>{item.enabled ? "已启用" : "已停用"}</small>
                </div>
                <p className="settings-record__content">{item.prompt}</p>
                <dl className="settings-record__meta">
                  <div>
                    <dt>频率</dt>
                    <dd>{scheduleKindLabels[item.schedule.kind] ?? item.schedule.kind}</dd>
                  </div>
                  <div>
                    <dt>下次运行</dt>
                    <dd>{item.nextRunAt ? new Date(item.nextRunAt).toLocaleString() : "-"}</dd>
                  </div>
                </dl>
                <div className="settings-record__actions">
                  <button type="button" disabled={disabled} onClick={() => run(item.id)}>
                    立即运行
                  </button>
                  <button type="button" disabled={disabled} onClick={() => toggle(item.id, !item.enabled)}>
                    {item.enabled ? "停用" : "启用"}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void loadRuns(item.id).then((runs) =>
                        setHistory((current) => ({ ...current, [item.id]: runs })),
                      )
                    }
                  >
                    历史
                  </button>
                  <button type="button" disabled={disabled} onClick={() => remove(item.id)}>
                    删除
                  </button>
                </div>
                {runs && (
                  <div className="settings-record__history">
                    {runs.length === 0 ? (
                      <small>暂无运行记录。</small>
                    ) : (
                      runs.map((entry) => (
                        <div key={entry.id}>
                          <small>
                            {entry.trigger} ·{" "}
                            {scheduleRunStatusLabels[entry.status] ?? displayStatus(entry.status)} ·{" "}
                            {new Date(entry.scheduledFor).toLocaleString()}
                          </small>
                          {["claimed", "running", "awaiting_resume"].includes(entry.status) && (
                            <button type="button" disabled={disabled} onClick={() => cancelRun(entry.id)}>
                              取消
                            </button>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
