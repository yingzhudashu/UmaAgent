import { parentPort, workerData } from "node:worker_threads";
import { parseOffice } from "officeparser";

const path = String(workerData);

try {
  const document = await parseOffice(path, {
    extractAttachments: false,
    includeRawContent: false,
    ocr: false,
  });
  // officeparser 8 使用异步格式导出；只发送纯文本，不传递 AST 或嵌套资源。
  const text = await document.to("text");
  parentPort?.postMessage({ ok: true, text: text.value });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}
