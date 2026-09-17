import { resolve } from "node:path";
import { Worker } from "node:worker_threads";

type Operation = { sql: string; args: Array<string | number | null> };
const writers = new Map<string, SqlWriter>();

/** 同进程同数据库共用一个写入 Worker，避免每个服务重复创建线程和 V8 堆。 */
export class SqlWriter {
  private readonly worker: Worker;
  private queue: Operation[][] = [];
  private queuedCount = 0;
  private group: Operation[] | undefined;
  private timer: NodeJS.Timeout | undefined;
  private inFlight = 0;
  private sequence = 0;
  private completed = 0;
  private waiters: Array<{ target: number; done: () => void }> = [];
  private references = 1;
  private dead = false;
  private watchdog: NodeJS.Timeout | undefined;
  failures = 0;

  static acquire(path: string): SqlWriter {
    const key = resolve(path);
    const existing = writers.get(key);
    if (existing) {
      existing.references++;
      return existing;
    }
    const value = new SqlWriter(key);
    writers.set(key, value);
    return value;
  }
  private constructor(private readonly path: string) {
    this.worker = new Worker(new URL("./sqlite-writer.mjs", import.meta.url), { workerData: { path } });
    this.worker.on("message", (result: { id: number; count: number; failures: number }) => {
      this.inFlight -= result.count;
      this.failures += result.failures;
      this.completed = result.id;
      if (this.watchdog) {
        clearTimeout(this.watchdog);
        this.watchdog = undefined;
      }
      if (this.inFlight > 0) this.armWatchdog();
      this.resolveWaiters();
    });
    this.worker.on("error", () => this.failed());
    this.worker.on("exit", () => this.failed());
    this.worker.unref();
  }
  enqueue(sql: string, args: Operation["args"]): void {
    if (this.group) {
      this.group.push({ sql, args });
      return;
    }
    this.enqueueGroup([{ sql, args }]);
  }
  /** 逻辑事务整体入队；容量不足时整组丢弃，绝不只写一半终态或重复聚合。 */
  batch(action: () => void): void {
    if (this.group) throw new Error("Nested telemetry batches are not supported");
    this.group = [];
    try {
      action();
      this.enqueueGroup(this.group);
    } finally {
      this.group = undefined;
    }
  }
  private enqueueGroup(operations: Operation[]): void {
    // 上限包含已经发给 Worker 的项；不能把无界积压转移到 MessagePort。
    if (this.dead || this.queuedCount + this.inFlight + operations.length > 8192) {
      this.failures += operations.length;
      return;
    }
    if (!operations.length) return;
    this.queue.push(operations);
    this.queuedCount += operations.length;
    if (this.queuedCount >= 128) this.dispatch();
    // 短窗口合并同一阶段的开始/结束与聚合更新；读取仍通过 flush 立即建立可见性屏障。
    else if (!this.timer) this.timer = setTimeout(() => this.dispatch(), 25);
  }
  private dispatch(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.queue.length || this.dead) return;
    const groups = this.queue;
    this.queue = [];
    this.inFlight += this.queuedCount;
    this.queuedCount = 0;
    try {
      this.worker.postMessage({ id: ++this.sequence, groups });
    } catch {
      this.failed();
      return;
    }
    // Worker 卡死也不能令诊断请求或关闭永久挂起。截止时间高于 SQLite 的锁等待。
    if (!this.watchdog) this.armWatchdog();
  }
  private armWatchdog(): void {
    this.watchdog = setTimeout(() => {
      this.failed();
      void this.worker.terminate();
    }, 15_000);
    this.watchdog.unref();
  }
  async flush(): Promise<void> {
    this.dispatch();
    if (this.dead || this.completed >= this.sequence) return;
    this.worker.ref();
    await new Promise<void>((done) => this.waiters.push({ target: this.sequence, done }));
    if (!this.waiters.length) this.worker.unref();
  }
  private resolveWaiters(): void {
    const pending = this.waiters;
    this.waiters = [];
    for (const item of pending) {
      if (this.dead || item.target <= this.completed) item.done();
      else this.waiters.push(item);
    }
  }
  private failed(): void {
    if (this.dead) return;
    this.dead = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.watchdog) clearTimeout(this.watchdog);
    this.failures += this.queuedCount + this.inFlight;
    this.queue = [];
    this.queuedCount = 0;
    this.inFlight = 0;
    this.resolveWaiters();
  }
  async release(): Promise<void> {
    await this.flush();
    if (--this.references > 0) return;
    writers.delete(this.path);
    await this.worker.terminate();
  }
}
