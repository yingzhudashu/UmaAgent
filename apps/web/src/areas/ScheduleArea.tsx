import type { CreateScheduledTaskRequest, ScheduledTask, ScheduledTaskRun } from "@uma-agent/protocol";
import { Clock3, History, Play, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useOperation } from "../components/OperationFeedback.js";
import { useUnsavedForm } from "../components/UnsavedChanges.js";
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
  create: (input: CreateScheduledTaskRequest) => unknown;
  toggle: (id: string, enabled: boolean) => unknown;
  run: (id: string) => unknown;
  remove: (id: string) => unknown;
  loadRuns: (id: string) => Promise<ScheduledTaskRun[]>;
  cancelRun: (id: string) => unknown;
}) {
  const operation = useOperation();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<"once" | "interval" | "cron">("interval");
  const [value, setValue] = useState("3600000");
  const [timezone, setTimezone] = useState("Asia/Shanghai");
  const reset = () => {
    setName("");
    setPrompt("");
    setKind("interval");
    setValue("3600000");
    setTimezone("Asia/Shanghai");
  };
  const leave = useUnsavedForm(
    name !== "" ||
      prompt !== "" ||
      kind !== "interval" ||
      value !== "3600000" ||
      timezone !== "Asia/Shanghai",
    reset,
  );
  const [history, setHistory] = useState<Record<string, ScheduledTaskRun[]>>({});
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    let schedule: CreateScheduledTaskRequest["schedule"];
    if (kind === "once") schedule = { kind, at: Date.parse(value) };
    else if (kind === "interval") schedule = { kind, everyMs: Number(value) };
    else schedule = { kind, expression: value, timezone };
    if (
      !(await operation.execute(() => {
        if (!name.trim() || !prompt.trim()) throw new Error("名称和任务不能为空");
        if (schedule.kind === "once" && (!Number.isFinite(schedule.at) || schedule.at <= Date.now()))
          throw new Error("请选择未来的有效时间");
        if (
          schedule.kind === "interval" &&
          (!Number.isSafeInteger(schedule.everyMs) || schedule.everyMs < 1000)
        )
          throw new Error("间隔必须为至少 1000 的整数毫秒");
        return create({ name: name.trim(), prompt: prompt.trim(), schedule });
      }))
    )
      return;
    setShowForm(false);
    reset();
  };
  return (
    <section className="settings-section settings-section--operation">
      {operation.feedback}
      <div className="settings-section-heading">
        <div>
          <h3>调度</h3>
          <p>按设定时间执行当前账号的自动化任务。</p>
        </div>
      </div>
      <details
        className="settings-disclosure"
        open={showForm}
        onToggle={(event) => setShowForm(event.currentTarget.open)}
      >
        <summary>
          <Plus size={14} aria-hidden="true" /> 新建调度
        </summary>
        <form className="settings-form settings-form--compact" onSubmit={submit}>
          <label>
            名称
            <input
              required
              disabled={operation.busy || disabled}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            任务
            <textarea
              required
              disabled={operation.busy || disabled}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>
          <label>
            类型
            <select
              disabled={operation.busy || disabled}
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
            <input
              required
              disabled={operation.busy || disabled}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
          {kind === "cron" && (
            <label>
              时区
              <input
                required
                disabled={operation.busy || disabled}
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
              />
            </label>
          )}
          <div className="settings-form-actions">
            <button type="button" disabled={operation.busy} onClick={() => leave(() => setShowForm(false))}>
              取消
            </button>
            <button className="primary settings-primary" type="submit" disabled={operation.busy || disabled}>
              创建
            </button>
          </div>
        </form>
      </details>
      {schedules.length === 0 ? (
        <p className="settings-empty">暂无调度任务。</p>
      ) : (
        <div className="settings-list settings-list--operation">
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
                  <button
                    type="button"
                    className="settings-icon-button"
                    title="立即运行"
                    aria-label="立即运行"
                    disabled={operation.busy || disabled}
                    onClick={() => operation.confirm("立即运行调度？", item.name, () => run(item.id))}
                  >
                    <Play size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="settings-icon-button"
                    title={item.enabled ? "停用调度" : "启用调度"}
                    aria-label={item.enabled ? "停用调度" : "启用调度"}
                    disabled={operation.busy || disabled}
                    onClick={() => void operation.execute(() => toggle(item.id, !item.enabled))}
                  >
                    <Clock3 size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="settings-icon-button"
                    title="查看运行历史"
                    aria-label="查看运行历史"
                    onClick={() =>
                      void operation.execute(() =>
                        loadRuns(item.id).then((runs) =>
                          setHistory((current) => ({ ...current, [item.id]: runs })),
                        ),
                      )
                    }
                  >
                    <History size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="settings-icon-button"
                    title="删除调度"
                    aria-label="删除调度"
                    disabled={operation.busy || disabled}
                    onClick={() =>
                      operation.confirm("删除调度？", "删除后不再产生新的运行，已有运行不因此取消。", () =>
                        remove(item.id),
                      )
                    }
                  >
                    <Trash2 size={14} aria-hidden="true" />
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
                            <button
                              type="button"
                              className="text-action"
                              disabled={operation.busy || disabled}
                              onClick={() =>
                                operation.confirm("取消这次运行？", "此操作不删除调度规则。", () =>
                                  cancelRun(entry.id),
                                )
                              }
                            >
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
    </section>
  );
}
