import { describe, expect, it, vi } from "vitest";

vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));

const { createMessageRenderer, renderMessage } = await import("../src/index.js");

describe("per-message Markdown renderer", () => {
  it.each([
    "# 标题",
    "正文 **加粗**",
    "- 列表项目",
    "[链接](https://example.test/path)",
    "公式 $x^2$",
    "| A | B |\n| --- | --- |\n| x | y |",
  ])("keeps a complete plain paragraph equivalent after %s", (prefix) => {
    const renderer = createMessageRenderer();
    renderer(prefix);
    const content = `${prefix}\n\n新增文本`;

    expect(renderer(content)).toBe(renderMessage(content));
  });

  it("re-parses an unclosed fenced block whose apparent closer has trailing text", () => {
    const renderer = createMessageRenderer();
    const prefix = "```text\ncode\n``` still-open";
    renderer(prefix);
    const content = `${prefix}\n\nplain text`;
    const rendered = renderer(content);

    expect(rendered).toBe(renderMessage(content));
    expect(rendered).toContain("plain text");
    expect(rendered).not.toContain("<p>plain text</p>");
  });

  it("re-parses HTML prefixes so sanitizer output is never reused as parser state", () => {
    const renderer = createMessageRenderer();
    const prefix = "<pre>code";
    renderer(prefix);
    const content = `${prefix}\n\nplain text`;

    expect(renderer(content)).toBe(renderMessage(content));
  });

  it("does not reuse a previous message renderer's prefix", () => {
    const first = createMessageRenderer();
    const second = createMessageRenderer();
    first("# Shared prefix");
    const content = "# Shared prefix\n\nSecond message";

    expect(second(content)).toBe(renderMessage(content));
  });
});
