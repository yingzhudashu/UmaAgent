import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    emptyOutDir: true,
    outDir: "dist-embed",
    sourcemap: true,
    cssCodeSplit: false,
    lib: {
      entry: "src/embed.tsx",
      formats: ["es"],
      fileName: () => "uma-embed.js",
      cssFileName: "uma-embed",
    },
  },
});
