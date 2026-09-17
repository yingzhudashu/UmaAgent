import { renderMessage, updateMessageElement } from "./index.js";
import "./style.css";

declare global {
  interface Window {
    UmaBody: {
      height(value: number): void;
      copy(value: string): boolean;
      ready(): void;
      attachment(id: string): void;
      image(url: string): void;
    };
    updateMessage: (
      content: string,
      theme: { text: string; background: string; link: string; size: number; code: string },
    ) => void;
  }
}
const root = document.getElementById("message") as HTMLElement;
window.updateMessage = (content, theme) => {
  root.style.color = theme.text;
  root.style.fontSize = `${theme.size}px`;
  root.style.setProperty("--message-link", theme.link);
  root.style.setProperty("--message-code-bg", theme.code);
  document.body.style.background = theme.background;
  updateMessageElement(root, renderMessage(content));
  // ResizeObserver 是尺寸变化的唯一通知源，避免每个增量额外安排一次跨线程测量。
};
root.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const button = target.closest(".code-copy");
  if (button?.previousElementSibling?.tagName === "PRE") {
    const copied = window.UmaBody.copy(button.previousElementSibling.textContent ?? "");
    button.textContent = copied ? "已复制" : "复制失败，请选择文本复制";
  }
  const anchor = target.closest<HTMLAnchorElement>("a[href^='#uma-attachment-']");
  if (anchor) {
    event.preventDefault();
    window.UmaBody.attachment(anchor.hash.slice("#uma-attachment-".length));
  }
  if (target instanceof HTMLImageElement) {
    if (target.classList.contains("image-failed")) {
      target.classList.remove("image-failed");
      target.setAttribute("src", target.src);
    } else window.UmaBody.image(target.src);
  }
});
new ResizeObserver(() => window.UmaBody.height(root.getBoundingClientRect().height)).observe(root);
window.UmaBody.ready();
