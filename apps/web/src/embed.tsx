import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UmaClient } from "@uma-agent/client";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

export interface MountUmaAgentOptions {
  coreUrl?: string;
  embedded?: boolean;
  theme?: "light" | "dark";
}

export interface UmaAgentMount {
  unmount(): void;
  setTheme(theme: "light" | "dark"): void;
}

export function mountUmaAgent(target: Element, options: MountUmaAgentOptions = {}): UmaAgentMount {
  if (!(target instanceof Element)) throw new TypeError("UmaAgent mount target must be an Element");
  const coreUrl = options.coreUrl?.trim() || window.location.origin;
  const client = new UmaClient({ baseUrl: coreUrl });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
  });
  const root = createRoot(target);
  let theme = options.theme ?? "light";
  let mounted = true;

  const render = () => {
    root.render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <App client={client} embedded={options.embedded ?? true} theme={theme} />
        </QueryClientProvider>
      </StrictMode>,
    );
  };

  render();
  return {
    setTheme(nextTheme) {
      if (!mounted || nextTheme === theme) return;
      theme = nextTheme;
      render();
    },
    unmount() {
      if (!mounted) return;
      mounted = false;
      client.close();
      queryClient.clear();
      root.unmount();
    },
  };
}
