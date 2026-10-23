// 比较渲染器最后提交的内容，而非被复制反馈或图片失败状态修改过的实时DOM。
// WeakMap不延长离屏节点生命周期；每个实际变更的块只保存一份无事件的结构快照。
const renderedNodes = new WeakMap<Node, Node>();
const renderedContent = new WeakMap<HTMLElement, { html: string; nodes: ChildNode[] }>();

/** 保留未变化的段落、图片和代码块，流式追加只替换变化部分。 */
export function updateMessageElement(root: HTMLElement, html: string): void {
  const current = renderedContent.get(root);
  // 上游只提交已清洗且标签闭合的 HTML；完整旧结果未变时，新增片段可独立解析。
  // 同时核对顶层节点归属，宿主清空或替换节点后必须重新校准，不能复用旧前缀。
  const appendOnly =
    current !== undefined &&
    html.startsWith(current.html) &&
    current.nodes.length === root.childNodes.length &&
    current.nodes.every((node, index) => node === root.childNodes[index]);
  if (appendOnly && html === current.html) return;
  const template = document.createElement("template");
  // html 只能来自 renderMessage 的 DOMPurify 出口。
  template.innerHTML = appendOnly ? html.slice(current.html.length) : html;
  const newImages = template.content.querySelectorAll("img");
  for (const image of newImages) {
    image.loading = "lazy";
    image.decoding = "async";
  }
  // 完整 HTML 解析会合并相邻文本；独立片段也须合并边界空白，保持 DOM 结构一致。
  const previousEnd = appendOnly ? root.lastChild : null;
  const nextStart = template.content.firstChild;
  if (previousEnd instanceof Text && nextStart instanceof Text) {
    previousEnd.appendData(nextStart.data);
    renderedNodes.set(previousEnd, previousEnd.cloneNode(true));
    nextStart.remove();
  }
  const oldNodes = appendOnly ? [] : Array.from(root.childNodes);
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
  for (const image of appendOnly ? newImages : root.querySelectorAll("img")) {
    image.onerror = () => {
      image.classList.add("image-failed");
      image.alt = image.alt || "图片加载失败，点击重试";
    };
  }
  // 只缓存可控大小的比较基线，不截断正文；WeakMap 不延长离屏节点生命周期。
  if (html.length <= 524288) renderedContent.set(root, { html, nodes: Array.from(root.childNodes) });
  else renderedContent.delete(root);
}
