import DOMPurify from "dompurify";
import katex from "katex";
import { Marked } from "marked";

// 同一公式会随流式尾部重复解析。只缓存受限大小的纯渲染结果，主题由 CSS 决定。
const mathCache = new Map<string, string>();
const messageCache = new Map<string, string>();
let cachedCharacters = 0;

/**
 * 只有在前一段语法已经闭合时，才允许把新的纯文本段落直接接到旧 HTML。
 * 这条检查故意偏保守：遇到可能跨空行继续解析的 Markdown 结构就回退完整解析，
 * 保证流式优化不会改变代码、公式、链接或强调语义。
 */
function stableMarkdownPrefix(content: string): boolean {
  // DOMPurify 会补齐或改写 HTML 标签，原样拼接无法保证输出与完整清洗一致。
  if (content.includes("<")) return false;
  let fence: string | undefined;
  for (const line of content.split("\n")) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    const marker = match[1] as string;
    const trailing = match[2] as string;
    if (!fence) {
      // CommonMark 不允许反引号围栏的信息串再包含反引号。
      if (marker[0] !== "`" || !trailing.includes("`")) fence = marker;
    } else if (marker[0] === fence[0] && marker.length >= fence.length && trailing.trim().length === 0) {
      fence = undefined;
    }
  }
  if (fence) return false;
  const withoutEscaped = content.replace(/\\[\\`*_{}[\]()#+.!$~>-]/g, "");
  if ((withoutEscaped.match(/`/g)?.length ?? 0) % 2 !== 0) return false;
  if ((withoutEscaped.match(/\$/g)?.length ?? 0) % 2 !== 0) return false;
  if ((content.match(/\\\[/g)?.length ?? 0) !== (content.match(/\\\]/g)?.length ?? 0)) return false;
  if ((content.match(/\\\(/g)?.length ?? 0) !== (content.match(/\\\)/g)?.length ?? 0)) return false;
  if ((withoutEscaped.match(/\[/g)?.length ?? 0) !== (withoutEscaped.match(/\]/g)?.length ?? 0)) return false;
  if ((withoutEscaped.match(/\*/g)?.length ?? 0) % 2 !== 0) return false;
  if ((withoutEscaped.match(/_/g)?.length ?? 0) % 2 !== 0) return false;
  return true;
}

function appendPlainParagraph(
  content: string,
  previousContent: string,
  previousHtml: string,
): string | undefined {
  if (!previousContent || !previousHtml || !content.startsWith(previousContent)) return undefined;
  const suffix = content.slice(previousContent.length);
  const paragraph = /^\n\n([\p{L}\p{N}][\p{L}\p{N} _-]*)$/u.exec(suffix)?.[1];
  if (!paragraph || !stableMarkdownPrefix(previousContent)) return undefined;
  if (!/<\/(?:p|h[1-6]|ul|ol|blockquote|pre|table|button)>\s*$/u.test(previousHtml)) return undefined;
  return `${previousHtml}<p>${paragraph}</p>\n`;
}

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

/** 每个正文宿主独立保存前缀；不满足严格条件时回到唯一的清洗解析入口。 */
export function createMessageRenderer(): (content: string) => string {
  let previousContent = "";
  let previousHtml = "";
  return (content: string) => {
    const html = appendPlainParagraph(content, previousContent, previousHtml) ?? renderMessage(content);
    previousContent = content;
    previousHtml = html;
    return html;
  };
}

export { updateMessageElement } from "./dom.js";
