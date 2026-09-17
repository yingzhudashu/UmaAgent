import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UmaClient } from "@uma-agent/client";

/** 保存回执是唯一开关状态；网络失败不能将本地点击伪装成已生效。 */
export function ExecutionSettings({ client, disabled }: { client: UmaClient; disabled: boolean }) {
  const cache = useQueryClient();
  const settings = useQuery({
    queryKey: ["execution-settings"],
    queryFn: () => client.getExecutionSettings(),
  });
  const mutation = useMutation({
    mutationFn: (value: boolean) => client.updateExecutionSettings(value),
    onSuccess: (value) => cache.setQueryData(["execution-settings"], value),
  });
  return (
    <section className="settings-section">
      <h3>执行权限</h3>
      <label className="settings-row">
        <span>
          <strong>免审批</strong>
          <br />
          当前账号的工具、命令和调度在所有设备统一生效。
        </span>
        <input
          type="checkbox"
          role="switch"
          aria-checked={settings.data?.autoApprove ?? true}
          aria-label="免审批"
          checked={settings.data?.autoApprove ?? true}
          disabled={disabled || !settings.data || mutation.isPending}
          onChange={(event) => mutation.mutate(event.target.checked)}
        />
      </label>
      {(settings.isError || mutation.isError) && (
        <p role="alert">
          执行设置未保存或读取失败，请重试。
          <button type="button" onClick={() => void settings.refetch()}>
            重新读取
          </button>
        </p>
      )}
      {mutation.isPending && <output>正在保存…</output>}
    </section>
  );
}
