import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UmaClient } from "@uma-agent/client";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js");

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});
const coreUrl = import.meta.env.VITE_UMA_CORE_URL?.trim() || window.location.origin;
const client = new UmaClient({ baseUrl: coreUrl });
const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
const root = document.getElementById("root");
if (!root) throw new Error("Root element is missing");
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App client={client} theme={dark ? "dark" : "light"} />
    </QueryClientProvider>
  </StrictMode>,
);
