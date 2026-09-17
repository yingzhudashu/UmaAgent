// 比较渲染器最后提交的内容，而非被复制反馈或图片失败状态修改过的实时DOM。
// WeakMap不延长离屏节点生命周期；每个实际变更的块只保存一份无事件的结构快照。
const renderedNodes = new WeakMap<Node, Node>();

/** 保留未变化的段落、图片和代码块，流式追加只替换变化部分。 */
export function updateMessageElement(root: HTMLElement, html: string): void {
  const template = document.createElement("template");
  // html 只能来自 renderMessage 的 DOMPurify 出口。
  template.innerHTML = html;
  for (const image of template.content.querySelectorAll("img")) {
    image.loading = "lazy";
    image.decoding = "async";
  }
  const oldNodes = Array.from(root.childNodes);
  const newNodes = Array.from(template.content.childNodes);
  for (let index = 0; index < Math.max(oldNodes.length, newNodes.length); index++) {
    const previous = oldNodes[index];
    const next = newNodes[index];
    if (!next) previous?.remove();
    else if (!previous) {
      renderedNodes.set(next, next.cloneNode(true));
      root.append(next);
    } else if (!(renderedNodes.get(previous) ?? previous).isEqualNode(next)) {
      const scrollLeft = previous instanceof HTMLElement ? previous.scrollLeft : 0;
      renderedNodes.set(next, next.cloneNode(true));
      previous.replaceWith(next);
      if (next instanceof HTMLElement) next.scrollLeft = scrollLeft;
    }
  }
  for (const image of root.querySelectorAll("img")) {
    image.onerror = () => {
      image.classList.add("image-failed");
      image.alt = image.alt || "图片加载失败，点击重试";
    };
  }
}
