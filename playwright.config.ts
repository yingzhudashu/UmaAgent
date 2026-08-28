import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const fauxState = join(tmpdir(), `uma-e2e-${process.pid}`);

export default defineConfig({
  testDir: "apps/web/e2e",
  timeout: 30_000,
  fullyParallel: false,
  use: {
    baseURL: "http://127.0.0.1:33210",
    trace: "retain-on-failure",
    launchOptions: {
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev:faux",
    url: "http://127.0.0.1:33210/api/v15/health/ready",
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      ...process.env,
      NODE_ENV: "test",
      UMA_FAUX_PORT: "33210",
      UMA_FAUX_STATE: fauxState,
      UMA_FAUX_RESET_STATE: "1",
    },
  },
});
