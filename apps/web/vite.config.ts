import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { port: 3211, proxy: { "/api": { target: "http://127.0.0.1:3210", ws: true } } },
  build: { sourcemap: true },
});
