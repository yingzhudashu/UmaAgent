import { describe, expect, it } from "vitest";
import { markdownToFeishuBlocks } from "../src/markdown.js";

describe("Feishu Markdown conversion", () => {
  it("preserves headings, inline styles, lists, quotes, code and tables", () => {
    const blocks = markdownToFeishuBlocks(
      "# Title\n\nText with **bold** and [link](https://example.com).\n\n- one\n- two\n\n> quote\n\n```ts\nconst x = 1;\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |",
    );
    expect(blocks.map((item) => item.block_type)).toEqual(expect.arrayContaining([2, 3, 12, 14, 15]));
    expect(JSON.stringify(blocks)).toContain("Title");
    expect(JSON.stringify(blocks)).toContain("const x = 1");
    expect(JSON.stringify(blocks)).toContain("1\\t2");
  });

  it("marks Uma attachment images for a later authenticated media upload", () => {
    const blocks = markdownToFeishuBlocks(
      "Before ![diagram](uma-attachment://attachment_123) after ![remote](https://example.com/a.png)",
    );
    expect(blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          block_type: 27,
          __umaAttachmentId: "attachment_123",
        }),
      ]),
    );
    expect(JSON.stringify(blocks)).toContain("[image: https://example.com/a.png]");
    expect(JSON.stringify(blocks)).not.toContain("[image: uma-attachment://attachment_123]");
  });
});
