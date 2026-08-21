import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";

export type FeishuDocumentBlock = Record<string, unknown>;

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });

function attachmentId(source: string | null): string | undefined {
  if (!source) return undefined;
  const matched = source.match(/^(?:attachment:|uma-attachment:\/\/)([a-zA-Z0-9_-]+)$/);
  return matched?.[1];
}

function attachmentImageBlocks(token: Token | undefined): FeishuDocumentBlock[] {
  return (token?.children ?? []).flatMap((child) => {
    if (child.type !== "image") return [];
    const id = attachmentId(child.attrGet("src"));
    return id
      ? [{ block_type: 27, image: {}, __umaAttachmentId: id, __umaAlt: child.content || "image" }]
      : [];
  });
}

function textElements(token: Token | undefined): Array<Record<string, unknown>> {
  if (!token) return [];
  const output: Array<Record<string, unknown>> = [];
  let link: string | undefined;
  let bold = false;
  let italic = false;
  for (const child of token.children ?? []) {
    if (child.type === "link_open") link = child.attrGet("href") ?? undefined;
    else if (child.type === "link_close") link = undefined;
    else if (child.type === "strong_open") bold = true;
    else if (child.type === "strong_close") bold = false;
    else if (child.type === "em_open") italic = true;
    else if (child.type === "em_close") italic = false;
    else if (["text", "code_inline"].includes(child.type))
      output.push({
        text_run: {
          content: child.content,
          text_element_style: {
            bold,
            italic,
            inline_code: child.type === "code_inline",
            ...(link ? { link: { url: link } } : {}),
          },
        },
      });
    else if (child.type === "softbreak" || child.type === "hardbreak")
      output.push({ text_run: { content: "\n", text_element_style: {} } });
    else if (child.type === "image" && !attachmentId(child.attrGet("src")))
      output.push({
        text_run: { content: `[image: ${child.attrGet("src") ?? "unknown"}]`, text_element_style: {} },
      });
  }
  return output;
}

function textBlock(blockType: number, name: string, elements: Array<Record<string, unknown>>) {
  return { block_type: blockType, [name]: { elements, style: {} } };
}

function tableText(tokens: Token[], start: number): { content: string; end: number } {
  const rows: string[][] = [];
  let row: string[] | undefined;
  let index = start;
  for (; index < tokens.length; index++) {
    const token = tokens[index];
    if (token?.type === "tr_open") row = [];
    else if (token?.type === "inline" && row) row.push(token.content);
    else if (token?.type === "tr_close" && row) {
      rows.push(row);
      row = undefined;
    } else if (token?.type === "table_close") break;
  }
  return { content: rows.map((value) => value.join("\t")).join("\n"), end: index };
}

export function markdownToFeishuBlocks(source: string): FeishuDocumentBlock[] {
  const tokens = markdown.parse(source, {});
  const blocks: FeishuDocumentBlock[] = [];
  let list: "bullet" | "ordered" | undefined;
  let quoteDepth = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token) continue;
    if (token.type === "bullet_list_open") list = "bullet";
    else if (token.type === "ordered_list_open") list = "ordered";
    else if (token.type === "bullet_list_close" || token.type === "ordered_list_close") list = undefined;
    else if (token.type === "blockquote_open") quoteDepth++;
    else if (token.type === "blockquote_close") quoteDepth = Math.max(0, quoteDepth - 1);
    else if (token.type === "heading_open") {
      const level = Math.max(1, Math.min(9, Number(token.tag.slice(1))));
      blocks.push(textBlock(level + 2, `heading${level}`, textElements(tokens[index + 1])));
    } else if (token.type === "paragraph_open") {
      const inline = tokens[index + 1];
      const elements = textElements(inline);
      if (elements.length) {
        if (list) blocks.push(textBlock(list === "bullet" ? 12 : 13, list, elements));
        else if (quoteDepth) blocks.push(textBlock(15, "quote", elements));
        else blocks.push(textBlock(2, "text", elements));
      }
      blocks.push(...attachmentImageBlocks(inline));
    } else if (token.type === "fence" || token.type === "code_block")
      blocks.push(
        textBlock(14, "code", [
          { text_run: { content: token.content, text_element_style: { inline_code: true } } },
        ]),
      );
    else if (token.type === "hr") blocks.push({ block_type: 22, divider: {} });
    else if (token.type === "table_open") {
      const table = tableText(tokens, index + 1);
      blocks.push(
        textBlock(2, "text", [
          { text_run: { content: table.content, text_element_style: { inline_code: true } } },
        ]),
      );
      index = table.end;
    }
  }
  return blocks.length
    ? blocks
    : [textBlock(2, "text", [{ text_run: { content: source, text_element_style: {} } }])];
}
