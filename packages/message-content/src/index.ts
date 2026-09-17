import DOMPurify from "dompurify";
import katex from "katex";
import { Marked } from "marked";

// 同一公式会随流式尾部重复解析。只缓存受限大小的纯渲染结果，主题由 CSS 决定。
const mathCache = new Map<string, string>();
const messageCache = new Map<string, string>();
let cachedCharacters = 0;

// 扩展交由 Markdown lexer 调度，代码块和转义内容不会被全局正则误替换。
const parser = new Marked({
  gfm: true,
  breaks: false,
  walkTokens(token) {
    // 仅处理链接目标；代码块、行内代码和普通正文中的 URI 必须原样保留。
    if (token.type === "link" || token.type === "image")
      token.href = token.href.replace(/^uma-attachment:\/\/([A-Za-z0-9._:-]+)$/, "#uma-attachment-$1");
  },
});
for (const block of [true, false]) {
  const pattern = block
    ? /^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])(?:\n|$)/
    : /^(?:\$(?!\$)([^\n$]+?)\$(?!\$)|\\\(([^\n]+?)\\\))/;
  parser.use({
    extensions: [
      {
        name: block ? "mathBlock" : "mathInline",
        level: block ? "block" : "inline",
        start: (source: string) => {
          const at = source.search(block ? /\$\$|\\\[/ : /\$|\\\(/);
          return at < 0 ? undefined : at;
        },
        tokenizer(source: string) {
          const match = pattern.exec(source);
          return match
            ? { type: block ? "mathBlock" : "mathInline", raw: match[0], text: match[1] ?? match[2] ?? "" }
            : undefined;
        },
        renderer(token) {
          const key = `${block}:${token.text}`;
          const cached = mathCache.get(key);
          if (cached !== undefined) return cached;
          const rendered = `<span class="${block ? "math-block" : "math-inline"}">${katex.renderToString(
            token.text,
            {
              displayMode: block,
              throwOnError: false,
              trust: false,
              strict: "ignore",
              maxExpand: 1000,
              maxSize: 20,
            },
          )}</span>`;
          if (key.length + rendered.length <= 8192) {
            mathCache.set(key, rendered);
            if (mathCache.size > 64) mathCache.delete(mathCache.keys().next().value as string);
          }
          return rendered;
        },
      },
    ],
  });
}

/** 两端唯一的正文解析入口。只产出经过清洗的 HTML，不接受调用者关闭清洗。 */
export function renderMessage(content: string): string {
  const cached = messageCache.get(content);
  if (cached !== undefined) {
    messageCache.delete(content);
    messageCache.set(content, cached);
    return cached;
  }
  const clean = DOMPurify.sanitize(parser.parse(content, { async: false }) as string, {
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input", "style"],
    FORBID_ATTR: ["srcdoc"],
    ADD_TAGS: ["annotation"],
  });
  // 操作由宿主委托执行，正文不能注入事件代码。
  const rendered = clean.replace(
    /<\/pre>/g,
    '</pre><button type="button" class="code-copy">复制代码</button>',
  );
  // 离屏后重新显示的已完成消息不再重复解析；按条数和 UTF-16 字符总量双重设限。
  const size = content.length + rendered.length;
  if (size <= 524288) {
    messageCache.set(content, rendered);
    cachedCharacters += size;
    while (messageCache.size > 32 || cachedCharacters > 524288) {
      const first = messageCache.keys().next().value as string;
      cachedCharacters -= first.length + (messageCache.get(first)?.length ?? 0);
      messageCache.delete(first);
    }
  }
  return rendered;
}

export { updateMessageElement } from "./dom.js";
