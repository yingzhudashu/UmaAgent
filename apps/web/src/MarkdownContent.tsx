import { renderMessage, updateMessageElement } from "@uma-agent/message-content";
import "@uma-agent/message-content/style.css";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";

export function MarkdownContent({
  content,
  onAttachmentDownload,
}: {
  content: string;
  onAttachmentDownload?: (id: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMessage(content), [content]);
  useLayoutEffect(() => {
    if (rootRef.current) updateMessageElement(rootRef.current, html);
  }, [html]);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onClick = (event: MouseEvent) => {
      const button = (event.target as HTMLElement).closest(".code-copy");
      if (button?.previousElementSibling?.tagName === "PRE") {
        void navigator.clipboard
          .writeText(button.previousElementSibling.textContent ?? "")
          .then(() => {
            button.textContent = "已复制";
          })
          .catch(() => {
            button.textContent = "复制失败，请选择文本复制";
          });
        return;
      }
      const target = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[href^='#uma-attachment-']");
      if (!target) return;
      event.preventDefault();
      const id = target.getAttribute("href")?.slice("#uma-attachment-".length);
      if (id) onAttachmentDownload?.(id);
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [onAttachmentDownload]);
  return <div ref={rootRef} className="markdown uma-message" />;
}
