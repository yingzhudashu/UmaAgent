import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parseDocument } from "../dist/document-parser.js";

// 使用独立成熟文档库生成的原生文件，经过真实发布 Worker；不 mock 解析器。
it.each(["docx", "xlsx", "pptx", "pdf"])(
  "extracts a real %s file through the isolated document worker",
  async (extension) => {
    const fixture = fileURLToPath(new URL(`./fixtures/documents/sample.${extension}`, import.meta.url));
    const text = await parseDocument(fixture);
    expect(text).toContain(`UMA_${extension.toUpperCase()}_ACCEPTANCE_2026`);
  },
);
