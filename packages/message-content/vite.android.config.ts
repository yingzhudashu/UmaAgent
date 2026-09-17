import { defineConfig } from "vite";
export default defineConfig({
  base: "./",
  build: {
    outDir: "../../android/app/src/main/assets/message",
    emptyOutDir: true,
    rolldownOptions: { input: "android.html" },
  },
});
