import { readFileSync } from "node:fs";
import { Marked, Renderer } from "marked";

// Markdown 的路径以 docs 为基准；图文阅读版位于其 frontend-design 子目录。
const parser = new Marked({
  walkTokens(token) {
    if (
      (token.type === "link" || token.type === "image") &&
      !/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(token.href)
    )
      token.href = `../${token.href}`;
  },
  renderer: {
    table(token) {
      return `<div class="table">${Renderer.prototype.table.call(this, token)}</div>`;
    },
    image(token) {
      return Renderer.prototype.image.call(this, token).replace("<img ", '<img loading="lazy" ');
    },
  },
});
// 只渲染仓库维护的设计源；复用产品现有依赖，不再维护另一套不完整的 Markdown 语法。
process.stdout.write(parser.parse(readFileSync(0, "utf8"), { async: false }));
