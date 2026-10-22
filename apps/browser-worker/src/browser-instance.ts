import type { Browser } from "playwright";

/** Deduplicate concurrent launches and recover cleanly when the browser exits. */
export function createBrowserInstanceFactory(launch: () => Promise<Browser>) {
  let current: Browser | undefined;
  let pending: Promise<Browser> | undefined;

  return {
    get: async (): Promise<Browser> => {
      if (current?.isConnected()) return current;
      current = undefined;
      if (pending) return pending;

      let attempt: Promise<Browser>;
      attempt = launch()
        .then((instance) => {
          current = instance;
          instance.once("disconnected", () => {
            if (current === instance) current = undefined;
          });
          return instance;
        })
        .finally(() => {
          if (pending === attempt) pending = undefined;
        });
      pending = attempt;
      return attempt;
    },
    isConnected: (): boolean => current?.isConnected() ?? false,
    close: async (): Promise<void> => {
      const instance = current;
      current = undefined;
      await instance?.close();
    },
  };
}
