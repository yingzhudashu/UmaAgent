import type { InteractionMode } from "@uma-agent/protocol";
import { Bot, ListChecks } from "lucide-react";

const modes: Array<{ id: InteractionMode; label: string; hint: string; Icon: typeof Bot }> = [
  { id: "plan", label: "Plan", hint: "先规划，再执行并验证", Icon: ListChecks },
  { id: "agent", label: "Agent", hint: "直接执行，敏感操作需审批", Icon: Bot },
];

export function ModeSelector({
  value,
  onChange,
  disabled = false,
}: {
  value: InteractionMode;
  onChange: (mode: InteractionMode) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="mode-selector" aria-label="消息模式">
      {modes.map(({ id, label, hint, Icon }) => (
        <button
          type="button"
          key={id}
          className={value === id ? "active" : ""}
          aria-pressed={value === id}
          title={hint}
          disabled={disabled}
          onClick={() => onChange(id)}
        >
          <Icon aria-hidden="true" size={15} />
          <span>{label}</span>
        </button>
      ))}
    </fieldset>
  );
}
