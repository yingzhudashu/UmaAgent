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
    started() {
      started = true;
    },
    stopped() {
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
        connected: started,
        ...(lastInboundAt !== undefined ? { lastInboundAt } : {}),
        ...(lastError ? { lastError } : {}),
      };
    },
  };
}

export type FeishuAdapter = ReturnType<typeof createFeishuAdapter>;
