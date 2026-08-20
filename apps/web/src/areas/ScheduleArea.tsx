import type { CreateScheduledTaskRequest, ScheduledTask } from "@uma-agent/protocol";

export function ScheduleArea({
  schedules,
  disabled,
  create,
  toggle,
  run,
  remove,
}: {
  schedules: ScheduledTask[];
  disabled: boolean;
  create: (input: CreateScheduledTaskRequest) => void;
  toggle: (id: string, enabled: boolean) => void;
  run: (id: string) => void;
  remove: (id: string) => void;
}) {
  const add = () => {
    const name = window.prompt("调度名称")?.trim();
    const prompt = window.prompt("任务内容")?.trim();
    if (!name || !prompt) return;
    const kind = window.prompt("调度类型: once / interval / cron", "interval")?.trim();
    let schedule: CreateScheduledTaskRequest["schedule"] | undefined;
    if (kind === "once") {
      const at = Date.parse(
        window.prompt("执行时间（ISO）", new Date(Date.now() + 60_000).toISOString()) ?? "",
      );
      if (Number.isSafeInteger(at)) schedule = { kind, at };
    } else if (kind === "interval") {
      const everyMs = Number(window.prompt("间隔毫秒（至少 60000）", "3600000"));
      if (Number.isSafeInteger(everyMs) && everyMs >= 60_000) schedule = { kind, everyMs };
    } else if (kind === "cron") {
      const expression = window.prompt("Cron 表达式", "0 9 * * *")?.trim();
      const timezone = window.prompt("IANA 时区", "Asia/Shanghai")?.trim();
      if (expression && timezone) schedule = { kind, expression, timezone };
    }
    if (schedule) create({ name, prompt, schedule });
  };
  return (
    <div className="operation-list">
      <button type="button" className="run-action" disabled={disabled} onClick={add}>
        新建调度
      </button>
      {schedules.map((item) => (
        <div key={item.id}>
          <strong>{item.name}</strong>
          <p>{item.prompt}</p>
          <small className="operation-meta">
            {item.schedule.kind} · {item.enabled ? "enabled" : "disabled"} · next {item.nextRunAt ?? "-"}
          </small>
          <div className="approval-actions">
            <button type="button" disabled={disabled} onClick={() => run(item.id)}>
              立即运行
            </button>
            <button type="button" disabled={disabled} onClick={() => toggle(item.id, !item.enabled)}>
              {item.enabled ? "停用" : "启用"}
            </button>
            <button type="button" disabled={disabled} onClick={() => remove(item.id)}>
              删除
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
