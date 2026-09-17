import { lazy, Suspense } from "react";

const Content = lazy(() =>
  import("./MarkdownContent.js").then((module) => ({ default: module.MarkdownContent })),
);

/** 数学字体与解析器仅在有消息正文时加载，登录和管理页不承担这部分首屏成本。 */
export function Markdown(props: { content: string; onAttachmentDownload?: (id: string) => void }) {
  return (
    <Suspense fallback={<div className="markdown">正在加载正文…</div>}>
      <Content {...props} />
    </Suspense>
  );
}
