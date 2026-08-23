import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";

export function Markdown({ content }: { content: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(content, { async: false }) as string),
    [content],
  );
  // biome-ignore lint/security/noDangerouslySetInnerHtml: DOMPurify sanitizes generated Markdown.
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
