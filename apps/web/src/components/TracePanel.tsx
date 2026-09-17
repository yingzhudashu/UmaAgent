import { useInfiniteQuery } from "@tanstack/react-query";
import type { UmaClient } from "@uma-agent/client";
import { useState } from "react";

/** 按需查询所属 Run；展开后保留阶段顺序，错误直接与阶段关联。 */
export function TracePanel({ client, runId }: { client: UmaClient; runId: string }) {
  const [open, setOpen] = useState(false);
  const query = useInfiniteQuery({
    queryKey: ["trace", runId],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => client.queryTraces({ runId, offset: pageParam }),
    getNextPageParam: (last) => (last.hasMore ? last.nextOffset : undefined),
    enabled: open,
  });
  const spans = query.data?.pages.flatMap((page) => page.spans) ?? [];
  const traceId = query.data?.pages[0]?.traceId ?? "";
  const [copyStatus, setCopyStatus] = useState("");
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const depth = (parent: string | undefined): number => {
    let count = 0;
    const seen = new Set<string>();
    while (parent && !seen.has(parent) && count < 8) {
      seen.add(parent);
      const span = byId.get(parent);
      if (!span) break;
      count++;
      parent = span.parentSpanId;
    }
    return count;
  };
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>链路与耗时</summary>
      {query.isPending && <output>正在读取链路…</output>}
      {query.isError && (
        <p role="alert">
          读取链路失败。
          <button type="button" onClick={() => void query.refetch()}>
            重试
          </button>
        </p>
      )}
      {query.data && (
        <>
          <p>
            <code>{traceId}</code>{" "}
            <button
              type="button"
              onClick={() =>
                void navigator.clipboard
                  .writeText(traceId)
                  .then(() => setCopyStatus("已复制"))
                  .catch(() => setCopyStatus("复制失败，请选择 ID 复制"))
              }
            >
              复制 Trace ID
            </button>
            <output aria-live="polite">{copyStatus}</output>
          </p>
          <ol className="trace-stages">
            {spans.map((span) => (
              <li key={span.spanId} style={{ marginInlineStart: `${depth(span.parentSpanId) * 12}px` }}>
                <strong>{span.name}</strong> · {span.durationMs.toFixed(1)} ms ·{" "}
                {span.status === "ok" ? "完成" : span.status === "cancelled" ? "已取消" : "错误"}
                {span.errorMessage && <output>{span.errorMessage}</output>}
              </li>
            ))}
          </ol>
          {query.hasNextPage && (
            <button
              type="button"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              加载更多阶段
            </button>
          )}
        </>
      )}
    </details>
  );
}
