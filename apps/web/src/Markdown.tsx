import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useMemo, useRef } from "react";

export function Markdown({
  content,
  onAttachmentDownload,
}: {
  content: string;
  onAttachmentDownload?: (id: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const html = useMemo(() => {
    const normalized = content.replace(/uma-attachment:\/\/([A-Za-z0-9._:-]+)/g, "#uma-attachment-$1");
    return DOMPurify.sanitize(marked.parse(normalized, { async: false }) as string);
  }, [content]);
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !onAttachmentDownload) return;
    const onClick = (event: MouseEvent) => {
      const target = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[href^='#uma-attachment-']");
      if (!target) return;
      event.preventDefault();
      const id = target.getAttribute("href")?.slice("#uma-attachment-".length);
      if (id) onAttachmentDownload(id);
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [onAttachmentDownload]);
  // biome-ignore lint/security/noDangerouslySetInnerHtml: DOMPurify sanitizes generated Markdown.
  return <div ref={rootRef} className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
