import type { AdapterHealth } from "@uma-agent/protocol";
import type { CoreGateway, FeishuGateway } from "./gateways.js";
import type { AdapterStore } from "./store.js";

export interface AdapterClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export interface FeishuAdapterDependencies {
  core: CoreGateway;
  feishu: FeishuGateway;
  store: AdapterStore;
  clock?: AdapterClock;
  connection?: { start(): Promise<void>; stop(): Promise<void> | void; connected(): boolean };
  onStart?: () => Promise<void> | void;
  onStop?: () => Promise<void> | void;
}

export function createFeishuAdapter(dependencies: FeishuAdapterDependencies) {
  const clock: AdapterClock =
    dependencies.clock ??
    ({
      now: () => Date.now(),
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (timer) => clearTimeout(timer),
    } satisfies AdapterClock);
  let started = false;
  let lastInboundAt: number | undefined;
  let lastError: string | undefined;
  return {
    core: dependencies.core,
    feishu: dependencies.feishu,
    store: dependencies.store,
    clock,
    async start() {
      if (started) return;
      await dependencies.onStart?.();
      await dependencies.connection?.start();
      started = true;
    },
    async stop() {
      if (!started) return;
      await dependencies.connection?.stop();
      await dependencies.onStop?.();
      started = false;
    },
    inbound() {
      lastInboundAt = clock.now();
    },
    failed(error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
    },
    health(): AdapterHealth {
      return {
        status: started ? (lastError ? "degraded" : "ok") : "stopped",
        connected: started && (dependencies.connection?.connected() ?? true),
        ...(lastInboundAt !== undefined ? { lastInboundAt } : {}),
        ...(lastError ? { lastError } : {}),
      };
    },
  };
}

export type FeishuAdapter = ReturnType<typeof createFeishuAdapter>;
