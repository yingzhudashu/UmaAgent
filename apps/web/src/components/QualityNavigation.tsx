/** 质量页的标签、时间窗与刷新入口；数据仍由账号作用域的查询缓存管理。 */
export function QualityNavigation({
  tab,
  changeTab,
  days,
  changeDays,
  pending,
  refresh,
}: {
  tab: string;
  changeTab: (tab: string) => void;
  days: number;
  changeDays: (days: number) => void;
  pending: boolean;
  refresh: () => void;
}) {
  return (
    <>
      <nav className="page-tabs" aria-label="质量中心">
        {(
          [
            ["diagnostics", "运行诊断"],
            ["evaluations", "评测历史"],
            ["optimization", "人工优化"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-current={tab === id ? "page" : undefined}
            onClick={() => changeTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === "diagnostics" && (
        <label>
          诊断时间窗
          <select
            value={days}
            disabled={pending}
            onChange={(event) => changeDays(Number(event.target.value))}
          >
            <option value={1}>最近24小时</option>
            <option value={7}>最近7天</option>
            <option value={30}>最近30天</option>
          </select>
        </label>
      )}
      <button type="button" disabled={pending} onClick={refresh}>
        刷新质量数据
      </button>
    </>
  );
}
