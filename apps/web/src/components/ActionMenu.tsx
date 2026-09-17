import { type ReactNode, useEffect, useRef, useState } from "react";

/** 一层原生 disclosure：按钮可用 Tab 发现，点击外部、执行动作或 Escape 后收起。 */
export function ActionMenu({ children, label = "更多操作" }: { children: ReactNode; label?: string }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target))
        ref.current?.removeAttribute("open");
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return (
    <details
      ref={ref}
      className="action-menu"
      onToggle={(event) => setOpen(event.currentTarget.open)}
      onClick={(event) => {
        const button = event.target instanceof Element ? event.target.closest("button") : null;
        if (button && !button.disabled) ref.current?.removeAttribute("open");
      }}
      onKeyDown={(event) => {
        const menu = event.currentTarget;
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
          if (!buttons.length) return;
          event.preventDefault();
          event.stopPropagation();
          menu.open = true;
          const index =
            document.activeElement instanceof HTMLButtonElement
              ? buttons.indexOf(document.activeElement)
              : -1;
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : index < 0
                  ? event.key === "ArrowUp"
                    ? buttons.length - 1
                    : 0
                  : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }
        if (event.key === "Escape") {
          menu.removeAttribute("open");
          menu.querySelector("summary")?.focus();
          event.stopPropagation();
        }
      }}
    >
      <summary aria-label={label}>更多</summary>
      <div className="action-menu-items">{children}</div>
    </details>
  );
}
