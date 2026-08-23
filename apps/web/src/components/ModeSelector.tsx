import type { InteractionMode } from "@uma-agent/protocol";
import { Bot, ListChecks, MessageCircle } from "lucide-react";

const modes: Array<{ id: InteractionMode; label: string; hint: string; Icon: typeof Bot }> = [
  { id: "ask", label: "Ask", hint: "只回答，不执行操作", Icon: MessageCircle },
  { id: "plan", label: "Plan", hint: "生成计划，不执行操作", Icon: ListChecks },
  { id: "agent", label: "Agent", hint: "执行任务，敏感操作需审批", Icon: Bot },
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
