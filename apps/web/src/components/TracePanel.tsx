import { useInfiniteQuery } from "@tanstack/react-query";
import type { UmaClient } from "@uma-agent/client";
import type { TraceQuery } from "@uma-agent/protocol";
import { Check, Clipboard, RotateCw, X } from "lucide-react";
import { useEffect, useState } from "react";

type TraceFilters = Pick<TraceQuery, "service" | "kind" | "status" | "name" | "from" | "to">;

const timeWindows = [
  { value: "all", label: "全部时间" },
  { value: "1h", label: "最近 1 小时", durationMs: 60 * 60 * 1000 },
  { value: "24h", label: "最近 24 小时", durationMs: 24 * 60 * 60 * 1000 },
  { value: "7d", label: "最近 7 天", durationMs: 7 * 24 * 60 * 60 * 1000 },
] as const;

/** 按需查询所属 Run；筛选变化会切换独立缓存，避免旧分页混入新结果。 */
export function TracePanel({ client, runId }: { client: UmaClient; runId: string }) {
  const [open, setOpen] = useState(false);
  const [service, setService] = useState("");
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState<TraceQuery["status"] | "">("");
  const [name, setName] = useState("");
  const [timeWindow, setTimeWindow] = useState<(typeof timeWindows)[number]["value"]>("all");
  const [debouncedText, setDebouncedText] = useState({ service: "", kind: "", name: "" });
  const [timeRange, setTimeRange] = useState<{ from: number; to: number }>();
  const [copyStatus, setCopyStatus] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(
      () => setDebouncedText({ service: service.trim(), kind: kind.trim(), name: name.trim() }),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [kind, name, service]);

  const filters: TraceFilters = {
    ...(debouncedText.service ? { service: debouncedText.service } : {}),
    ...(debouncedText.kind ? { kind: debouncedText.kind } : {}),
    ...(status ? { status } : {}),
    ...(debouncedText.name ? { name: debouncedText.name } : {}),
    ...(timeRange ?? {}),
  };

  const query = useInfiniteQuery({
    queryKey: ["trace", runId, filters],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => client.queryTraces({ runId, ...filters, offset: pageParam }),
    getNextPageParam: (last) => (last.hasMore ? last.nextOffset : undefined),
    enabled: open,
  });
  const spans = query.data?.pages.flatMap((page) => page.spans) ?? [];
  const traceId = query.data?.pages[0]?.traceId ?? "";
  const hasFilters = Boolean(service || kind || status || name || timeRange);

  useEffect(() => {
    if (traceId) setCopyStatus("");
  }, [traceId]);

  function changeTimeWindow(value: (typeof timeWindows)[number]["value"]) {
    setTimeWindow(value);
    const selected = timeWindows.find((window) => window.value === value);
    if (!selected || selected.value === "all") {
      setTimeRange(undefined);
      return;
    }
    const to = Date.now();
    setTimeRange({ from: to - selected.durationMs, to });
  }

  function clearFilters() {
    setService("");
    setKind("");
    setStatus("");
    setName("");
    setDebouncedText({ service: "", kind: "", name: "" });
    setTimeWindow("all");
    setTimeRange(undefined);
  }

  async function copyTraceId() {
    if (!navigator.clipboard?.writeText) {
      setCopyStatus("浏览器不支持复制，请手动选择 ID");
      return;
    }
    try {
      await navigator.clipboard.writeText(traceId);
      setCopyStatus("已复制 Trace ID");
    } catch {
      setCopyStatus("复制失败，请手动选择 ID");
    }
  }

  return (
    <details className="trace-panel" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span>链路与耗时</span>
        {query.data && <small>{spans.length} 个阶段</small>}
      </summary>
      {open && (
        <div className="trace-content">
          <fieldset className="trace-filters">
            <legend className="trace-visually-hidden">链路筛选条件</legend>
            <label>
              服务
              <input
                aria-label="按服务筛选链路"
                value={service}
                maxLength={80}
                placeholder="如 core、server"
                onChange={(event) => setService(event.target.value)}
              />
            </label>
            <label>
              阶段类型
              <input
                aria-label="按阶段类型筛选链路"
                value={kind}
                maxLength={40}
                placeholder="如 model、tool"
                onChange={(event) => setKind(event.target.value)}
              />
            </label>
            <label>
              状态
              <select
                aria-label="按状态筛选链路"
                value={status}
                onChange={(event) => setStatus(event.target.value as TraceQuery["status"] | "")}
              >
                <option value="">全部状态</option>
                <option value="ok">已完成</option>
                <option value="error">错误</option>
                <option value="cancelled">已取消</option>
              </select>
            </label>
            <label>
              名称
              <input
                aria-label="按名称搜索阶段"
                value={name}
                maxLength={200}
                placeholder="搜索阶段名称"
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label>
              时间范围
              <select
                aria-label="按时间范围筛选链路"
                value={timeWindow}
                onChange={(event) =>
                  changeTimeWindow(event.target.value as (typeof timeWindows)[number]["value"])
                }
              >
                {timeWindows.map((window) => (
                  <option key={window.value} value={window.value}>
                    {window.label}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>
          {hasFilters && (
            <div className="trace-filter-actions">
              <button type="button" className="trace-clear" onClick={clearFilters}>
                <X size={14} aria-hidden="true" />
                清除筛选
              </button>
            </div>
          )}
          {query.isPending && <output className="trace-message">正在读取链路…</output>}
          {query.isFetching && !query.isPending && !query.isFetchingNextPage && (
            <output className="trace-message" aria-live="polite">
              正在更新结果…
            </output>
          )}
          {query.isError && (
            <p className="trace-message" role="alert">
              读取链路失败。
              <button type="button" disabled={query.isFetching} onClick={() => void query.refetch()}>
                <RotateCw size={14} aria-hidden="true" />
                {query.isFetching ? "正在重试…" : "重试"}
              </button>
            </p>
          )}
          <output
            className="trace-visually-hidden trace-results-status"
            aria-live="polite"
            aria-atomic="true"
          >
            {query.data && !query.isFetching
              ? `已加载 ${spans.length} 个阶段${query.hasNextPage ? "，可继续加载" : ""}`
              : ""}
          </output>
          {query.data && (
            <>
              {traceId && (
                <div className="trace-id-row">
                  <span>Trace ID</span>
                  <code>{traceId}</code>
                  <button
                    type="button"
                    className="trace-copy"
                    title="复制 Trace ID"
                    aria-label="复制 Trace ID"
                    onClick={() => void copyTraceId()}
                  >
                    {copyStatus === "已复制 Trace ID" ? (
                      <Check size={15} aria-hidden="true" />
                    ) : (
                      <Clipboard size={15} aria-hidden="true" />
                    )}
                  </button>
                  <span aria-live="polite">{copyStatus}</span>
                </div>
              )}
              {spans.length === 0 ? (
                <p className="trace-empty">{hasFilters ? "没有符合条件的阶段" : "当前运行暂无链路记录"}</p>
              ) : (
                <ol className="trace-stages" aria-label="运行阶段">
                  {spans.map((span) => (
                    <li
                      key={span.spanId}
                      className={`trace-stage trace-stage--${span.status}`}
                      style={{ marginInlineStart: `${Math.min(span.depth ?? 0, 4) * 12}px` }}
                    >
                      <div className="trace-stage-heading">
                        <strong>{span.name}</strong>
                        <span className="trace-stage-duration">{span.durationMs.toFixed(1)} ms</span>
                      </div>
                      <div className="trace-stage-meta">
                        <span>{span.service}</span>
                        <span>{span.kind}</span>
                        <span>
                          {span.status === "ok" ? "已完成" : span.status === "cancelled" ? "已取消" : "错误"}
                        </span>
                      </div>
                      {span.errorMessage && (
                        <output className="trace-stage-error">{span.errorMessage}</output>
                      )}
                    </li>
                  ))}
                </ol>
              )}
              {query.hasNextPage && (
                <button
                  type="button"
                  className="trace-more"
                  disabled={query.isFetchingNextPage}
                  onClick={() => void query.fetchNextPage()}
                >
                  {query.isFetchingNextPage ? "正在加载…" : "加载更多阶段"}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </details>
  );
}
